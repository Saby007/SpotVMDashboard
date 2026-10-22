import { Component, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription as RxSubscription, takeUntil } from 'rxjs';
import { SpotScoreService, StreamEvent } from './services/spot-score.service';
import { DashboardConfig, EvictionRate, SpotScore, Subscription, UserInfo, VmQuotaInfo } from './models/spot-score.model';
import { DEV_MODE } from './auth.config';

const SNAPSHOT_AGE_WARNING_MS = 15 * 60 * 1000;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  config: DashboardConfig | null = null;
  subscriptions: Subscription[] = [];
  user: UserInfo | null = null;
  private destroy$ = new Subject<void>();
  private configRequest: RxSubscription | null = null;
  private requestId = 0;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;

  selectedSubscription = '';
  selectedRegion = 'centralindia';
  selectedFamilies: string[] = [];
  desiredCount = 5;
  selectedCategory = '';
  selectedSeries = '';
  familyKeys: string[] = [];

  scores: SpotScore[] = [];
  errors: { batch: string[]; status: number; message: string }[] = [];
  warnings: string[] = [];
  configWarnings: string[] = [];
  configError = '';
  timestamp = '';
  now = Date.now();
  loading = false;
  configLoading = true;
  resultContext: { subscriptionName: string; subscriptionId: string; region: string; desiredCount: number } | null = null;
  vmQuota: VmQuotaInfo | null = null;
  activeTab: 'table' | 'heatmap' = 'table';
  sortColumn: keyof SpotScore | '' = '';
  sortAsc = true;

  private abortController: AbortController | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  progressStatus = '';
  progressBatch = 0;
  progressTotal = 0;
  progressPercent = 0;
  retryCountdown = 0;
  scoresReceived = 0;

  constructor(private spotService: SpotScoreService, private zone: NgZone) {}

  protected devMode = DEV_MODE;

  ngOnInit(): void {
    this.retrySetup();
    this.freshnessTimer = setInterval(() => this.zone.run(() => { this.now = Date.now(); }), 30000);
  }

  retrySetup(): void {
    this.resetResults();
    this.configRequest?.unsubscribe();
    this.configLoading = true;
    this.configError = '';
    this.spotService.getMe().pipe(takeUntil(this.destroy$)).subscribe({
      next: user => this.zone.run(() => { this.user = user; }),
      error: (error: unknown) => {
        console.warn('Failed to read hosting identity', error);
        this.zone.run(() => this.addWarning('Hosting identity information could not be loaded.'));
      }
    });
    this.spotService.getSubscriptions().pipe(takeUntil(this.destroy$)).subscribe({
      next: subscriptions => this.zone.run(() => {
        this.subscriptions = subscriptions;
        if (!subscriptions.some(subscription => subscription.id === this.selectedSubscription)) {
          this.selectedSubscription = subscriptions[0]?.id || '';
        }
        this.loadConfig();
      }),
      error: (error: unknown) => this.zone.run(() => {
        console.error('Failed to load subscriptions', error);
        this.configError = 'Azure subscriptions could not be loaded. Check the host identity permissions and retry.';
        this.configLoading = false;
      })
    });
  }

  private loadConfig(): void {
    this.configRequest?.unsubscribe();
    this.configLoading = true;
    this.configError = '';
    this.configWarnings = [];
    this.familyKeys = [];
    this.selectedFamilies = [];
    this.configRequest = this.spotService.getConfig(this.selectedSubscription || undefined, this.selectedRegion)
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: config => this.zone.run(() => {
          if (config.catalogRegion !== this.selectedRegion) {
            this.configError = 'The SKU catalogue does not match the selected region. Retry configuration.';
            this.configLoading = false;
            return;
          }
          if (!this.config) this.desiredCount = config.defaultDesiredCount;
          this.config = config;
          this.configWarnings = config.warnings;
          this.familyKeys = Object.keys(config.skuFamilies);
          if (!this.categories.includes(this.selectedCategory)) this.selectedCategory = this.categories[0] || '';
          if (!this.seriesOptions.includes(this.selectedSeries)) this.selectedSeries = this.seriesOptions[0] || '';
          this.selectedFamilies = [...this.filteredFamilyKeys];
          this.configLoading = false;
        }),
        error: (error: unknown) => this.zone.run(() => {
          console.error('Failed to load configuration', error);
          this.configError = 'The VM catalogue could not be loaded. Retry configuration.';
          this.configLoading = false;
        })
      });
  }

  get categories(): string[] {
    return [...new Set(this.familyKeys.map(family => family.split(' - ')[0]))];
  }

  get seriesOptions(): string[] {
    if (!this.selectedCategory) return [];
    return this.familyKeys
      .filter(family => family.startsWith(this.selectedCategory + ' - ') || family === this.selectedCategory)
      .map(family => family.includes(' - ') ? family.substring(family.indexOf(' - ') + 3) : family);
  }

  get filteredFamilyKeys(): string[] {
    if (!this.selectedCategory) return [];
    return this.familyKeys.filter(family => {
      const separator = family.indexOf(' - ');
      const category = separator >= 0 ? family.substring(0, separator) : family;
      const series = separator >= 0 ? family.substring(separator + 3) : family;
      return category === this.selectedCategory && (!this.selectedSeries || series === this.selectedSeries);
    });
  }

  onCategoryChange(): void {
    this.resetResults();
    this.selectedSeries = this.seriesOptions[0] || '';
    this.selectedFamilies = [...this.filteredFamilyKeys];
  }

  onSeriesChange(): void {
    this.resetResults();
    this.selectedFamilies = [...this.filteredFamilyKeys];
  }

  onSubscriptionChange(): void {
    this.resetResults();
    this.loadConfig();
  }

  onRegionChange(): void {
    this.resetResults();
    this.loadConfig();
  }

  onDesiredCountChange(): void {
    this.resetResults();
  }

  get selectedSkus(): string[] {
    const config = this.config;
    return config ? [...new Set(this.selectedFamilies.flatMap(family => config.skuFamilies[family] || []))] : [];
  }

  get validDesiredCount(): boolean {
    return Number.isInteger(this.desiredCount) && this.desiredCount >= 1 && this.desiredCount <= 10;
  }

  get canFetch(): boolean {
    return !!this.selectedSubscription && this.config?.catalogRegion === this.selectedRegion
      && this.selectedSkus.length > 0 && this.validDesiredCount && !this.loading && !this.configLoading && !this.configError;
  }

  fetchScores(): void {
    if (!this.canFetch) return;
    this.resetResults();
    this.loading = true;
    this.resultContext = {
      subscriptionName: this.subscriptions.find(subscription => subscription.id === this.selectedSubscription)?.name || this.selectedSubscription,
      subscriptionId: this.selectedSubscription,
      region: this.selectedRegion,
      desiredCount: this.desiredCount
    };
    this.progressStatus = 'Reading eviction history and regional Spot quota...';
    const requestId = this.requestId;
    this.abortController = this.spotService.streamScores(
      this.selectedSubscription, this.selectedRegion, this.selectedSkus, this.desiredCount,
      event => {
        if (requestId !== this.requestId) return;
        this.zone.run(() => this.handleStreamEvent(event));
      }
    );
  }

  private handleStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'start':
        this.progressTotal = event.totalBatches;
        break;
      case 'batch':
        this.progressBatch = event.batchIndex + 1;
        this.progressPercent = Math.round((this.progressBatch / this.progressTotal) * 100);
        this.retryCountdown = 0;
        this.clearCountdown();
        this.progressStatus = `Batch ${this.progressBatch}/${this.progressTotal} - ${event.skus.join(', ')}`;
        break;
      case 'scores':
        this.scoresReceived += event.scores.length;
        this.scores.push(...event.scores);
        if (!this.timestamp || event.timestamp < this.timestamp) this.timestamp = event.timestamp;
        this.now = Date.now();
        this.progressStatus = `Batch ${this.progressBatch}/${this.progressTotal} - got ${event.scores.length} scores (${this.scoresReceived} total)`;
        break;
      case 'retry':
        this.retryCountdown = event.delaySec;
        this.progressStatus = `429 Rate Limited - retry ${event.attempt}/${event.maxRetries} in ${this.retryCountdown}s`;
        this.startCountdown();
        break;
      case 'error':
        this.errors.push({ batch: event.skus, status: event.status, message: event.message });
        this.progressStatus = `Batch ${event.batchIndex + 1} failed (${event.status})`;
        break;
      case 'done':
        this.loading = false;
        this.abortController = null;
        this.clearCountdown();
        this.progressStatus = '';
        if (this.errors.length) this.addWarning('Some batches failed. Displayed results are incomplete.');
        break;
      case 'fatal':
        this.errors.push({ batch: [], status: 0, message: event.message });
        this.loading = false;
        this.abortController = null;
        this.clearCountdown();
        this.progressStatus = '';
        if (this.scores.length) this.addWarning('Fetching failed. Displayed results are incomplete.');
        break;
      case 'warning':
        this.addWarning(event.message);
        break;
      case 'vmQuota':
        this.vmQuota = event.quota;
        break;
    }
  }

  private addWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private resetResults(): void {
    this.cancelFetch();
    this.scores = [];
    this.errors = [];
    this.warnings = [];
    this.timestamp = '';
    this.vmQuota = null;
    this.resultContext = null;
    this.progressBatch = 0;
    this.progressTotal = 0;
    this.progressPercent = 0;
    this.retryCountdown = 0;
    this.scoresReceived = 0;
  }

  private cancelFetch(): void {
    this.requestId++;
    this.abortController?.abort();
    this.abortController = null;
    this.loading = false;
    this.clearCountdown();
    this.progressStatus = '';
  }

  stopFetch(): void {
    if (!this.loading) return;
    this.cancelFetch();
    this.addWarning('Fetching was stopped. Displayed results may be incomplete.');
  }

  private startCountdown(): void {
    this.clearCountdown();
    this.countdownInterval = setInterval(() => this.zone.run(() => {
      this.retryCountdown = Math.max(0, this.retryCountdown - 1);
      if (this.retryCountdown > 0) this.progressStatus = this.progressStatus.replace(/in \d+s/, `in ${this.retryCountdown}s`);
      else {
        this.progressStatus = `Retrying batch ${this.progressBatch}/${this.progressTotal}...`;
        this.clearCountdown();
      }
    }), 1000);
  }

  private clearCountdown(): void {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = null;
  }

  ngOnDestroy(): void {
    this.cancelFetch();
    this.configRequest?.unsubscribe();
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }

  get isSnapshotOld(): boolean {
    return !!this.timestamp && this.now - Date.parse(this.timestamp) >= SNAPSHOT_AGE_WARNING_MS;
  }

  sortBy(column: keyof SpotScore): void {
    this.sortAsc = this.sortColumn === column ? !this.sortAsc : true;
    this.sortColumn = column;
  }

  get sortedScores(): SpotScore[] {
    const column = this.sortColumn;
    if (!column) return this.scores;
    return [...this.scores].sort((a, b) => {
      const comparison = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
      return this.sortAsc ? comparison : -comparison;
    });
  }

  get heatmapSkus(): string[] {
    const names = new Map(this.scores.map(score => [score.sku.toLowerCase(), score.sku]));
    for (const sku of this.selectedSkus) names.set(sku.toLowerCase(), sku);
    return [...names.values()].sort();
  }

  get heatmapZones(): string[] {
    return [...new Set(this.scores.map(score => score.availabilityZone || 'Regional'))].sort();
  }

  getHeatmapScore(sku: string, zone: string): SpotScore | undefined {
    return this.scores.find(score => score.sku.toLowerCase() === sku.toLowerCase() && (score.availabilityZone || 'Regional') === zone);
  }

  heatmapTooltip(sku: string, zone: string): string {
    const score = this.getHeatmapScore(sku, zone);
    return score
      ? `${this.scoreLabel(score.score)}. ${score.scoreDetail || ''} Quota: ${this.quotaLabel(score.isQuotaAvailable)}. Regional eviction history: ${this.evictionRate(score.evictionRate)}.`
      : 'No placement data returned. This is not an availability restriction.';
  }

  scoreClass(score: string): string {
    switch (score) {
      case 'High': return 'score-high';
      case 'Medium': return 'score-medium';
      case 'Low': return 'score-low';
      case 'RestrictedSkuNotAvailable': return 'score-restricted';
      default: return 'score-unknown';
    }
  }

  scoreLabel(score: string): string {
    switch (score) {
      case 'RestrictedSkuNotAvailable': return 'Restricted SKU';
      case 'DataNotFoundOrStale': return 'Data missing/stale';
      case 'High': case 'Medium': case 'Low': return score;
      default: return 'Unknown';
    }
  }

  scoreNumeric(score: string): number | '?' {
    switch (score) {
      case 'High': return 3;
      case 'Medium': return 2;
      case 'Low': return 1;
      case 'RestrictedSkuNotAvailable': return 0;
      default: return '?';
    }
  }

  quotaLabel(available: boolean | null): string {
    return available === true ? 'Sufficient (API)' : available === false ? 'Insufficient for requested count' : 'Unknown';
  }

  evictionRate(rate: EvictionRate | null): string {
    return rate === null ? 'Unknown' : rate === '20+' ? '20%+' : `${rate}%`;
  }

  evictionClass(rate: EvictionRate | null): string {
    switch (rate) {
      case '0-5': return 'eviction-low';
      case '5-10': return 'eviction-medium-low';
      case '10-15': return 'eviction-medium';
      case '15-20': return 'eviction-medium-high';
      case '20+': return 'eviction-high';
      default: return 'eviction-na';
    }
  }

  get highCount(): number { return this.scores.filter(score => score.score === 'High').length; }
  get mediumCount(): number { return this.scores.filter(score => score.score === 'Medium').length; }
  get lowCount(): number { return this.scores.filter(score => score.score === 'Low').length; }
  get restrictedCount(): number { return this.scores.filter(score => score.score === 'RestrictedSkuNotAvailable').length; }
  get unknownCount(): number { return this.scores.filter(score => score.score === 'Unknown' || score.score === 'DataNotFoundOrStale').length; }
  get noQuotaCount(): number { return this.scores.filter(score => score.isQuotaAvailable === false).length; }
  get unknownQuotaCount(): number { return this.scores.filter(score => score.isQuotaAvailable === null).length; }
}
