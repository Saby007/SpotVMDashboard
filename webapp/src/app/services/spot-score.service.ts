import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { DashboardConfig, EvictionRatesResponse, PlacementScoreResponse, SpotScore, Subscription, UserInfo, VmQuotaInfo } from '../models/spot-score.model';

export type StreamEvent =
  | { type: 'start'; totalBatches: number; totalSkus: number }
  | { type: 'batch'; batchIndex: number; totalBatches: number; skus: string[] }
  | { type: 'scores'; batchIndex: number; scores: SpotScore[]; timestamp: string }
  | { type: 'retry'; attempt: number; maxRetries: number; delaySec: number }
  | { type: 'error'; batchIndex: number; status: number; message: string; skus: string[] }
  | { type: 'done' }
  | { type: 'fatal' | 'warning'; message: string }
  | { type: 'vmQuota'; quota: VmQuotaInfo };

const BATCH_SIZE = 5;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable({ providedIn: 'root' })
export class SpotScoreService {
  constructor(private http: HttpClient) {}

  getMe(): Observable<UserInfo> {
    return from(this.fetchJson<UserInfo>('/api/me'));
  }

  getSubscriptions(): Observable<Subscription[]> {
    return this.http.get<Subscription[]>('/api/subscriptions');
  }

  getConfig(subscriptionId: string, region?: string): Observable<DashboardConfig> {
    const query = new URLSearchParams({ subscriptionId });
    if (region) query.set('region', region);
    return this.http.get<DashboardConfig>(`/api/config?${query}`);
  }

  streamScores(
    subscriptionId: string,
    region: string,
    skus: string[],
    desiredCount: number,
    onEvent: (event: StreamEvent) => void
  ): AbortController {
    const controller = new AbortController();
    this.runScoreLoop(subscriptionId, region, skus, desiredCount, onEvent, controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        onEvent({ type: 'fatal', message: errorMessage(error) });
      });
    return controller;
  }

  private async runScoreLoop(
    subscriptionId: string,
    region: string,
    skus: string[],
    desiredCount: number,
    onEvent: (event: StreamEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    if (!subscriptionId || !region || skus.length === 0) {
      throw new Error('Select a subscription, region, and at least one VM size.');
    }
    if (!Number.isSafeInteger(desiredCount) || desiredCount < 1) {
      throw new Error('Desired count must be a positive whole number.');
    }

    const totalBatches = Math.ceil(skus.length / BATCH_SIZE);
    const maxRetries = 3;
    onEvent({ type: 'start', totalBatches, totalSkus: skus.length });
    const evictionHistory = await this.fetchEvictionRates(subscriptionId, region, signal, onEvent);
    const vmQuota = await this.fetchSpotVmQuota(subscriptionId, region, signal, onEvent);
    if (signal.aborted) return;
    if (vmQuota) onEvent({ type: 'vmQuota', quota: vmQuota });
    if (evictionHistory) {
      const missing = skus.filter(sku => !evictionHistory.rates[sku.toLowerCase()]);
      if (missing.length) onEvent({ type: 'warning', message: `Eviction history is unknown for ${missing.length} selected SKU(s): ${missing.join(', ')}. Missing data is not zero risk.` });
    }

    for (let i = 0; i < skus.length; i += BATCH_SIZE) {
      if (signal.aborted) return;
      const batchIndex = Math.floor(i / BATCH_SIZE);
      const batch = skus.slice(i, i + BATCH_SIZE);
      onEvent({ type: 'batch', batchIndex, totalBatches, skus: batch });
      const payload = {
        subscriptionId,
        region,
        availabilityZones: true,
        desiredLocations: [region],
        desiredCount,
        desiredSizes: batch.map(sku => ({ sku }))
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch('/api/placement-scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal
        });
        if (signal.aborted) return;
        if (response.ok) {
          const data: PlacementScoreResponse = await response.json();
          const scores = data.placementScores.map(score => ({
            ...score,
            evictionRate: evictionHistory?.rates[score.sku.toLowerCase()] ?? null
          }));
          for (const message of data.warnings) onEvent({ type: 'warning', message });
          if (vmQuota?.remaining === 0 && scores.some(score => score.isQuotaAvailable === true)) {
            onEvent({ type: 'warning', message: 'Quota signals disagree: the regional pool has no remaining vCPUs, but the placement API reports sufficient quota. Refresh and verify quota in Azure before deploying.' });
          }
          onEvent({ type: 'scores', batchIndex, scores, timestamp: data.fetchedAt });
          break;
        }

        const message = await this.responseError(response);
        if (response.status !== 429) {
          onEvent({ type: 'error', batchIndex, status: response.status, message, skus: batch });
          break;
        }
        const retryAfter = response.headers.get('Retry-After');
        let waitSec = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)
          ? Math.ceil(Number(retryAfter))
          : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : NaN;
        if (!Number.isFinite(waitSec) || waitSec < 0) {
          const match = message.match(/(\d+)\s*seconds/);
          waitSec = match ? Number(match[1]) : 30 * (attempt + 1);
        }
        if (waitSec > 300 || attempt === maxRetries) {
          onEvent({ type: 'error', batchIndex, status: 429, message: waitSec > 300 ? `Rate limit reached. Try again in ${Math.ceil(waitSec / 60)} minutes.` : 'Rate limited after all retries.', skus: batch });
          if (waitSec > 300) {
            onEvent({ type: 'done' });
            return;
          }
        } else {
          onEvent({ type: 'retry', attempt: attempt + 1, maxRetries, delaySec: waitSec });
          await this.sleep(waitSec * 1000, signal);
        }
      }
      if (i + BATCH_SIZE < skus.length) await this.sleep(3000, signal);
    }
    if (!signal.aborted) onEvent({ type: 'done' });
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(await this.responseError(response));
    return response.json();
  }

  private async responseError(response: Response): Promise<string> {
    const text = await response.text();
    let detail = text;
    try {
      const body: unknown = JSON.parse(text);
      if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') detail = body.error;
    } catch {
      // ARM can return plain-text error details.
    }
    return `HTTP ${response.status}: ${detail || response.statusText}`;
  }

  private async fetchEvictionRates(subscriptionId: string, region: string, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<EvictionRatesResponse | null> {
    try {
      return await this.fetchJson<EvictionRatesResponse>(`/api/eviction-rates?subscriptionId=${encodeURIComponent(subscriptionId)}&region=${encodeURIComponent(region)}`, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      const message = `Eviction history could not be loaded and is shown as unknown. ${errorMessage(error)}`;
      console.warn(message);
      onEvent({ type: 'warning', message });
      return null;
    }
  }

  private async fetchSpotVmQuota(subscriptionId: string, region: string, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<VmQuotaInfo | null> {
    try {
      return await this.fetchJson<VmQuotaInfo>(`/api/vm-quota?subscriptionId=${encodeURIComponent(subscriptionId)}&region=${encodeURIComponent(region)}`, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      const message = `Regional Spot vCPU quota could not be loaded and is unknown. ${errorMessage(error)}`;
      console.warn(message);
      onEvent({ type: 'warning', message });
      return null;
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
