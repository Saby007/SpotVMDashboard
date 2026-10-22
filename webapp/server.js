// Angular SPA host and read-only Azure API proxy.
// In local dev we use the developer's
// `az login` session; in App Service we use the site's managed identity.

const express = require('express');
const path = require('path');
const { execFile } = require('child_process');

const app = express();

const STATIC_DIR = path.join(__dirname, 'dist/spotvm-dashboard/browser');

// LOCAL_DEV is on by default when running outside Azure App Service. Set
// LOCAL_DEV=0 to force production behaviour (managed-identity token source).
const IS_APP_SERVICE = !!process.env.WEBSITE_SITE_NAME;
const LOCAL_DEV = process.env.LOCAL_DEV
  ? process.env.LOCAL_DEV === '1' || process.env.LOCAL_DEV.toLowerCase() === 'true'
  : !IS_APP_SERVICE;

const ARM_RESOURCE = 'https://management.azure.com/';
const SCORE_API_VERSION = '2025-06-05';
const DEFAULT_DESIRED_COUNT = 5;
const MAX_DESIRED_COUNT = 2 ** 31 - 1;
const DISCOVERY_TTL_MS = 15 * 60 * 1000;
const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z][a-z0-9]*$/;
const SKU_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/i;
const EVICTION_RATES = new Set(['0-5', '5-10', '10-15', '15-20', '20+']);
const PLACEMENT_SCORES = new Set(['High', 'Medium', 'Low', 'RestrictedSkuNotAvailable', 'DataNotFoundOrStale']);
const VM_FAMILY_PREFIXES = ['NC', 'ND', 'NV', 'NP', 'NM', 'NG', 'HB', 'HC', 'HX', 'DC', 'EC', 'FX'];

app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(STATIC_DIR));

// Health probe (cheap, no auth)
app.get('/healthz', (_req, res) => res.json({ status: 'ok', localDev: LOCAL_DEV }));

console.log(`[auth] Runtime identity mode: ${LOCAL_DEV ? 'Azure CLI' : 'Managed Identity'}`);

let tokenCache = null;
const skuCatalogCache = new Map();
const regionDiscoveryCache = new Map();

function apiError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireSubscriptionId(subscriptionId) {
  if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    throw apiError('subscriptionId must be a valid subscription GUID.', 400);
  }
}

function requireRegionName(region) {
  if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
    throw apiError('region must be a valid lowercase Azure region name.', 400);
  }
}

async function requireDiscoveredRegions(subscriptionId, regions) {
  const discovery = await fetchRegionDiscovery(subscriptionId);
  const unknown = regions.filter(region => !discovery.regions.includes(region));
  if (unknown.length) {
    throw apiError(`Regions are not in this subscription's discovered Azure VM regions: ${[...new Set(unknown)].join(', ')}.`, 400);
  }
  return discovery;
}

async function requireScope(subscriptionId, region) {
  requireSubscriptionId(subscriptionId);
  requireRegionName(region);
  await requireDiscoveredRegions(subscriptionId, [region]);
}

function requireArray(data, field, source) {
  if (!isRecord(data) || !Array.isArray(data[field])) {
    throw apiError(`Azure returned an invalid ${source} response: ${field} must be an array.`);
  }
  return data[field];
}

function sendApiError(res, route, err) {
  console.error(`[api] ${route} failed:`, err.message);
  if (err.retryAfter) res.set('Retry-After', err.retryAfter);
  return res.status(err.status || 500).json({ error: err.message });
}

