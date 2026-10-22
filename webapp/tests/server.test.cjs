const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const realFetch = globalThis.fetch;
const subscriptionId = '00000000-0000-0000-0000-000000000001';
const region = 'centralindia';
const sku = 'Standard_D4s_v5';
const identityEndpoint = 'http://identity.test/token';
let server;
let origin;
let azureCalls;
let upstream;
let discoveryCalls;
let discoveryUpstream;
let catalogId = 10;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const input = (overrides = {}) => ({
  subscriptionId, region, desiredCount: 5, desiredSizes: [{ sku }], availabilityZones: true, ...overrides
});
const score = (overrides = {}) => ({ sku, region, availabilityZone: '1', score: 'High', isQuotaAvailable: true, ...overrides });
const catalogSku = (name, overrides = {}) => ({
  name, resourceType: 'virtualMachines', family: 'standardDSv5Family', locations: [region],
  capabilities: [{ name: 'LowPriorityCapable', value: 'True' }], restrictions: [], ...overrides
});
const catalogQuery = (id = `00000000-0000-0000-0000-${String(catalogId++).padStart(12, '0')}`, location = region) =>
  `/api/config?subscriptionId=${id}&region=${location}`;
const locationRows = [
  { name: region, displayName: 'Central India', metadata: { regionType: 'Physical' } },
  { name: 'eastus', displayName: 'East US', metadata: { regionType: 'Physical' } },
  { name: 'spaincentral', displayName: 'Spain Central', metadata: { regionType: 'Physical' } },
  { name: 'futureregion1', displayName: 'Future Region', metadata: { regionType: 'Physical' } },
  { name: 'unsupportedregion', displayName: 'No VM Provider', metadata: { regionType: 'Physical' } },
  { name: 'global', displayName: 'Global', metadata: { regionType: 'Logical' } }
];
const providerMetadata = { resourceTypes: [{
  resourceType: 'virtualMachines', locations: ['Central India', 'East US', 'Spain Central', 'Future Region']
}] };
const discoveryResponse = async call => call.url.includes('/locations?')
  ? json({ value: locationRows }) : json(providerMetadata);
const isDiscovery = url => /\/subscriptions\/[^/]+\/locations\?/.test(url) || /\/providers\/Microsoft\.Compute\?/.test(url);

async function request(route, body) {
  return realFetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

before(async () => {
  process.env.LOCAL_DEV = '0';
  process.env.IDENTITY_ENDPOINT = identityEndpoint;
  process.env.IDENTITY_HEADER = 'test-only-header';
  process.env.DEFAULT_REGION = region;
  const app = require('../server');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  azureCalls = [];
  discoveryCalls = [];
  discoveryUpstream = discoveryResponse;
  upstream = async () => { throw new Error('Unexpected Azure request'); };
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith(identityEndpoint)) {
      return json({ access_token: 'test-only-token', expires_on: Math.floor(Date.now() / 1000) + 3600 });
    }
    assert.ok(String(url).startsWith('https://management.azure.com/'));
    const call = { url: String(url), body: options?.body ? JSON.parse(options.body) : undefined };
    if (isDiscovery(call.url)) {
      discoveryCalls.push(call);
      return discoveryUpstream(call);
    }
    azureCalls.push(call);
    return upstream(call);
  });
});

afterEach(() => mock.restoreAll());

