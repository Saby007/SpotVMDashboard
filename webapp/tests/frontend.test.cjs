const { test, before, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { of, Subject } = require('rxjs');

const moduleUrls = new Map();
function typescriptModule(file) {
  if (moduleUrls.has(file)) return moduleUrls.get(file);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, experimentalDecorators: true, useDefineForClassFields: false }
  }).outputText.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier) => {
    const url = specifier.startsWith('.')
      ? typescriptModule(path.resolve(path.dirname(file), `${specifier}.ts`))
      : pathToFileURL(require.resolve(specifier)).href;
    return `from '${url}'`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  moduleUrls.set(file, url);
  return url;
}

let AppComponent;
let SpotScoreService;
const config = {
  regions: ['centralindia', 'eastus'], skuFamilies: { 'General purpose - Dsv5-series': ['Standard_D4s_v5'] },
  regionsFetchedAt: new Date().toISOString(), defaultDesiredCount: 5, maxDesiredCount: 2147483647,
  catalogRegion: 'centralindia', catalogSource: 'azure', catalogFetchedAt: new Date().toISOString(), warnings: []
};
const subscriptionId = '00000000-0000-0000-0000-000000000001';
const row = (overrides = {}) => ({
  sku: 'Standard_D4s_v5', region: 'centralindia', availabilityZone: '1', score: 'High',
  scoreDetail: null, isQuotaAvailable: true, evictionRate: '0-5', ...overrides
});
const quota = {
  region: 'centralindia', currentValue: 92, limit: 100, remaining: 8, percentUsed: 92, percentRemaining: 8,
  unit: 'Count', label: 'Regional Spot vCPUs', fetchedAt: new Date().toISOString()
};

before(async () => {
  await import('@angular/compiler');
  ({ AppComponent } = await import(typescriptModule(path.join(__dirname, '..', 'src', 'app', 'app.component.ts'))));
  ({ SpotScoreService } = await import(typescriptModule(path.join(__dirname, '..', 'src', 'app', 'services', 'spot-score.service.ts'))));
});

afterEach(() => mock.restoreAll());

function component() {
  const streams = [];
  const service = {
    getConfig: (_subscription, region) => of({ ...config, catalogRegion: region || config.catalogRegion }),
    streamScores: (...args) => {
      const controller = new AbortController();
      streams.push({ emit: args[4], controller });
      return controller;
    }
  };
  const app = new AppComponent(service, { run: callback => callback() });
  app.config = config;
  app.configLoading = false;
  app.familyKeys = Object.keys(config.skuFamilies);
  app.selectedFamilies = [...app.familyKeys];
  app.selectedCategory = 'General purpose';
  app.selectedSeries = 'Dsv5-series';
  app.selectedSubscription = subscriptionId;
  app.selectedRegion = config.catalogRegion;
  return { app, service, streams };
}

test('only explicit restrictions map to heatmap zero; stale and new statuses are unknown', () => {
  const { app } = component();
  for (const status of ['Unknown', 'DataNotFoundOrStale', 'FutureAzureStatus']) {
    assert.equal(app.scoreNumeric(status), '?');
    assert.equal(app.scoreClass(status), 'score-unknown');
  }
  assert.equal(app.scoreNumeric('RestrictedSkuNotAvailable'), 0);
  assert.equal(app.scoreClass('RestrictedSkuNotAvailable'), 'score-restricted');
  assert.equal(app.scoreNumeric('High'), 3);
});

test('unknown quota is not counted as insufficient and no fabricated percentage is displayed', () => {
  const { app } = component();
  app.scores = [row(), row({ isQuotaAvailable: false }), row({ isQuotaAvailable: null })];
  assert.equal(app.noQuotaCount, 1);
  assert.equal(app.unknownQuotaCount, 1);
  assert.equal(app.quotaLabel(null), 'Unknown');
  assert.equal(app.quotaLabel(false), 'Insufficient for requested count');
  assert.doesNotMatch(app.quotaLabel(false), /0%/);
});

