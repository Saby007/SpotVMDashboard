import { Component, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SpotScoreService, StreamEvent } from './services/spot-score.service';
import { DashboardConfig, QuotaInfo, SpotScore } from './models/spot-score.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  config: DashboardConfig | null = null;

  // Form state
  selectedSubscription = '';
  selectedRegion = '';
  selectedFamilies: string[] = [];
  desiredCount = 5;

  // Results
  scores: SpotScore[] = [];
  errors: { batch: string[]; status: number; message: string }[] = [];
  timestamp = '';
  loading = false;
  configLoading = true;

  // View toggle
  activeTab: 'table' | 'heatmap' = 'table';

  // Sort state
  sortColumn = '';
  sortAsc = true;

  // SKU family helpers
  familyKeys: string[] = [];

  // Category & Series filters (no longer support 'All' — always a concrete selection)
  selectedCategory = '';
  selectedSeries = '';

  // API Quota tracking
  quotaInfo: QuotaInfo | null = null;
  private quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // Loading animation
  loadingMessages = [
    { emoji: '🏃', text: 'Racing to grab Spot VMs before someone else does...' },
  ];
  currentLoadingMessage = this.loadingMessages[0];
  private loadingInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;

  // Live progress state
  progressStatus = '';
  progressBatch = 0;
  progressTotal = 0;
  progressPercent = 0;
  retryCountdown = 0;
  scoresReceived = 0;

  constructor(private spotService: SpotScoreService, private zone: NgZone) {}

  protected Math = Math;

  ngOnInit(): void {
    this.spotService.getConfig().subscribe({
      next: (cfg) => {
        this.config = cfg;
        this.familyKeys = Object.keys(cfg.skuFamilies);
        this.desiredCount = cfg.defaultDesiredCount;
        if (cfg.subscriptions.length === 1) {
          this.selectedSubscription = cfg.subscriptions[0].id;
        }
        // Default to centralindia if available
        if (cfg.regions.includes('centralindia')) {
          this.selectedRegion = 'centralindia';
        }
        // Default category + series to the first available (no longer 'All')
        const cats = this.categories;
        if (cats.length > 0) {
          this.selectedCategory = cats[0];
          const series = this.seriesOptions;
          if (series.length > 0) {
            this.selectedSeries = series[0];
          }
          this.selectedFamilies = [...this.filteredFamilyKeys];
        }
        this.configLoading = false;
        // Kick off quota tracking for the default subscription
        if (this.selectedSubscription) {
          this.refreshQuota();
          this.startQuotaAutoRefresh();
        }
      },
      error: (err) => {
        console.error('Failed to load config', err);
        this.configLoading = false;
      }
    });
  }

  /** Distinct categories extracted from family key prefixes */
  get categories(): string[] {
    return [...new Set(this.familyKeys.map(f => {
      const idx = f.indexOf(' - ');
      return idx >= 0 ? f.substring(0, idx) : f;
    }))];
  }

  /** Series options for the currently selected category */
  get seriesOptions(): string[] {
    if (!this.selectedCategory) return [];
    const families = this.familyKeys.filter(f => f.startsWith(this.selectedCategory + ' - ') || f === this.selectedCategory);
    return families.map(f => {
      const idx = f.indexOf(' - ');
      return idx >= 0 ? f.substring(idx + 3) : f;
    });
  }

  /** Family keys filtered by the selected category and series */
  get filteredFamilyKeys(): string[] {
    if (!this.selectedCategory) return [];
    let filtered = this.familyKeys.filter(f => f.startsWith(this.selectedCategory + ' - ') || f === this.selectedCategory);
    if (this.selectedSeries) {
      filtered = filtered.filter(f => {
        const idx = f.indexOf(' - ');
        const series = idx >= 0 ? f.substring(idx + 3) : f;
        return series === this.selectedSeries;
      });
    }
    return filtered;
  }

  onCategoryChange(): void {
    // When category changes, reset series to the first available in the new category
    const series = this.seriesOptions;
    this.selectedSeries = series.length > 0 ? series[0] : '';
    this.selectedFamilies = [...this.filteredFamilyKeys];
  }

  onSeriesChange(): void {
    this.selectedFamilies = [...this.filteredFamilyKeys];
  }

  onSubscriptionChange(): void {
    this.refreshQuota();
  }

  get selectedSkus(): string[] {
    if (!this.config) return [];
    return this.selectedFamilies.flatMap(f => this.config!.skuFamilies[f] || []);
  }

  get canFetch(): boolean {
    return !!this.selectedSubscription && !!this.selectedRegion && this.selectedSkus.length > 0 && !this.loading;
  }



  fetchScores(): void {
    if (!this.canFetch) return;
    this.loading = true;
    this.scores = [];
    this.errors = [];
    this.timestamp = '';
    this.progressStatus = 'Connecting...';
    this.progressBatch = 0;
    this.progressTotal = 0;
    this.progressPercent = 0;
    this.retryCountdown = 0;
    this.scoresReceived = 0;

    this.abortController = this.spotService.streamScores(
      this.selectedSubscription,
      this.selectedRegion,
      this.selectedSkus,
      this.desiredCount,
      (event: StreamEvent) => {
        this.zone.run(() => this.handleStreamEvent(event));
      }
    );
  }

  private handleStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'start':
        this.progressTotal = event.totalBatches || 0;
        this.progressStatus = `Starting — ${event.totalSkus} SKUs in ${event.totalBatches} batches`;
        break;

      case 'batch':
        this.progressBatch = (event.batchIndex || 0) + 1;
        this.progressPercent = Math.round((this.progressBatch / this.progressTotal) * 100);
        this.retryCountdown = 0;
        this.clearCountdown();
        this.progressStatus = `Batch ${this.progressBatch}/${this.progressTotal} — ${(event.skus || []).join(', ')}`;
        break;

      case 'scores':
        this.scoresReceived += event.count || 0;
        if (event.scores) {
          this.scores.push(...event.scores);
        }
        this.progressStatus = `Batch ${this.progressBatch}/${this.progressTotal} — got ${event.count} scores (${this.scoresReceived} total)`;
        break;

      case 'retry':
        this.retryCountdown = event.delaySec || 0;
        this.progressStatus = `⚠ 429 Rate Limited — retry ${event.attempt}/${event.maxRetries} in ${this.retryCountdown}s`;
        this.startCountdown();
        break;

      case 'error':
        this.errors.push({
          batch: event.skus || [],
          status: event.status || 0,
          message: event.message || 'Unknown error'
        });
        this.progressStatus = `❌ Batch ${(event.batchIndex || 0) + 1} failed (${event.status})`;
        break;

      case 'done':
        this.timestamp = event.timestamp || new Date().toISOString();
        this.loading = false;
        this.clearCountdown();
        this.progressStatus = '';
        break;

      case 'fatal':
        this.errors = [{ batch: [], status: 0, message: event.message || 'Request failed' }];
        this.loading = false;
        this.clearCountdown();
        this.progressStatus = '';
        break;

      case 'quota':
        this.quotaInfo = {
          used: event.used ?? 0,
          max: event.max ?? 0,
          remaining: event.remaining ?? 0,
          percentRemaining: event.percentRemaining ?? 0,
          resetsInSec: event.resetsInSec ?? 0
        };
        break;
    }
  }

  private startCountdown(): void {
    this.clearCountdown();
    this.countdownInterval = setInterval(() => {
      this.zone.run(() => {
        this.retryCountdown--;
        if (this.retryCountdown > 0) {
          this.progressStatus = this.progressStatus.replace(/in \d+s/, `in ${this.retryCountdown}s`);
        } else {
          this.progressStatus = `Retrying batch ${this.progressBatch}/${this.progressTotal}...`;
          this.clearCountdown();
        }
      });
    }, 1000);
  }

  private clearCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  stopFetch(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.loading = false;
    this.clearCountdown();
    this.progressStatus = '';
  }

  ngOnDestroy(): void {
    this.stopFetch();
    this.stopQuotaAutoRefresh();
  }

  // --- API quota helpers ---
  refreshQuota(): void {
    if (!this.selectedSubscription) {
      this.quotaInfo = null;
      return;
    }
    this.spotService.getQuota(this.selectedSubscription).subscribe({
      next: (q) => this.zone.run(() => { this.quotaInfo = q; }),
      error: () => {} // silent; quota is non-critical
    });
  }

  private startQuotaAutoRefresh(): void {
    this.stopQuotaAutoRefresh();
    // Refresh every 30s so the user sees the rolling-window reset countdown advance
    this.quotaRefreshTimer = setInterval(() => this.refreshQuota(), 30000);
  }

  private stopQuotaAutoRefresh(): void {
    if (this.quotaRefreshTimer) {
      clearInterval(this.quotaRefreshTimer);
      this.quotaRefreshTimer = null;
    }
  }

  /** CSS class for the quota progress bar based on % remaining */
  quotaClass(): string {
    if (!this.quotaInfo) return 'quota-bar-good';
    const p = this.quotaInfo.percentRemaining;
    if (p >= 50) return 'quota-bar-good';
    if (p >= 20) return 'quota-bar-warn';
    return 'quota-bar-critical';
  }

  /** Friendly "resets in" label, e.g., "43 min" or "7 sec" */
  quotaResetLabel(): string {
    if (!this.quotaInfo) return '';
    const s = this.quotaInfo.resetsInSec;
    if (s >= 60) return `${Math.ceil(s / 60)} min`;
    return `${s} sec`;
  }

  private startLoadingAnimation(): void {}
  private stopLoadingAnimation(): void {}

  // --- Sorting ---
  sortBy(column: string): void {
    if (this.sortColumn === column) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortColumn = column;
      this.sortAsc = true;
    }
  }

  get sortedScores(): SpotScore[] {
    if (!this.sortColumn) return this.scores;
    return [...this.scores].sort((a, b) => {
      const col = this.sortColumn as keyof SpotScore;
      const aVal = a[col];
      const bVal = b[col];
      const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
      return this.sortAsc ? cmp : -cmp;
    });
  }

  // --- Heatmap ---
  get heatmapSkus(): string[] {
    return [...new Set(this.scores.map(s => s.sku))].sort();
  }

  get heatmapZones(): string[] {
    return [...new Set(this.scores.map(s => s.availabilityZone || 'N/A'))].sort();
  }

  getHeatmapScore(sku: string, zone: string): SpotScore | undefined {
    return this.scores.find(s => s.sku === sku && (s.availabilityZone || 'N/A') === zone);
  }

  scoreClass(score: string): string {
    switch (score) {
      case 'High': return 'score-high';
      case 'Medium': return 'score-medium';
      case 'Low': return 'score-low';
      default: return 'score-restricted';
    }
  }

  evictionRate(rate: string): string {
    if (!rate || rate === 'N/A') return 'N/A';
    // Resource Graph returns values like "0-5", "5-10", "10-15", "15-20", "20+"
    if (rate.endsWith('+')) return `${rate}%`;
    return `${rate}%`;
  }

  evictionClass(rate: string): string {
    if (!rate || rate === 'N/A') return 'eviction-na';
    if (rate === '0-5') return 'eviction-low';
    if (rate === '5-10') return 'eviction-medium-low';
    if (rate === '10-15') return 'eviction-medium';
    if (rate === '15-20') return 'eviction-medium-high';
    return 'eviction-high'; // 20+
  }

  scoreNumeric(score: string): number {
    switch (score) {
      case 'High': return 3;
      case 'Medium': return 2;
      case 'Low': return 1;
      default: return 0;
    }
  }

  // --- Summary counts ---
  get highCount(): number { return this.scores.filter(s => s.score === 'High').length; }
  get mediumCount(): number { return this.scores.filter(s => s.score === 'Medium').length; }
  get lowCount(): number { return this.scores.filter(s => s.score === 'Low').length; }
  get restrictedCount(): number { return this.scores.filter(s => s.score === 'RestrictedSkuNotAvailable').length; }
  get noQuotaCount(): number { return this.scores.filter(s => !s.isQuotaAvailable).length; }
}