function placementInput(body) {
  if (!isRecord(body)) throw apiError('A JSON request object is required.', 400);
  const { subscriptionId, region } = body;
  requireSubscriptionId(subscriptionId);
  requireRegionName(region);
  const desiredCount = body.desiredCount === undefined ? DEFAULT_DESIRED_COUNT : body.desiredCount;
  if (!Number.isInteger(desiredCount) || desiredCount < 1 || desiredCount > MAX_DESIRED_COUNT) {
    throw apiError(`desiredCount must be an integer from 1 to ${MAX_DESIRED_COUNT} (Azure int32 limit).`, 400);
  }
  if (!Array.isArray(body.desiredSizes) || body.desiredSizes.length < 1 || body.desiredSizes.length > 5
    || !body.desiredSizes.every(item => isRecord(item) && typeof item.sku === 'string' && SKU_PATTERN.test(item.sku))) {
    throw apiError('desiredSizes must contain 1 to 5 objects with valid SKU names.', 400);
  }
  const desiredSizes = body.desiredSizes.map(({ sku }) => ({ sku }));
  if (new Set(desiredSizes.map(item => item.sku.toLowerCase())).size !== desiredSizes.length) {
    throw apiError('desiredSizes must not contain duplicate SKUs.', 400);
  }
  const desiredLocations = body.desiredLocations === undefined ? [region] : body.desiredLocations;
  if (!Array.isArray(desiredLocations) || desiredLocations.length < 1 || desiredLocations.length > 8
    || !desiredLocations.every(location => typeof location === 'string' && REGION_PATTERN.test(location))
    || new Set(desiredLocations).size !== desiredLocations.length) {
    throw apiError('desiredLocations must contain 1 to 8 distinct Azure region names.', 400);
  }
  if (body.availabilityZones !== undefined && typeof body.availabilityZones !== 'boolean') {
    throw apiError('availabilityZones must be a boolean.', 400);
  }
  return { subscriptionId, region, desiredCount, desiredSizes, desiredLocations, availabilityZones: body.availabilityZones ?? true };
}

function placementResponse(data, input) {
  const rows = requireArray(data, 'placementScores', 'placement score');
  if (rows.length === 0) throw apiError('Azure returned no placement scores. Availability is unknown.');
  const requestedSkus = new Map(input.desiredSizes.map(item => [item.sku.toLowerCase(), item.sku]));
  const seen = new Set();
  const warnings = new Set();
  const placementScores = rows.map(row => {
    if (!isRecord(row) || typeof row.sku !== 'string' || !requestedSkus.has(row.sku.toLowerCase())
      || typeof row.region !== 'string' || !input.desiredLocations.includes(row.region.toLowerCase())) {
      throw apiError('Azure returned a placement score outside the requested SKU/region scope.');
    }
    const availabilityZone = row.availabilityZone ?? '';
    if (typeof availabilityZone !== 'string' || !/^\d*$/.test(availabilityZone)
      || (!input.availabilityZones && availabilityZone !== '')) {
      throw apiError('Azure returned an invalid availability zone in a placement score.');
    }
    const key = `${row.sku.toLowerCase()}:${row.region.toLowerCase()}:${availabilityZone}`;
    if (seen.has(key)) throw apiError('Azure returned duplicate placement scores for the same SKU, region, and zone.');
    seen.add(key);

    const score = PLACEMENT_SCORES.has(row.score) ? row.score : 'Unknown';
    let scoreDetail = null;
    if (score === 'Unknown') {
      scoreDetail = typeof row.score === 'string' ? `Unrecognized Azure score: ${row.score}` : 'Azure did not provide a placement score.';
      warnings.add(`${row.sku}: ${scoreDetail} Availability is unknown, not restricted.`);
    } else if (score === 'DataNotFoundOrStale') {
      scoreDetail = 'Azure has no sufficiently fresh data to generate a placement score.';
      warnings.add(`${row.sku}: placement data is missing or stale. Availability is unknown.`);
    }
    const isQuotaAvailable = typeof row.isQuotaAvailable === 'boolean' ? row.isQuotaAvailable : null;
    if (isQuotaAvailable === null) {
      warnings.add(`${row.sku}: Azure did not return a valid quota signal. Quota sufficiency is unknown.`);
    }
    return { sku: requestedSkus.get(row.sku.toLowerCase()), region: row.region.toLowerCase(), availabilityZone, score, scoreDetail, isQuotaAvailable };
  });
  for (const sku of requestedSkus.keys()) {
    for (const region of input.desiredLocations) {
      if (!placementScores.some(row => row.sku.toLowerCase() === sku && row.region === region)) {
        warnings.add(`${sku} in ${region}: no placement result was returned. Do not infer unavailability.`);
      }
    }
  }
  return { placementScores, warnings: [...warnings], fetchedAt: new Date().toISOString() };
}