for (const [name, overrides] of [
  ['invalid subscription', { subscriptionId: 'not-a-guid' }],
  ['unknown region', { region: 'not-a-region' }],
  ['query injection region', { region: "centralindia' | take 1" }],
  ['zero count', { desiredCount: 0 }],
  ['negative count', { desiredCount: -1 }],
  ['count above Azure int32 limit', { desiredCount: 2147483648 }],
  ['unsafe count', { desiredCount: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional count', { desiredCount: 1.5 }],
  ['string count', { desiredCount: '5' }],
  ['null count', { desiredCount: null }],
  ['empty sizes', { desiredSizes: [] }],
  ['too many sizes', { desiredSizes: Array.from({ length: 6 }, (_, index) => ({ sku: `Standard_D${index}_v5` })) }],
  ['invalid size object', { desiredSizes: [null] }],
  ['invalid size name', { desiredSizes: [{ sku: 'bad/name' }] }],
  ['duplicate size', { desiredSizes: [{ sku }, { sku: sku.toLowerCase() }] }],
  ['empty locations', { desiredLocations: [] }],
  ['invalid location', { desiredLocations: ['unknown'] }],
  ['duplicate location', { desiredLocations: [region, region] }],
  ['non-boolean zone selection', { availabilityZones: 'false' }]
]) {
  test(`rejects ${name} before generating Azure placement scores`, async () => {
    const response = await request('/api/placement-scores', input(overrides));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(azureCalls.length, 0);
  });
}

for (const endpoint of ['vm-quota', 'eviction-rates', 'config']) {
  test(`${endpoint} validates query scope and rejects repeated query values`, async () => {
    for (const query of [
      'subscriptionId=invalid&region=centralindia',
      `subscriptionId=${subscriptionId}&region=invalid`,
      `subscriptionId=${subscriptionId}&subscriptionId=${subscriptionId}&region=centralindia`
    ]) {
      const response = await request(`/api/${endpoint}?${query}`);
      assert.equal(response.status, 400);
    }
    assert.equal(azureCalls.length, 0);
  });
}

test('rejects malformed JSON with a JSON error response', async () => {
  const response = await realFetch(`${origin}/api/placement-scores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: '{'
  });
  assert.equal(response.status, 400);
  assert.equal(typeof (await response.json()).error, 'string');
  assert.equal(azureCalls.length, 0);
});

for (const [currentValue, limit, remaining, percentRemaining] of [
  [0, 0, 0, 0], [0, 100, 100, 100], [80, 100, 20, 20], [120, 100, 0, 0]
]) {
  test(`quota ${currentValue}/${limit} reports ${remaining} vCPUs and ${percentRemaining}% remaining`, async () => {
    upstream = async () => json({ value: [{ name: { value: 'lowPriorityCores' }, currentValue, limit }] });
    const response = await request(`/api/vm-quota?subscriptionId=${subscriptionId}&region=${region}`);
    assert.equal(response.status, 200);
    const quota = await response.json();
    assert.equal(quota.remaining, remaining);
    assert.equal(quota.percentRemaining, percentRemaining);
    assert.equal(quota.currentValue, currentValue);
    assert.equal(quota.limit, limit);
    assert.ok(Number.isFinite(Date.parse(quota.fetchedAt)));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
}

for (const metrics of [
  {}, { currentValue: 0 }, { limit: 10 }, { currentValue: -1, limit: 10 },
  { currentValue: 0, limit: -1 }, { currentValue: '0', limit: 10 }, { currentValue: 0, limit: null }
]) {
  test(`invalid quota metrics are not defaulted to zero: ${JSON.stringify(metrics)}`, async () => {
    upstream = async () => json({ value: [{ name: { value: 'lowPriorityCores' }, ...metrics }] });
    const response = await request(`/api/vm-quota?subscriptionId=${subscriptionId}&region=${region}`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /invalid.*quota|invalid.*usage/i);
  });
}

test('missing regional quota is explicitly unknown', async () => {
  upstream = async () => json({ value: [] });
  const response = await request(`/api/vm-quota?subscriptionId=${subscriptionId}&region=${region}`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /unknown/i);
});

test('duplicate regional quota entries do not silently use the first balance', async () => {
  upstream = async () => json({ value: [
    { name: { value: 'lowPriorityCores' }, currentValue: 0, limit: 100 },
    { name: { value: 'lowPriorityCores' }, currentValue: 100, limit: 100 }
  ] });
  const response = await request(`/api/vm-quota?subscriptionId=${subscriptionId}&region=${region}`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /duplicate/i);
});

test('preserves count, false zone selection, and explicit insufficient quota', async () => {
  upstream = async () => json({ placementScores: [score({ availabilityZone: '', isQuotaAvailable: false })] });
  const response = await request('/api/placement-scores', input({ desiredCount: 10, availabilityZones: false }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.placementScores[0].isQuotaAvailable, false);
  assert.equal(data.placementScores[0].score, 'High');
  assert.equal(azureCalls[0].body.desiredCount, 10);
  assert.equal(azureCalls[0].body.availabilityZones, false);
  assert.deepEqual(azureCalls[0].body.desiredLocations, [region]);
  assert.ok(Number.isFinite(Date.parse(data.fetchedAt)));
});

test('missing and malformed quota flags remain unknown, not false', async () => {
  upstream = async () => json({ placementScores: [
    score({ isQuotaAvailable: undefined }), score({ availabilityZone: '2', isQuotaAvailable: 'false' })
  ] });
  const response = await request('/api/placement-scores', input());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.placementScores.every(item => item.isQuotaAvailable === null));
  assert.ok(data.warnings.some(warning => /quota.*unknown/i.test(warning)));
});

test('normalizes Azure SKU casing to the requested name', async () => {
  upstream = async () => json({ placementScores: [score({ sku: sku.toLowerCase() })] });
  const response = await request('/api/placement-scores', input());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).placementScores[0].sku, sku);
});

test('distinguishes restricted, stale, and unrecognized scores', async () => {
  upstream = async () => json({ placementScores: [
    score({ score: 'RestrictedSkuNotAvailable' }),
    score({ availabilityZone: '2', score: 'DataNotFoundOrStale' }),
    score({ availabilityZone: '3', score: 'NewAzureStatus' })
  ] });
  const response = await request('/api/placement-scores', input());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.placementScores.map(item => item.score), ['RestrictedSkuNotAvailable', 'DataNotFoundOrStale', 'Unknown']);
  assert.match(data.placementScores[2].scoreDetail, /NewAzureStatus/);
  assert.ok(data.warnings.some(warning => /missing or stale/.test(warning)));
});

for (const data of [
  {}, { placementScores: [] }, { placementScores: [null] },
  { placementScores: [score({ sku: 'Standard_Other' })] },
  { placementScores: [score({ region: 'eastus' })] },
  { placementScores: [score({ availabilityZone: 1 })] },
  { placementScores: [score(), score()] }
]) {
  test(`rejects invalid or mismatched placement data: ${JSON.stringify(data)}`, async () => {
    upstream = async () => json(data);
    const response = await request('/api/placement-scores', input());
    assert.equal(response.status, 502);
    assert.equal(typeof (await response.json()).error, 'string');
  });
}

test('warns about requested SKUs omitted from an otherwise valid response', async () => {
  upstream = async () => json({ placementScores: [score()] });
  const response = await request('/api/placement-scores', input({ desiredSizes: [{ sku }, { sku: 'Standard_D8s_v5' }] }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.warnings.some(warning => /standard_d8s_v5.*no placement result/.test(warning)));
});

test('preserves Azure rate-limit status and Retry-After', async () => {
  upstream = async () => json({ error: 'Rate limit' }, 429, { 'Retry-After': '120' });
  const response = await request('/api/placement-scores', input());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '120');
});

test('invalid Azure JSON is an explicit upstream error', async () => {
  upstream = async () => new Response('{');
  const response = await request('/api/placement-scores', input());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /invalid JSON/);
});

test('reads all eviction-rate pages and keeps absent rates unknown', async () => {
  upstream = async call => call.body.options.$skipToken
    ? json({ data: [{ skuName: 'Standard_D8s_v5', location: region, spotEvictionRate: '' }], resultTruncated: 'false' })
    : json({ data: [{ skuName: sku, location: region, spotEvictionRate: '0-5' }], resultTruncated: 'true', $skipToken: 'next-page' });
  const response = await request(`/api/eviction-rates?subscriptionId=${subscriptionId}&region=${region}`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.rates[sku.toLowerCase()], '0-5');
  assert.equal(data.rates.standard_d8s_v5, null);
  assert.equal(azureCalls.length, 2);
  assert.equal(azureCalls[1].body.options.$skipToken, 'next-page');
});

for (const data of [
  {}, { data: [{ skuName: sku, location: region, spotEvictionRate: 'unexpected' }] },
  { data: [{ skuName: sku, location: 'eastus', spotEvictionRate: '0-5' }] },
  { data: [], resultTruncated: 'true' },
  { data: [], resultTruncated: 'unknown' }
]) {
  test(`does not present invalid or incomplete eviction data as verified: ${JSON.stringify(data)}`, async () => {
    upstream = async () => json(data);
    const response = await request(`/api/eviction-rates?subscriptionId=${subscriptionId}&region=${region}`);
    assert.equal(response.status, 502);
  });
}

test('filters catalogue by region, Spot support, and location restrictions while preserving zone-only restrictions', async () => {
  upstream = async () => json({ value: [
    catalogSku(sku),
    catalogSku('Standard_D8s_v5', { restrictions: [{ type: 'Zone', restrictionInfo: { locations: [region], zones: ['1'] } }] }),
    catalogSku('Standard_D16s_v5', { locations: ['eastus'] }),
    catalogSku('Standard_D32s_v5', { capabilities: [{ name: 'LowPriorityCapable', value: 'False' }] }),
    catalogSku('Standard_D64s_v5', { restrictions: [{ type: 'Location', values: [region] }] }),
    catalogSku('disk', { resourceType: 'disks' })
  ] });
  const response = await request(catalogQuery());
  const config = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.values(config.skuFamilies).flat(), [sku, 'Standard_D8s_v5']);
  assert.equal(config.catalogSource, 'azure');
  assert.equal(config.catalogRegion, region);
  assert.equal(new URL(azureCalls[0].url).searchParams.get('$filter'), `location eq '${region}'`);
});

test('does not replace a verified empty catalogue with static SKUs', async () => {
  upstream = async () => json({ value: [] });
  const response = await request(catalogQuery());
  const config = await response.json();
  assert.equal(config.catalogSource, 'azure');
  assert.deepEqual(config.skuFamilies, {});
  assert.ok(config.warnings.some(warning => /no Spot-capable/.test(warning)));
});

test('SKU discovery failure returns an error without a static fallback', async () => {
  upstream = async () => json({ error: 'Forbidden' }, 403);
  const response = await request(catalogQuery());
  const config = await response.json();
  assert.equal(response.status, 403);
  assert.equal(typeof config.error, 'string');
  assert.equal(Object.hasOwn(config, 'skuFamilies'), false);
  assert.equal(Object.hasOwn(config, 'catalogSource'), false);
});

for (const overrides of [
  { restrictions: [{ type: 'UnrecognizedRestriction' }] },
  { capabilities: [{ name: 'LowPriorityCapable', value: 'Unknown' }] }
]) {
  test(`invalid catalogue metadata fails closed: ${JSON.stringify(overrides)}`, async () => {
    upstream = async () => json({ value: [catalogSku(sku, overrides)] });
    const response = await request(catalogQuery());
    const config = await response.json();
    assert.equal(response.status, 502);
    assert.equal(typeof config.error, 'string');
    assert.equal(Object.hasOwn(config, 'skuFamilies'), false);
  });
}

test('catalogue cache is scoped by subscription and region and expires after 15 minutes', async () => {
  let clock = Date.now();
  mock.method(Date, 'now', () => clock);
  upstream = async () => json({ value: [] });
  const route = catalogQuery();
  await request(route);
  await request(route);
  assert.equal(azureCalls.length, 1);
  await request(route.replace('centralindia', 'eastus'));
  assert.equal(azureCalls.length, 2);
  await request(catalogQuery());
  assert.equal(azureCalls.length, 3);
  clock += 15 * 60 * 1000 + 1;
  await request(route);
  assert.equal(azureCalls.length, 4);
});

test('region discovery uses Azure metadata and VM-provider support, not a fixed list', async () => {
  upstream = async () => json({ value: [] });
  const response = await request(catalogQuery());
  const config = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(config.regions, ['centralindia', 'eastus', 'futureregion1', 'spaincentral']);
  assert.equal(config.regions.includes('global'), false);
  assert.equal(config.regions.includes('unsupportedregion'), false);
  assert.equal(config.maxDesiredCount, 2147483647);
  assert.ok(Number.isFinite(Date.parse(config.regionsFetchedAt)));
  assert.equal(discoveryCalls.length, 2);
});

for (const count of [11, 100, 2147483647]) {
  test(`passes supported desired count ${count} to Azure without clamping`, async () => {
    upstream = async () => json({ placementScores: [score()] });
    const response = await request('/api/placement-scores', input({ desiredCount: count }));
    assert.equal(response.status, 200);
    assert.equal(azureCalls[0].body.desiredCount, count);
  });
}

test('a newly discovered region is accepted as API host and desired location', async () => {
  upstream = async () => json({ placementScores: [score({ region: 'spaincentral' })] });
  const response = await request('/api/placement-scores', input({ region: 'spaincentral', desiredLocations: ['spaincentral'] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).placementScores[0].region, 'spaincentral');
  assert.match(azureCalls[0].url, /\/locations\/spaincentral\/placementScores/);
});

test('well-formed but undiscovered regions are rejected before scoring', async () => {
  const response = await request('/api/placement-scores', input({ region: 'notarealregion' }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /discovered Azure VM regions/);
  assert.equal(azureCalls.length, 0);
});

test('configuration requires a subscription rather than offering static regions or sizes', async () => {
  const response = await request('/api/config');
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.equal(Object.hasOwn(body, 'regions'), false);
  assert.equal(Object.hasOwn(body, 'skuFamilies'), false);
  assert.equal(discoveryCalls.length, 0);
});

test('initial region comes from verified discovery, with a warning for an unavailable preference', async () => {
  const previous = process.env.DEFAULT_REGION;
  process.env.DEFAULT_REGION = 'notarealregion';
  upstream = async () => json({ value: [] });
  try {
    const response = await request(catalogQuery().replace('&region=centralindia', ''));
    const config = await response.json();
    assert.equal(response.status, 200);
    assert.ok(config.regions.includes(config.catalogRegion));
    assert.ok(config.warnings.some(warning => /preferred default region/.test(warning)));
  } finally {
    process.env.DEFAULT_REGION = previous;
  }
});

test('region discovery failure returns an error and is retried, never a fixed fallback', async () => {
  const route = catalogQuery();
  discoveryUpstream = async () => json({ error: 'Discovery unavailable' }, 503);
  let response = await request(route);
  assert.equal(response.status, 503);
  assert.equal(Object.hasOwn(await response.json(), 'regions'), false);
  assert.equal(azureCalls.length, 0);
  discoveryUpstream = discoveryResponse;
  upstream = async () => json({ value: [] });
  response = await request(route);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).regions.includes('spaincentral'));
});

for (const invalidResponse of [
  {},
  { resourceTypes: [] },
  { resourceTypes: [{ resourceType: 'virtualMachines', locations: null }] }
]) {
  test(`invalid VM-provider discovery metadata fails closed: ${JSON.stringify(invalidResponse)}`, async () => {
    discoveryUpstream = async call => call.url.includes('/locations?')
      ? json({ value: locationRows }) : json(invalidResponse);
    const response = await request(catalogQuery());
    assert.equal(response.status, 502);
    assert.equal(Object.hasOwn(await response.json(), 'skuFamilies'), false);
    assert.equal(azureCalls.length, 0);
  });
}

test('region discovery follows continuation pages and caches per subscription until expiry', async () => {
  let clock = Date.now();
  mock.method(Date, 'now', () => clock);
  const route = catalogQuery();
  const id = new URL(route, origin).searchParams.get('subscriptionId');
  const nextLink = `https://management.azure.com/subscriptions/${id}/locations?page=2`;
  discoveryUpstream = async call => {
    if (!call.url.includes('/locations?')) return json(providerMetadata);
    return call.url === nextLink
      ? json({ value: locationRows.slice(2) })
      : json({ value: locationRows.slice(0, 2), nextLink });
  };
  upstream = async () => json({ value: [] });
  let response = await request(route);
  assert.ok((await response.json()).regions.includes('spaincentral'));
  assert.equal(discoveryCalls.length, 3);
  await request(route.replace('centralindia', 'eastus'));
  assert.equal(discoveryCalls.length, 3);
  clock += 15 * 60 * 1000 + 1;
  discoveryUpstream = async () => json({ error: 'Unavailable' }, 503);
  response = await request(route);
  assert.equal(response.status, 503);
  assert.equal(Object.hasOwn(await response.json(), 'regions'), false);
  discoveryUpstream = discoveryResponse;
  response = await request(route);
  assert.equal(response.status, 200);
});