test('all selection changes clear old results and invalidate late stream events', () => {
  for (const change of ['onRegionChange', 'onSubscriptionChange', 'onCategoryChange', 'onSeriesChange', 'onDesiredCountChange']) {
    const { app, streams } = component();
    app.fetchScores();
    streams[0].emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: new Date().toISOString() });
    streams[0].emit({ type: 'vmQuota', quota });
    assert.equal(app.scores.length, 1);
    app[change]();
    assert.equal(streams[0].controller.signal.aborted, true);
    assert.equal(app.scores.length, 0);
    assert.equal(app.timestamp, '');
    assert.equal(app.vmQuota, null);
    assert.equal(app.resultContext, null);
    streams[0].emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: new Date().toISOString() });
    streams[0].emit({ type: 'vmQuota', quota });
    assert.equal(app.scores.length, 0);
    assert.equal(app.vmQuota, null);
    app.ngOnDestroy();
  }
});

test('newer configuration wins over an older outstanding request', () => {
  const { app, service } = component();
  const oldConfig = new Subject();
  const newConfig = new Subject();
  service.getConfig = (_subscription, region) => !region || region === 'centralindia' ? oldConfig : newConfig;
  app.onSubscriptionChange();
  app.selectedRegion = 'eastus';
  app.onRegionChange();
  newConfig.next({ ...config, catalogRegion: 'eastus' });
  oldConfig.next(config);
  assert.equal(app.config.catalogRegion, 'eastus');
  assert.equal(app.selectedRegion, 'eastus');
  app.ngOnDestroy();
});

test('invalid counts disable fetching rather than being silently changed', () => {
  const { app } = component();
  for (const count of [0, -1, 2147483648, Number.MAX_SAFE_INTEGER + 1, 1.5, null, '5', NaN]) {
    app.desiredCount = count;
    assert.equal(app.canFetch, false);
  }
  for (const count of [1, 11, 100, 2147483647]) {
    app.desiredCount = count;
    assert.equal(app.canFetch, true);
  }
});

test('eviction sorting uses numeric bands and keeps unknown last in either direction', () => {
  const { app } = component();
  app.scores = [null, '5-10', '10-15', '0-5', '20+', '15-20'].map(evictionRate => row({ evictionRate }));
  const original = [...app.scores];
  app.sortBy('evictionRate');
  assert.deepEqual(app.sortedScores.map(score => score.evictionRate), ['0-5', '5-10', '10-15', '15-20', '20+', null]);
  app.sortBy('evictionRate');
  assert.deepEqual(app.sortedScores.map(score => score.evictionRate), ['20+', '15-20', '10-15', '5-10', '0-5', null]);
  assert.deepEqual(app.scores, original);
});

test('placement sorting follows heatmap ranks with unknown/stale last in both directions', () => {
  const { app } = component();
  app.scores = ['Unknown', 'High', 'RestrictedSkuNotAvailable', 'Medium', 'Low', 'DataNotFoundOrStale'].map(score => row({ score }));
  app.sortBy('score');
  assert.deepEqual(app.sortedScores.map(score => score.score), ['RestrictedSkuNotAvailable', 'Low', 'Medium', 'High', 'Unknown', 'DataNotFoundOrStale']);
  app.sortBy('score');
  assert.deepEqual(app.sortedScores.map(score => score.score), ['High', 'Medium', 'Low', 'RestrictedSkuNotAvailable', 'Unknown', 'DataNotFoundOrStale']);
});

test('a started or retrying batch does not count as completed progress', () => {
  const { app, streams } = component();
  app.fetchScores();
  const emit = streams[0].emit;
  emit({ type: 'start', totalBatches: 2, totalSkus: 6 });
  emit({ type: 'batch', batchIndex: 0, totalBatches: 2, skus: ['Standard_D4s_v5'] });
  assert.equal(app.progressPercent, 0);
  assert.equal(app.scoresReceived, 0);
  emit({ type: 'retry', attempt: 1, maxRetries: 3, delaySec: 30 });
  assert.equal(app.progressPercent, 0);
  emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: new Date().toISOString() });
  assert.equal(app.progressPercent, 50);
  emit({ type: 'batch', batchIndex: 1, totalBatches: 2, skus: ['Standard_D8s_v5'] });
  assert.equal(app.progressPercent, 50);
  emit({ type: 'error', batchIndex: 1, status: 503, message: 'Unavailable', skus: ['Standard_D8s_v5'] });
  assert.equal(app.progressPercent, 100);
  emit({ type: 'done' });
  assert.ok(app.warnings.some(warning => /incomplete/.test(warning)));
  app.ngOnDestroy();
});