const runAz = (args) =>
  new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'az.cmd' : 'az';
    execFile(cmd, args, { windowsHide: true, shell: isWin, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`az output was not JSON: ${stdout}`));
      }
    });
  });

function parseFamilyCode(familyCode) {
  let raw = familyCode
    .replace(/^standard/i, '')
    .replace(/Family$/i, '')
    .replace(/Promo$/i, '');
  if (!raw) return { category: 'General purpose', series: 'Other-series' };

  const upper = raw.toUpperCase();
  let category;
  if (upper.startsWith('N')) category = 'GPU';
  else if (upper.startsWith('H')) category = 'High performance compute';
  else if (upper.startsWith('L')) category = 'Storage optimized';
  else if (upper.startsWith('M')) category = 'Memory optimized';
  else if (upper.startsWith('E')) category = 'Memory optimized';
  else if (upper.startsWith('F')) category = 'Compute optimized';
  else category = 'General purpose';

  let prefixLen = 1;
  for (const prefix of VM_FAMILY_PREFIXES) {
    if (upper.startsWith(prefix)) {
      prefixLen = prefix.length;
      break;
    }
  }
  const familyPrefix = raw.substring(0, prefixLen).toUpperCase();
  const rest = raw.substring(prefixLen).toLowerCase();
  return { category, series: familyPrefix + rest + '-series' };
}

async function getArmToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expires_on - nowSec > 300) {
    return tokenCache.access_token;
  }

  if (LOCAL_DEV) {
    const out = await runAz([
      'account', 'get-access-token',
      '--resource', ARM_RESOURCE,
      '--output', 'json'
    ]);
    tokenCache = {
      access_token: out.accessToken,
      expires_on: out.expires_on ? Number(out.expires_on) : Math.floor(new Date(out.expiresOn).getTime() / 1000)
    };
    return tokenCache.access_token;
  }

  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) {
    throw new Error('Managed identity endpoint is not available. Ensure the App Service identity is enabled.');
  }

  const response = await fetch(
    `${endpoint}?resource=${encodeURIComponent(ARM_RESOURCE)}&api-version=2019-08-01`,
    { headers: { 'X-IDENTITY-HEADER': header } }
  );
  if (!response.ok) {
    throw new Error(`Managed identity token request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  tokenCache = {
    access_token: data.access_token,
    expires_on: Number(data.expires_on || nowSec + 300)
  };
  return tokenCache.access_token;
}

async function armFetch(url, options = {}) {
  const token = await getArmToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {})
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(detail || `ARM request failed: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('Retry-After');
    throw error;
  }
  try {
    return await response.json();
  } catch (err) {
    throw apiError(`Azure returned invalid JSON: ${err.message}`);
  }
}

function configuredSubscriptions() {
  if (process.env.AZURE_SUBSCRIPTIONS) {
    try {
      const parsed = JSON.parse(process.env.AZURE_SUBSCRIPTIONS);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(item => item && item.id)
          .map(item => ({ id: item.id, name: item.name || item.id }));
      }
    } catch (err) {
      console.warn('[config] Failed to parse AZURE_SUBSCRIPTIONS:', err.message);
    }
  }

  if (process.env.AZURE_SUBSCRIPTION_ID) {
    return [{
      id: process.env.AZURE_SUBSCRIPTION_ID,
      name: process.env.AZURE_SUBSCRIPTION_NAME || process.env.AZURE_SUBSCRIPTION_ID
    }];
  }

  return [];
}

