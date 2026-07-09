// Pure static host for the Angular SPA.
// Azure calls now run on the server. In local dev we use the developer's
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
const STATIC_SKU_FAMILIES = {
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
const VM_FAMILY_PREFIXES = ['NC', 'ND', 'NV', 'NP', 'NM', 'NG', 'HB', 'HC', 'HX', 'DC', 'EC', 'FX'];

app.use(express.json({ limit: '1mb' }));

app.use(express.static(STATIC_DIR));

// Health probe (cheap, no auth)
app.get('/healthz', (_req, res) => res.json({ status: 'ok', localDev: LOCAL_DEV }));

console.log(`[auth] Runtime identity mode: ${LOCAL_DEV ? 'Azure CLI' : 'Managed Identity'}`);

let tokenCache = null;
const skuCatalogCache = new Map();

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
    throw error;
  }
  return response.json();
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

async function fetchAndCategorizeSkus(subscriptionId) {
  if (!subscriptionId) return STATIC_SKU_FAMILIES;
  if (skuCatalogCache.has(subscriptionId)) return skuCatalogCache.get(subscriptionId);

  const loader = (async () => {
    const allSkus = [];
    let url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=resourceType%20eq%20%27virtualMachines%27`;

    while (url) {
      const data = await armFetch(url);
      allSkus.push(...(data.value || []));
      url = data.nextLink || null;
    }

    const familyMap = new Map();
    for (const sku of allSkus) {
      const cap = (sku.capabilities || []).find(item => item.name === 'LowPriorityCapable');
      if (!cap || cap.value !== 'True') continue;

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
    return Object.keys(sorted).length > 0 ? sorted : STATIC_SKU_FAMILIES;
  })();

  skuCatalogCache.set(subscriptionId, loader);
  try {
    const result = await loader;
    skuCatalogCache.set(subscriptionId, result);
    return result;
  } catch (err) {
    skuCatalogCache.delete(subscriptionId);
    throw err;
  }
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
    const subscriptionId = typeof req.query.subscriptionId === 'string' ? req.query.subscriptionId : undefined;
    let skuFamilies = STATIC_SKU_FAMILIES;
    if (subscriptionId) {
      try {
        skuFamilies = await fetchAndCategorizeSkus(subscriptionId);
      } catch (err) {
        console.warn('[api] Falling back to static SKU families:', err.message);
      }
    }
    res.json({
      regions: REGIONS,
      skuFamilies,
      defaultDesiredCount: DEFAULT_DESIRED_COUNT
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/eviction-rates', async (req, res) => {
  const subscriptionId = typeof req.query.subscriptionId === 'string' ? req.query.subscriptionId : '';
  const region = typeof req.query.region === 'string' ? req.query.region : '';
  if (!subscriptionId || !region) {
    return res.status(400).json({ error: 'subscriptionId and region are required.' });
  }

  try {
    const query = `SpotResources\n| where type =~ 'microsoft.compute/skuspotevictionrate/location'\n| where location =~ '${region}'\n| project skuName = tostring(sku.name), location, spotEvictionRate = tostring(properties.evictionRate)`;
    const data = await armFetch('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions: [subscriptionId], query })
    });

    const evictionMap = {};
    for (const row of (data.data || [])) {
      const key = (row.skuName || '').toLowerCase();
      evictionMap[key] = row.spotEvictionRate || 'N/A';
    }
    res.json(evictionMap);
  } catch (err) {
    console.error('[api] /api/eviction-rates failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/vm-quota', async (req, res) => {
  const subscriptionId = typeof req.query.subscriptionId === 'string' ? req.query.subscriptionId : '';
  const region = typeof req.query.region === 'string' ? req.query.region : '';
  if (!subscriptionId || !region) {
    return res.status(400).json({ error: 'subscriptionId and region are required.' });
  }

  try {
    const data = await armFetch(`https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=2024-07-01`);
    const entry = (data.value || []).find(item => ((item.name && item.name.value) || '').toLowerCase() === 'lowprioritycores');
    if (!entry) {
      return res.status(404).json({ error: 'Low priority core quota entry not found.' });
    }

    const currentValue = entry.currentValue || 0;
    const limit = entry.limit || 0;
    const percentUsed = limit > 0 ? Math.round((currentValue / limit) * 100) : 0;
    res.json({
      region,
      currentValue,
      limit,
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
      unit: entry.unit || 'Count',
      label: (entry.name && entry.name.localizedValue) || 'Low Priority vCPUs'
    });
  } catch (err) {
    console.error('[api] /api/vm-quota failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/placement-scores', async (req, res) => {
  const { subscriptionId, region, desiredCount, desiredSizes, desiredLocations, availabilityZones } = req.body || {};
  if (!subscriptionId || !region || !Array.isArray(desiredSizes) || desiredSizes.length === 0) {
    return res.status(400).json({ error: 'subscriptionId, region, and desiredSizes are required.' });
  }

  try {
    const data = await armFetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/placementScores/spot/generate?api-version=${SCORE_API_VERSION}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          availabilityZones: availabilityZones !== false,
          desiredLocations: Array.isArray(desiredLocations) && desiredLocations.length > 0 ? desiredLocations : [region],
          desiredCount: Math.min(Math.max(desiredCount || DEFAULT_DESIRED_COUNT, 1), 10),
          desiredSizes
        })
      }
    );
    res.json(data);
  } catch (err) {
    console.error('[api] /api/placement-scores failed:', err.message);
    res.status(err.status || 500).send(err.message);
  }
});

// SPA fallback — any non-asset GET returns index.html so client-side routing works.
app.get(/^\/(?!healthz|api\/).*/, (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Spot VM Dashboard running on port ${PORT} (LOCAL_DEV=${LOCAL_DEV})`);
});
