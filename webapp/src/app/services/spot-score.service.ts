import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DashboardConfig, QuotaInfo } from '../models/spot-score.model';

export interface StreamEvent {
  type: 'start' | 'batch' | 'scores' | 'retry' | 'error' | 'done' | 'fatal' | 'quota';
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
  used?: number;
  max?: number;
  remaining?: number;
  percentRemaining?: number;
  resetsInSec?: number;
}

@Injectable({ providedIn: 'root' })
export class SpotScoreService {

  constructor(private http: HttpClient) {}

  getConfig(): Observable<DashboardConfig> {
    return this.http.get<DashboardConfig>('/api/config');
  }

  getQuota(subscriptionId: string): Observable<QuotaInfo> {
    return this.http.get<QuotaInfo>(`/api/quota?subscriptionId=${encodeURIComponent(subscriptionId)}`);
  }

  /**
   * Streams score results via NDJSON. Returns an AbortController so caller can cancel.
   */
  streamScores(
    subscriptionId: string,
    region: string,
    skus: string[],
    desiredCount: number,
    onEvent: (event: StreamEvent) => void
  ): AbortController {
    const controller = new AbortController();

    fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId, region, skus, desiredCount }),
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onEvent({ type: 'fatal', message: `HTTP ${response.status}: ${text}` });
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // keep incomplete line in buffer
        for (const line of lines) {
          if (line.trim()) {
            try {
              onEvent(JSON.parse(line));
            } catch { /* skip malformed */ }
          }
        }
      }
      // Process any remaining buffer
      if (buffer.trim()) {
        try { onEvent(JSON.parse(buffer)); } catch { /* skip */ }
      }
    }).catch((err) => {
      if (err.name !== 'AbortError') {
        onEvent({ type: 'fatal', message: err.message || 'Network error' });
      }
    });

    return controller;
  }
}