async function listSubscriptions() {
  const configured = configuredSubscriptions();
  if (configured.length > 0) return configured;

  const data = await armFetch('https://management.azure.com/subscriptions?api-version=2022-12-01');
  return (data.value || [])
    .filter(sub => !sub.state || sub.state === 'Enabled' || sub.state === 'PastDue')
    .map(sub => ({ id: sub.subscriptionId, name: sub.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function cachedDiscovery(cache, key, load) {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const entry = { promise: load(), expiresAt: Date.now() + DISCOVERY_TTL_MS };
  cache.set(key, entry);
  try {
    const result = await entry.promise;
    entry.expiresAt = Date.now() + DISCOVERY_TTL_MS;
    return result;
  } catch (err) {
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  }
}

async function armList(url, source) {
  const items = [];
  const visited = new Set();
  while (url) {
    if (visited.has(url)) throw apiError(`Azure returned a repeated ${source} page.`);
    visited.add(url);
    const data = await armFetch(url);
    items.push(...requireArray(data, 'value', source));
    if (data.nextLink != null && (typeof data.nextLink !== 'string' || !data.nextLink.startsWith(ARM_RESOURCE))) {
      throw apiError(`Azure returned an invalid ${source} nextLink.`);
    }
    url = data.nextLink || null;
  }
  return items;
}

async function fetchRegionDiscovery(subscriptionId) {
  return cachedDiscovery(regionDiscoveryCache, subscriptionId.toLowerCase(), async () => {
    const subscriptionPath = `${ARM_RESOURCE}subscriptions/${encodeURIComponent(subscriptionId)}`;
    const [locations, provider] = await Promise.all([
      armList(`${subscriptionPath}/locations?api-version=2022-12-01`, 'region discovery'),
      armFetch(`${subscriptionPath}/providers/Microsoft.Compute?api-version=2021-04-01`)
    ]);
    const vmTypes = requireArray(provider, 'resourceTypes', 'Compute provider')
      .filter(type => isRecord(type) && typeof type.resourceType === 'string' && type.resourceType.toLowerCase() === 'virtualmachines');
    if (vmTypes.length !== 1 || !Array.isArray(vmTypes[0].locations)
      || !vmTypes[0].locations.every(location => typeof location === 'string' && location.trim())) {
      throw apiError('Azure returned invalid virtual-machine region support metadata.');
    }
    const supported = new Set(vmTypes[0].locations.map(location => location.trim().toLowerCase()));
    const regions = new Set();
    for (const location of locations) {
      if (!isRecord(location) || typeof location.name !== 'string' || !REGION_PATTERN.test(location.name)
        || !isRecord(location.metadata) || !['Physical', 'Logical'].includes(location.metadata.regionType)) {
        throw apiError('Azure returned invalid subscription region metadata.');
      }
      if (location.metadata.regionType !== 'Physical') continue;
      if (typeof location.displayName !== 'string' || !location.displayName.trim()) {
        throw apiError('Azure returned invalid region display metadata.');
      }
      if (supported.has(location.name) || supported.has(location.displayName.trim().toLowerCase())) {
        regions.add(location.name);
      }
    }
    if (regions.size === 0) throw apiError('Azure returned no verified physical VM regions. Region discovery is unavailable.');
    return { regions: [...regions].sort(), fetchedAt: new Date().toISOString() };
  });
}

async function fetchAndCategorizeSkus(subscriptionId, region) {
  return cachedDiscovery(skuCatalogCache, `${subscriptionId.toLowerCase()}:${region}`, async () => {
    const allSkus = await armList(
      `${ARM_RESOURCE}subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=${encodeURIComponent(`location eq '${region}'`)}`,
      'SKU catalogue'
    );
    const familyMap = new Map();
    for (const sku of allSkus) {
      if (!isRecord(sku) || typeof sku.resourceType !== 'string') throw apiError('Azure returned an invalid SKU catalogue entry.');
      if (sku.resourceType.toLowerCase() !== 'virtualmachines') continue;
      if (typeof sku.name !== 'string' || !SKU_PATTERN.test(sku.name)
        || !Array.isArray(sku.locations) || !sku.locations.every(location => typeof location === 'string')
        || !Array.isArray(sku.capabilities) || !sku.capabilities.every(item => isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string')
        || (sku.restrictions != null && !Array.isArray(sku.restrictions))
        || (sku.family != null && typeof sku.family !== 'string')) {
        throw apiError('Azure returned invalid VM SKU metadata.');
      }
      if (!sku.locations.some(location => location.toLowerCase() === region)) continue;
      const cap = sku.capabilities.find(item => item.name === 'LowPriorityCapable');
      if (cap && !['true', 'false'].includes(cap.value.toLowerCase())) throw apiError('Azure returned invalid Spot capability metadata.');
      if (!cap || cap.value.toLowerCase() !== 'true') continue;
      const restricted = (sku.restrictions || []).some(restriction => {
        if (!isRecord(restriction) || typeof restriction.type !== 'string') throw apiError('Azure returned an invalid SKU restriction.');
        const type = restriction.type.toLowerCase();
        if (type === 'zone') return false;
        if (type !== 'location') throw apiError('Azure returned an unrecognized SKU restriction type.');
        const locations = restriction.restrictionInfo?.locations ?? restriction.values;
        if (!Array.isArray(locations) || !locations.every(location => typeof location === 'string')) {
          throw apiError('Azure returned invalid SKU restriction locations.');
        }
        return locations.length === 0 || locations.some(location => location.toLowerCase() === region);
      });
      if (restricted) continue;

      const family = sku.family || 'unknownFamily';
      if (!familyMap.has(family)) familyMap.set(family, new Set());
      familyMap.get(family).add(sku.name);
    }

    const result = {};
    for (const [familyCode, skuSet] of familyMap.entries()) {
      const { category, series } = parseFamilyCode(familyCode);
      const key = `${category} - ${series}`;
      result[key] = [...(result[key] || []), ...skuSet];
      result[key] = [...new Set(result[key])].sort();
    }

    const sorted = {};
    for (const key of Object.keys(result).sort()) {
      sorted[key] = result[key];
    }
    return { skuFamilies: sorted, catalogFetchedAt: new Date().toISOString() };
  });
}

app.get('/api/me', async (_req, res) => {
  try {
    if (LOCAL_DEV) {
      const account = await runAz(['account', 'show', '--output', 'json']);
      return res.json({
        oid: '',
        name: account.user?.name || 'Local Azure CLI',
        upn: account.user?.name || '',
        tenantId: account.tenantId,
        subscriptionId: account.id,
        subscriptionName: account.name
      });
    }

    res.json({
      oid: process.env.WEBSITE_AUTH_CLIENT_ID || '',
      name: 'App Service managed identity',
      upn: ''
    });
  } catch (err) {
    console.error('[api] /api/me failed:', err.message, err.stderr || '');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions', async (_req, res) => {
  try {
    res.json(await listSubscriptions());
  } catch (err) {
    console.error('[api] /api/subscriptions failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  try {
    const subscriptionId = req.query.subscriptionId;
    requireSubscriptionId(subscriptionId);
    if (req.query.region !== undefined) requireRegionName(req.query.region);
    const discovery = await fetchRegionDiscovery(subscriptionId);
    const preferredRegion = (process.env.DEFAULT_REGION || 'centralindia').trim().toLowerCase();
    const region = req.query.region ?? (discovery.regions.includes(preferredRegion) ? preferredRegion : discovery.regions[0]);
    if (!discovery.regions.includes(region)) {
      throw apiError('region must be one of this subscription\'s discovered Azure VM regions.', 400);
    }
    const warnings = [];
    if (req.query.region === undefined && region !== preferredRegion) {
      warnings.push(`The preferred default region ${preferredRegion || '(empty)'} is not in Azure's discovered VM regions. Selected ${region} from the verified list.`);
    }
    const catalog = await fetchAndCategorizeSkus(subscriptionId, region);
    if (Object.keys(catalog.skuFamilies).length === 0) {
      warnings.push(`Azure returned no Spot-capable VM sizes without region-wide restrictions for this subscription in ${region}.`);
    }
    res.json({
      regions: discovery.regions,
      regionsFetchedAt: discovery.fetchedAt,
      skuFamilies: catalog.skuFamilies,
      defaultDesiredCount: DEFAULT_DESIRED_COUNT,
      maxDesiredCount: MAX_DESIRED_COUNT,
      catalogSource: 'azure',
      catalogRegion: region,
      catalogFetchedAt: catalog.catalogFetchedAt,
      warnings
    });
  } catch (err) {
    sendApiError(res, '/api/config', err);
  }
});

app.get('/api/eviction-rates', async (req, res) => {
  try {
    const { subscriptionId, region } = req.query;
    await requireScope(subscriptionId, region);
    const query = `SpotResources\n| where type =~ 'microsoft.compute/skuspotevictionrate/location'\n| where location =~ '${region}'\n| project skuName = tostring(sku.name), location, spotEvictionRate = tostring(properties.evictionRate)`;
    const rates = {};
    const seenTokens = new Set();
    let skipToken;
    do {
      const data = await armFetch('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: [subscriptionId], query, options: { resultFormat: 'objectArray', $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) } })
      });
      for (const row of requireArray(data, 'data', 'eviction rate')) {
        if (!isRecord(row) || typeof row.skuName !== 'string' || !SKU_PATTERN.test(row.skuName)
          || typeof row.location !== 'string' || row.location.toLowerCase() !== region
          || (row.spotEvictionRate != null && row.spotEvictionRate !== '' && !EVICTION_RATES.has(row.spotEvictionRate))) {
          throw apiError('Azure returned invalid eviction-rate data.');
        }
        const key = row.skuName.toLowerCase();
        if (Object.hasOwn(rates, key)) throw apiError('Azure returned duplicate eviction-rate data for a SKU.');
        rates[key] = row.spotEvictionRate || null;
      }
      skipToken = data['$skipToken'];
      if (data.resultTruncated != null && ![true, false, 'true', 'false'].includes(data.resultTruncated)) {
        throw apiError('Azure returned an invalid eviction-rate truncation flag.');
      }
      if (skipToken != null && (typeof skipToken !== 'string' || seenTokens.has(skipToken))) {
        throw apiError('Azure returned an invalid eviction-rate continuation token.');
      }
      if ((data.resultTruncated === true || data.resultTruncated === 'true') && !skipToken) {
        throw apiError('Azure returned incomplete eviction-rate data without a continuation token.');
      }
      if (skipToken) seenTokens.add(skipToken);
    } while (skipToken);
    res.json({ rates, fetchedAt: new Date().toISOString() });
  } catch (err) {
    sendApiError(res, '/api/eviction-rates', err);
  }
});

app.get('/api/vm-quota', async (req, res) => {
  try {
    const { subscriptionId, region } = req.query;
    await requireScope(subscriptionId, region);
    const data = await armFetch(`https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=2024-07-01`);
    const entries = requireArray(data, 'value', 'VM quota');
    const spotEntries = entries.filter(item => isRecord(item) && typeof item.name?.value === 'string' && item.name.value.toLowerCase() === 'lowprioritycores');
    if (spotEntries.length > 1) throw apiError('Azure returned duplicate regional Spot vCPU quota entries. Quota is unknown.');
    const entry = spotEntries[0];
    if (!entry) {
      throw apiError('Regional Spot vCPU quota was not returned by Azure. Quota is unknown.', 404);
    }

    const { currentValue, limit } = entry;
    if (!Number.isSafeInteger(currentValue) || currentValue < 0 || !Number.isSafeInteger(limit) || limit < 0) {
      throw apiError('Azure returned invalid regional Spot vCPU usage or limit. Quota is unknown.');
    }
    const remaining = Math.max(0, limit - currentValue);
    const percentUsed = limit > 0 ? Math.round((currentValue / limit) * 100) : 0;
    res.json({
      region,
      currentValue,
      limit,
      remaining,
      percentUsed,
      percentRemaining: limit > 0 ? Math.round((remaining / limit) * 100) : 0,
      unit: entry.unit || 'Count',
      label: 'Regional Spot vCPUs',
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendApiError(res, '/api/vm-quota', err);
  }
});

app.post('/api/placement-scores', async (req, res) => {
  try {
    const input = placementInput(req.body);
    await requireDiscoveredRegions(input.subscriptionId, [input.region, ...input.desiredLocations]);
    const { subscriptionId, region, ...payload } = input;
    const data = await armFetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/placementScores/spot/generate?api-version=${SCORE_API_VERSION}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    res.json(placementResponse(data, input));
  } catch (err) {
    sendApiError(res, '/api/placement-scores', err);
  }
});

app.use((err, req, res, _next) => sendApiError(res, req.path, err));

// SPA fallback — any non-asset GET returns index.html so client-side routing works.
app.get(/^\/(?!healthz|api\/).*/, (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`Spot VM Dashboard running on port ${PORT} (LOCAL_DEV=${LOCAL_DEV})`);
  });
}

module.exports = app;