test('one-batch progress stays below 100% until its response arrives', () => {
  const { app, streams } = component();
  app.fetchScores();
  const emit = streams[0].emit;
  emit({ type: 'start', totalBatches: 1, totalSkus: 1 });
  emit({ type: 'batch', batchIndex: 0, totalBatches: 1, skus: ['Standard_D4s_v5'] });
  assert.equal(app.progressPercent, 0);
  assert.equal(app.loading, true);
  emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: new Date().toISOString() });
  assert.equal(app.progressPercent, 100);
  app.ngOnDestroy();
});

test('configuration failure clears selectable sizes and disables scoring', () => {
  const { app, service } = component();
  const failing = new Subject();
  service.getConfig = () => failing;
  mock.method(console, 'error', () => {});
  app.onRegionChange();
  failing.error(new Error('Azure discovery unavailable'));
  assert.equal(app.selectedSkus.length, 0);
  assert.equal(app.canFetch, false);
  assert.match(app.configError, /No unverified sizes/);
  app.ngOnDestroy();
});

test('an old static-fallback response cannot re-enable scoring', () => {
  const { app, service } = component();
  service.getConfig = () => of({ ...config, catalogSource: 'static' });
  app.onRegionChange();
  assert.equal(app.selectedSkus.length, 0);
  assert.equal(app.canFetch, false);
  assert.match(app.configError, /Verified Azure discovery/);
});

test('missing count metadata is an explicit configuration error, not a guessed limit', () => {
  const { app, service } = component();
  service.getConfig = () => of({ ...config, maxDesiredCount: undefined });
  app.onRegionChange();
  assert.equal(app.canFetch, false);
  assert.equal(app.selectedSkus.length, 0);
  assert.match(app.configError, /valid count limits/);
});

test('no subscriptions means no unverified configuration lookup', () => {
  const { app, service } = component();
  let configCalls = 0;
  service.getMe = () => of({ oid: '', name: 'Test identity', upn: '' });
  service.getSubscriptions = () => of([]);
  service.getConfig = () => { configCalls++; return of(config); };
  app.retrySetup();
  assert.equal(configCalls, 0);
  assert.equal(app.canFetch, false);
  assert.equal(app.config, null);
  assert.match(app.configError, /No Azure subscriptions/);
  app.ngOnDestroy();
});

test('initial configuration selects its region from the verified server response', () => {
  const { app } = component();
  app.selectedRegion = '';
  app.onSubscriptionChange();
  assert.equal(app.selectedRegion, 'centralindia');
  assert.equal(app.canFetch, true);
});

test('configuration requests do not hard-code a region in the client', () => {
  let requestedUrl;
  const service = new SpotScoreService({ get: url => { requestedUrl = url; return of(config); } });
  service.getConfig(subscriptionId);
  const url = new URL(requestedUrl, 'https://example.invalid');
  assert.equal(url.searchParams.get('subscriptionId'), subscriptionId);
  assert.equal(url.searchParams.has('region'), false);
  service.getConfig(subscriptionId, 'spaincentral');
  assert.equal(new URL(requestedUrl, 'https://example.invalid').searchParams.get('region'), 'spaincentral');
});

test('snapshot age warning uses the oldest batch, not completion time', () => {
  const { app, streams } = component();
  const first = '2026-10-22T06:00:00.000Z';
  app.fetchScores();
  streams[0].emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: first });
  streams[0].emit({ type: 'scores', batchIndex: 1, scores: [row({ availabilityZone: '2' })], timestamp: '2026-10-22T06:05:00.000Z' });
  streams[0].emit({ type: 'done' });
  assert.equal(app.timestamp, first);
  app.now = Date.parse(first) + 15 * 60 * 1000 - 1;
  assert.equal(app.isSnapshotOld, false);
  app.now += 1;
  assert.equal(app.isSnapshotOld, true);
});

test('stopping preserves partial results with an explicit completeness warning', () => {
  const { app, streams } = component();
  app.fetchScores();
  streams[0].emit({ type: 'scores', batchIndex: 0, scores: [row()], timestamp: new Date().toISOString() });
  app.stopFetch();
  assert.equal(app.scores.length, 1);
  assert.equal(app.loading, false);
  assert.ok(app.warnings.some(warning => /incomplete/.test(warning)));
  streams[0].emit({ type: 'done' });
  assert.equal(app.loading, false);
});

