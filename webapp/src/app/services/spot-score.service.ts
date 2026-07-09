import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, of } from 'rxjs';
import { DashboardConfig, QuotaInfo, Subscription, UserInfo } from '../models/spot-score.model';
export interface StreamEvent {
  type: 'start' | 'batch' | 'scores' | 'retry' | 'error' | 'done' | 'fatal' | 'quota' | 'vmQuota';
  totalBatches?: number;
  totalSkus?: number;
  batchIndex?: number;
  skus?: string[];
  count?: number;
  scores?: any[];
  attempt?: number;
  maxRetries?: number;
  delaySec?: number;
  status?: number;
  message?: string;
  timestamp?: string;
  // quota event fields
  apiName?: string;
  used?: number;
  max?: number;
  remaining?: number;
  percentRemaining?: number;
  resetsInSec?: number;
  // vmQuota event fields
  region?: string;
  currentValue?: number;
  limit?: number;
  percentUsed?: number;
  unit?: string;
  label?: string;
}

// ----- Static config (moved from server.js) -----
const REGIONS = [
  'centralindia', 'southindia', 'westindia',
  'eastus', 'eastus2', 'westus', 'westus2', 'westus3',
  'centralus', 'northcentralus', 'southcentralus',
  'westeurope', 'northeurope', 'uksouth', 'ukwest',
  'southeastasia', 'eastasia', 'japaneast', 'japanwest',
  'australiaeast', 'australiasoutheast',
  'canadacentral', 'canadaeast', 'brazilsouth',
  'koreacentral', 'koreasouth', 'francecentral',
  'germanywestcentral', 'norwayeast', 'switzerlandnorth',
  'uaenorth', 'southafricanorth', 'swedencentral',
  'qatarcentral', 'polandcentral', 'italynorth', 'israelcentral'
];

const STATIC_SKU_FAMILIES: Record<string, string[]> = {
  'General Purpose - B': [
    'Standard_B2s', 'Standard_B2ms', 'Standard_B4ms', 'Standard_B8ms',
    'Standard_B12ms', 'Standard_B16ms', 'Standard_B20ms'
  ],
  'General Purpose - Dv5': [
    'Standard_D2_v5', 'Standard_D4_v5', 'Standard_D8_v5', 'Standard_D16_v5',
    'Standard_D32_v5', 'Standard_D48_v5', 'Standard_D64_v5', 'Standard_D96_v5'
  ],
  'General Purpose - Dsv5': [
    'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_D16s_v5',
    'Standard_D32s_v5', 'Standard_D48s_v5', 'Standard_D64s_v5', 'Standard_D96s_v5'
  ]
};

const SCORE_API_VERSION = '2025-06-05';
const BATCH_SIZE = 5;
const DEFAULT_DESIRED_COUNT = 5;
const SPOT_API_HOURLY_QUOTA = 100;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

const VM_FAMILY_PREFIXES = ['NC', 'ND', 'NV', 'NP', 'NM', 'NG', 'HB', 'HC', 'HX', 'DC', 'EC', 'FX'];

function parseFamilyCode(familyCode: string): { category: string; series: string } {
  let raw = familyCode
    .replace(/^standard/i, '')
    .replace(/Family$/i, '')
    .replace(/Promo$/i, '');
  if (!raw) return { category: 'General purpose', series: 'Other-series' };

  const upper = raw.toUpperCase();
  let category: string;
  if (upper.startsWith('N')) category = 'GPU';
  else if (upper.startsWith('H')) category = 'High performance compute';
  else if (upper.startsWith('L')) category = 'Storage optimized';
  else if (upper.startsWith('M')) category = 'Memory optimized';
  else if (upper.startsWith('E')) category = 'Memory optimized';
  else if (upper.startsWith('F')) category = 'Compute optimized';
  else category = 'General purpose';

  let prefixLen = 1;
  for (const p of VM_FAMILY_PREFIXES) {
    if (upper.startsWith(p)) { prefixLen = p.length; break; }
  }
  const prefix = raw.substring(0, prefixLen).toUpperCase();
  const rest = raw.substring(prefixLen).toLowerCase();
  return { category, series: prefix + rest + '-series' };
}

interface QuotaEntry { count: number; windowStartMs: number; }

@Injectable({ providedIn: 'root' })
export class SpotScoreService {

  // Per-subscription rolling-window counter (browser-local; mirrors the old server-side tracker).
  private quotaTracker = new Map<string, QuotaEntry>();

  constructor(private http: HttpClient) {}

  // ---- User / hosting identity info ----
  getMe(): Observable<UserInfo> {
    return from(
      fetch('/api/me')
        .then(async r => {
          if (!r.ok) throw new Error(`/api/me ${r.status}`);
          const d = await r.json();
          return { oid: d.oid || '', name: d.name || '', upn: d.upn || '' } as UserInfo;
        })
        .catch(() => ({ oid: '', name: 'App Service identity', upn: '' } as UserInfo))
    );
  }

  // ---- Subscriptions exposed by the server-side Azure identity ----
  getSubscriptions(): Observable<Subscription[]> {
    return this.http.get<Subscription[]>('/api/subscriptions');
  }

  // ---- Dashboard config served by the Node host ----
  getConfig(subscriptionId?: string): Observable<DashboardConfig> {
    const query = subscriptionId ? `?subscriptionId=${encodeURIComponent(subscriptionId)}` : '';
    return this.http.get<DashboardConfig>(`/api/config${query}`);
  }

  // ---- Local quota tracker (rolling 1-hour window per subscription) ----
  getQuota(subscriptionId: string): Observable<QuotaInfo> {
    return of(this.quotaSnapshot(subscriptionId));
  }