test('missing selected SKUs retain no-result heatmap rows rather than restricted cells', () => {
  const { app } = component();
  app.config = { ...config, skuFamilies: { 'General purpose - Dsv5-series': ['Standard_D4s_v5', 'Standard_D8s_v5'] } };
  app.scores = [row()];
  assert.ok(app.heatmapSkus.includes('Standard_D8s_v5'));
  assert.equal(app.getHeatmapScore('Standard_D8s_v5', '1'), undefined);
  assert.match(app.heatmapTooltip('Standard_D8s_v5', '1'), /not an availability restriction/);
});

test('case-insensitive SKU matching does not duplicate heatmap rows', () => {
  const { app } = component();
  app.scores = [row({ sku: 'standard_d4s_v5' })];
  assert.deepEqual(app.heatmapSkus, ['Standard_D4s_v5']);
  assert.equal(app.getHeatmapScore('Standard_D4s_v5', '1').score, 'High');
});

async function runService(responder, count = 5) {
  const events = [];
  mock.method(globalThis, 'fetch', responder);
  const service = new SpotScoreService({});
  await new Promise(resolve => {
    service.streamScores(subscriptionId, 'centralindia', ['Standard_D4s_v5'], count, event => {
      events.push(event);
      if (event.type === 'done' || event.type === 'fatal') resolve();
    });
  });
  return events;
}

test('optional data failures are visible and do not imply zero eviction risk or quota', async () => {
  mock.method(console, 'warn', () => {});
  const events = await runService(async url => String(url).includes('placement-scores')
    ? new Response(JSON.stringify({ placementScores: [row({ isQuotaAvailable: null })], warnings: [], fetchedAt: new Date().toISOString() }))
    : new Response(JSON.stringify({ error: 'Unavailable upstream' }), { status: 503 }));
  assert.equal(events.filter(event => event.type === 'warning').length, 2);
  assert.equal(events.some(event => event.type === 'vmQuota'), false);
  const scores = events.find(event => event.type === 'scores').scores;
  assert.equal(scores[0].evictionRate, null);
  assert.equal(scores[0].isQuotaAvailable, null);
  assert.equal(events.at(-1).type, 'done');
});

test('zero regional quota conflicting with sufficient API quota produces a warning', async () => {
  const events = await runService(async url => {
    const body = String(url).includes('eviction-rates') ? { rates: { standard_d4s_v5: '0-5' } }
      : String(url).includes('vm-quota') ? { ...quota, limit: 0, currentValue: 0, remaining: 0, percentRemaining: 0 }
        : { placementScores: [row()], warnings: [], fetchedAt: new Date().toISOString() };
    return new Response(JSON.stringify(body));
  });
  assert.ok(events.some(event => event.type === 'warning' && /signals disagree/.test(event.message)));
});

test('long rate-limit cooldown ends with an explicit incomplete batch error', async () => {
  const events = await runService(async url => {
    if (String(url).includes('placement-scores')) return new Response('Rate limit', { status: 429, headers: { 'Retry-After': '600' } });
    return new Response(JSON.stringify(String(url).includes('vm-quota') ? quota : { rates: {} }));
  });
  assert.ok(events.some(event => event.type === 'error' && event.status === 429 && /10 minutes/.test(event.message)));
  assert.equal(events.at(-1).type, 'done');
});

test('service rejects invalid count without calling the API', async () => {
  let calls = 0;
  const events = await runService(async () => { calls++; throw new Error('Unexpected call'); }, 1.5);
  assert.equal(calls, 0);
  assert.equal(events.at(-1).type, 'fatal');
});

test('service sends counts above ten without silently reducing them', async () => {
  let sentCount;
  const events = await runService(async (url, options) => {
    if (String(url).includes('placement-scores')) {
      sentCount = JSON.parse(options.body).desiredCount;
      return new Response(JSON.stringify({ placementScores: [row()], warnings: [], fetchedAt: new Date().toISOString() }));
    }
    return new Response(JSON.stringify(String(url).includes('vm-quota') ? quota : { rates: { standard_d4s_v5: '0-5' } }));
  }, 100);
  assert.equal(sentCount, 100);
  assert.equal(events.at(-1).type, 'done');
});