  private quotaSnapshot(subscriptionId: string): QuotaInfo {
    const now = Date.now();
    let entry = this.quotaTracker.get(subscriptionId);
    if (!entry || (now - entry.windowStartMs) >= QUOTA_WINDOW_MS) {
      entry = { count: 0, windowStartMs: now };
      this.quotaTracker.set(subscriptionId, entry);
    }
    const used = entry.count;
    const max = SPOT_API_HOURLY_QUOTA;
    const remaining = Math.max(0, max - used);
    const percentRemaining = Math.max(0, Math.min(100, Math.round((remaining / max) * 100)));
    const resetsInSec = Math.max(0, Math.ceil((entry.windowStartMs + QUOTA_WINDOW_MS - now) / 1000));
    return { apiName: 'Spot Placement Score API', used, max, remaining, percentRemaining, resetsInSec };
  }

  private recordApiCall(subscriptionId: string): QuotaInfo {
    this.quotaSnapshot(subscriptionId); // roll window if stale
    const entry = this.quotaTracker.get(subscriptionId)!;
    entry.count += 1;
    return this.quotaSnapshot(subscriptionId);
  }

  // ---- Streaming scores via the Node host ----
  streamScores(
    subscriptionId: string,
    region: string,
    skus: string[],
    desiredCount: number,
    onEvent: (event: StreamEvent) => void
  ): AbortController {
    const controller = new AbortController();
    this.runScoreLoop(subscriptionId, region, skus, desiredCount, onEvent, controller.signal)
      .catch(err => {
        if (err?.name === 'AbortError') return;
        onEvent({ type: 'fatal', message: err?.message || 'Score fetch failed' });
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
    if (!REGIONS.includes(region)) {
      onEvent({ type: 'fatal', message: 'Region not in allowed list' });
      return;
    }

    const count = Math.min(Math.max(desiredCount || DEFAULT_DESIRED_COUNT, 1), 10);
    const totalBatches = Math.ceil(skus.length / BATCH_SIZE);
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 30000;

    const evictionMap = await this.fetchEvictionRates(subscriptionId, region, signal);

    onEvent({ type: 'start', totalBatches, totalSkus: skus.length });
    onEvent({ type: 'quota', ...this.quotaSnapshot(subscriptionId) });

    const vmQuota = await this.fetchSpotVmQuota(subscriptionId, region, signal);
    if (vmQuota) onEvent({ type: 'vmQuota', ...vmQuota });

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
        desiredCount: count,
        desiredSizes: batch.map(sku => ({ sku }))
      };

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal.aborted) return;

        const response = await fetch('/api/placement-scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal
        });

        if (response.ok) {
          const data = await response.json();
          const scores = (data.placementScores || []).map((s: any) => ({
            ...s,
            evictionRate: evictionMap[(s.sku || '').toLowerCase()] || 'N/A'
          }));
          onEvent({ type: 'scores', batchIndex, count: scores.length, scores });
          onEvent({ type: 'quota', ...this.recordApiCall(subscriptionId) });
          break;
        } else if (response.status === 429) {
          let waitSec = 0;
          const retryAfter = response.headers.get('Retry-After');
          if (retryAfter) {
            waitSec = parseInt(retryAfter, 10);
          } else {
            const bodyText = await response.text();
            const match = bodyText.match(/(\d+)\s*seconds/);
            waitSec = match ? parseInt(match[1], 10) : (BASE_DELAY_MS * (attempt + 1)) / 1000;
          }

          if (waitSec > 300) {
            onEvent({ type: 'error', batchIndex, status: 429, message: `Rate limit reached — try again in ${Math.ceil(waitSec / 60)} minutes`, skus: batch });
            onEvent({ type: 'done', timestamp: new Date().toISOString() });
            return;
          }

          if (attempt < MAX_RETRIES) {
            onEvent({ type: 'retry', batchIndex, attempt: attempt + 1, maxRetries: MAX_RETRIES, delaySec: waitSec, skus: batch });
            await this.sleep(waitSec * 1000, signal);
          } else {
            onEvent({ type: 'error', batchIndex, status: 429, message: 'Rate limited after all retries', skus: batch });
          }
        } else {
          const text = await response.text();
          onEvent({ type: 'error', batchIndex, status: response.status, message: text, skus: batch });
          break;
        }
      }

      if (i + BATCH_SIZE < skus.length) {
        await this.sleep(3000, signal);
      }
    }

    onEvent({ type: 'done', timestamp: new Date().toISOString() });
  }

  private async fetchEvictionRates(subscriptionId: string, region: string, signal: AbortSignal): Promise<Record<string, string>> {
    try {
      const url = `/api/eviction-rates?subscriptionId=${encodeURIComponent(subscriptionId)}&region=${encodeURIComponent(region)}`;
      const resp = await fetch(url, { signal });
      if (!resp.ok) {
        console.warn(`Eviction rate query failed: ${resp.status}`);
        return {};
      }
      return await resp.json();
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.warn('Eviction rate fetch error:', err?.message || err);
      return {};
    }
  }

  private async fetchSpotVmQuota(subId: string, region: string, signal: AbortSignal): Promise<any | null> {
    try {
      const url = `/api/vm-quota?subscriptionId=${encodeURIComponent(subId)}&region=${encodeURIComponent(region)}`;
      const resp = await fetch(url, { signal });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.warn('Spot VM quota lookup error:', err?.message || err);
      return null;
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        const err = new Error('Aborted');
        (err as any).name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
