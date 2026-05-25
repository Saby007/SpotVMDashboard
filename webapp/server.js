const express = require('express');
const { DefaultAzureCredential } = require('@azure/identity');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const path = require('path');

const app = express();
app.use(express.json());

// Serve Angular build output
app.use(express.static(path.join(__dirname, 'dist/spotvm-dashboard/browser')));

// --- Entra ID auth configuration ---
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const APP_CLIENT_ID = process.env.ENTRA_APP_CLIENT_ID;
if (!TENANT_ID || !APP_CLIENT_ID) {
  console.warn('ENTRA_TENANT_ID / ENTRA_APP_CLIENT_ID not set — /api/* will reject all requests until configured.');
}
const JWKS = TENANT_ID
  ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`))
  : null;
const EXPECTED_ISSUER = TENANT_ID ? `https://login.microsoftonline.com/${TENANT_ID}/v2.0` : null;
const EXPECTED_AUDIENCE = APP_CLIENT_ID ? `api://${APP_CLIENT_ID}` : null;

// Bearer-token middleware. On success attaches { oid, name, upn, assertion } to req.user.
async function requireAuth(req, res, next) {
  if (!JWKS) {
    return res.status(503).json({ error: 'Server auth not configured (missing ENTRA_TENANT_ID / ENTRA_APP_CLIENT_ID).' });
  }
  const authz = req.headers.authorization || '';
  if (!authz.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' });
  }
  const token = authz.slice(7).trim();
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE
    });
    req.user = {
      oid: payload.oid,
      name: payload.name,
      upn: payload.preferred_username || payload.upn || payload.email,
      assertion: token
    };
    next();
  } catch (err) {
    console.warn('JWT validation failed:', err.message);
    return res.status(401).json({ error: 'Invalid token: ' + err.message });
  }
}

// --- On-Behalf-Of token exchange (MI federated credential -> ARM token as user) ---
// Cache: oid -> { token, expiresAt }
const oboTokenCache = new Map();
const OBO_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

async function getMiClientAssertion() {
  // Use the web app's system-assigned MI to mint a token for api://AzureADTokenExchange.
  // The app registration trusts this MI via a federated identity credential.
  const cred = getCredential();
  const tok = await cred.getToken('api://AzureADTokenExchange');
  if (!tok || !tok.token) throw new Error('Failed to acquire MI assertion');
  return tok.token;
}

async function getArmTokenForUser(req) {
  const oid = req.user && req.user.oid;
  if (!oid) throw new Error('No oid on request');
  const cached = oboTokenCache.get(oid);
  if (cached && cached.expiresAt - Date.now() > OBO_REFRESH_SKEW_MS) {
    return cached.token;
  }
  const clientAssertion = await getMiClientAssertion();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: APP_CLIENT_ID,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
    assertion: req.user.assertion,
    scope: 'https://management.azure.com/.default',
    requested_token_use: 'on_behalf_of'
  });
  const resp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`OBO token exchange failed: HTTP ${resp.status}: ${text}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  const data = await resp.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  oboTokenCache.set(oid, { token: data.access_token, expiresAt });
  return data.access_token;
}

// --- Configuration ---
// Subscriptions are no longer configured here — they are enumerated per signed-in user
// via the ARM /subscriptions endpoint using the user's OBO token. Azure RBAC on the
// subscription is the source of truth for what each user can see and query.

const CONFIG = {
  regions: [
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
  ],
  skuFamilies: {
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
    ],
    'General Purpose - Ddsv5': [
      'Standard_D2ds_v5', 'Standard_D4ds_v5', 'Standard_D8ds_v5', 'Standard_D16ds_v5',
      'Standard_D32ds_v5', 'Standard_D48ds_v5', 'Standard_D64ds_v5', 'Standard_D96ds_v5'
    ],
    'General Purpose - Dasv5': [
      'Standard_D2as_v5', 'Standard_D4as_v5', 'Standard_D8as_v5', 'Standard_D16as_v5',
      'Standard_D32as_v5', 'Standard_D48as_v5', 'Standard_D64as_v5', 'Standard_D96as_v5'
    ],
    'General Purpose - Dadsv5': [
      'Standard_D2ads_v5', 'Standard_D4ads_v5', 'Standard_D8ads_v5', 'Standard_D16ads_v5',
      'Standard_D32ads_v5', 'Standard_D48ads_v5', 'Standard_D64ads_v5', 'Standard_D96ads_v5'
    ],
    'General Purpose - Dsv4': [
      'Standard_D2s_v4', 'Standard_D4s_v4', 'Standard_D8s_v4', 'Standard_D16s_v4',
      'Standard_D32s_v4', 'Standard_D48s_v4', 'Standard_D64s_v4'
    ],
    'General Purpose - Ddsv4': [
      'Standard_D2ds_v4', 'Standard_D4ds_v4', 'Standard_D8ds_v4', 'Standard_D16ds_v4',
      'Standard_D32ds_v4', 'Standard_D48ds_v4', 'Standard_D64ds_v4'
    ],
    'General Purpose - Dasv4': [
      'Standard_D2as_v4', 'Standard_D4as_v4', 'Standard_D8as_v4', 'Standard_D16as_v4',
      'Standard_D32as_v4', 'Standard_D48as_v4', 'Standard_D64as_v4', 'Standard_D96as_v4'
    ],
    'General Purpose - Dpsv5 (ARM)': [
      'Standard_D2ps_v5', 'Standard_D4ps_v5', 'Standard_D8ps_v5', 'Standard_D16ps_v5',
      'Standard_D32ps_v5', 'Standard_D48ps_v5', 'Standard_D64ps_v5'
    ],
    'General Purpose - Dpdsv5 (ARM)': [
      'Standard_D2pds_v5', 'Standard_D4pds_v5', 'Standard_D8pds_v5', 'Standard_D16pds_v5',
      'Standard_D32pds_v5', 'Standard_D48pds_v5', 'Standard_D64pds_v5'
    ],
    'General Purpose - Dlsv5': [
      'Standard_D2ls_v5', 'Standard_D4ls_v5', 'Standard_D8ls_v5', 'Standard_D16ls_v5',
      'Standard_D32ls_v5', 'Standard_D48ls_v5', 'Standard_D64ls_v5', 'Standard_D96ls_v5'
    ],
    'Compute Optimized - Fsv2': [
      'Standard_F2s_v2', 'Standard_F4s_v2', 'Standard_F8s_v2', 'Standard_F16s_v2',
      'Standard_F32s_v2', 'Standard_F48s_v2', 'Standard_F64s_v2', 'Standard_F72s_v2'
    ],
    'Memory Optimized - Esv5': [
      'Standard_E2s_v5', 'Standard_E4s_v5', 'Standard_E8s_v5', 'Standard_E16s_v5',
      'Standard_E20s_v5', 'Standard_E32s_v5', 'Standard_E48s_v5', 'Standard_E64s_v5',
      'Standard_E96s_v5', 'Standard_E104s_v5'
    ],
    'Memory Optimized - Edsv5': [
      'Standard_E2ds_v5', 'Standard_E4ds_v5', 'Standard_E8ds_v5', 'Standard_E16ds_v5',
      'Standard_E20ds_v5', 'Standard_E32ds_v5', 'Standard_E48ds_v5', 'Standard_E64ds_v5',
      'Standard_E96ds_v5', 'Standard_E104ds_v5'
    ],
    'Memory Optimized - Easv5': [
      'Standard_E2as_v5', 'Standard_E4as_v5', 'Standard_E8as_v5', 'Standard_E16as_v5',
      'Standard_E20as_v5', 'Standard_E32as_v5', 'Standard_E48as_v5', 'Standard_E64as_v5',
      'Standard_E96as_v5'
    ],
    'Memory Optimized - Eadsv5': [
      'Standard_E2ads_v5', 'Standard_E4ads_v5', 'Standard_E8ads_v5', 'Standard_E16ads_v5',
      'Standard_E20ads_v5', 'Standard_E32ads_v5', 'Standard_E48ads_v5', 'Standard_E64ads_v5',
      'Standard_E96ads_v5'
    ],
    'Memory Optimized - Esv4': [
      'Standard_E2s_v4', 'Standard_E4s_v4', 'Standard_E8s_v4', 'Standard_E16s_v4',
      'Standard_E20s_v4', 'Standard_E32s_v4', 'Standard_E48s_v4', 'Standard_E64s_v4'
    ],
    'Memory Optimized - Edsv4': [
      'Standard_E2ds_v4', 'Standard_E4ds_v4', 'Standard_E8ds_v4', 'Standard_E16ds_v4',
      'Standard_E20ds_v4', 'Standard_E32ds_v4', 'Standard_E48ds_v4', 'Standard_E64ds_v4'
    ],
    'Memory Optimized - Easv4': [
      'Standard_E2as_v4', 'Standard_E4as_v4', 'Standard_E8as_v4', 'Standard_E16as_v4',
      'Standard_E20as_v4', 'Standard_E32as_v4', 'Standard_E48as_v4', 'Standard_E64as_v4',
      'Standard_E96as_v4'
    ],
    'Memory Optimized - Epsv5 (ARM)': [
      'Standard_E2ps_v5', 'Standard_E4ps_v5', 'Standard_E8ps_v5', 'Standard_E16ps_v5',
      'Standard_E32ps_v5'
    ],
    'Memory Optimized - Epdsv5 (ARM)': [
      'Standard_E2pds_v5', 'Standard_E4pds_v5', 'Standard_E8pds_v5', 'Standard_E16pds_v5',
      'Standard_E32pds_v5'
    ],
    'Storage Optimized - Lsv3': [
      'Standard_L8s_v3', 'Standard_L16s_v3', 'Standard_L32s_v3',
      'Standard_L48s_v3', 'Standard_L64s_v3', 'Standard_L80s_v3'
    ],
    'Storage Optimized - Lasv3': [
      'Standard_L8as_v3', 'Standard_L16as_v3', 'Standard_L32as_v3',
      'Standard_L48as_v3', 'Standard_L64as_v3', 'Standard_L80as_v3'
    ],
    'GPU - NCv3': [
      'Standard_NC6s_v3', 'Standard_NC12s_v3', 'Standard_NC24s_v3', 'Standard_NC24rs_v3'
    ],
    'GPU - NCas T4 v3': [
      'Standard_NC4as_T4_v3', 'Standard_NC8as_T4_v3', 'Standard_NC16as_T4_v3', 'Standard_NC64as_T4_v3'
    ],
    'GPU - NVads A10 v5': [
      'Standard_NV6ads_A10_v5', 'Standard_NV12ads_A10_v5', 'Standard_NV18ads_A10_v5',
      'Standard_NV36ads_A10_v5', 'Standard_NV72ads_A10_v5'
    ],
    'GPU - NVs v3': [
      'Standard_NV12s_v3', 'Standard_NV24s_v3', 'Standard_NV48s_v3'
    ],
    'GPU - NCads A100 v4': [
      'Standard_NC24ads_A100_v4', 'Standard_NC48ads_A100_v4', 'Standard_NC96ads_A100_v4'
    ],
    'A-series v2': [
      'Standard_A1_v2', 'Standard_A2_v2', 'Standard_A4_v2', 'Standard_A8_v2',
      'Standard_A2m_v2', 'Standard_A4m_v2', 'Standard_A8m_v2'
    ]
  },
  apiVersion: '2025-06-05',
  batchSize: 5,
  defaultDesiredCount: 5,
  // Spot Placement Score API has an undocumented per-subscription hourly cap (~100 calls).
  // We track calls locally and surface usage as a % to the UI so users can self-throttle.
  // Override via env var if Microsoft raises/lowers the limit, or to be more conservative.
  spotApiHourlyQuota: parseInt(process.env.SPOT_API_HOURLY_QUOTA || '100', 10)
};

// --- API quota tracker (in-memory, per subscription, rolling 1-hour window) ---
// Map<subscriptionId, { count: number, windowStartMs: number }>
const apiQuotaTracker = new Map();
const QUOTA_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getQuotaSnapshot(subscriptionId) {
  const now = Date.now();
  let entry = apiQuotaTracker.get(subscriptionId);
  if (!entry || (now - entry.windowStartMs) >= QUOTA_WINDOW_MS) {
    entry = { count: 0, windowStartMs: now };
    apiQuotaTracker.set(subscriptionId, entry);
  }
  const used = entry.count;
  const max = CONFIG.spotApiHourlyQuota;
  const remaining = Math.max(0, max - used);
  const percentRemaining = Math.max(0, Math.min(100, Math.round((remaining / max) * 100)));
  const resetsInSec = Math.max(0, Math.ceil((entry.windowStartMs + QUOTA_WINDOW_MS - now) / 1000));
  return { used, max, remaining, percentRemaining, resetsInSec };
}

function recordApiCall(subscriptionId) {
  // Touch the snapshot first so a stale window is rolled over before incrementing.
  getQuotaSnapshot(subscriptionId);
  const entry = apiQuotaTracker.get(subscriptionId);
  entry.count += 1;
  return getQuotaSnapshot(subscriptionId);
}

// --- Spot (low-priority) VM core quota lookup for a region ---
// Calls Microsoft.Compute usages API and returns the lowPriorityCores entry, which is the
// per-region pool of vCPUs available for Spot VMs (shared across all SKUs in that region).
// Returns null if the call fails or the entry is not found in the response.
async function fetchSpotVmQuota(token, subscriptionId, region) {
  try {
    const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=2024-07-01`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      console.warn(`Spot quota lookup failed for ${region}: HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    const entry = (data.value || []).find(u => (u.name && u.name.value || '').toLowerCase() === 'lowprioritycores');
    if (!entry) return null;
    const currentValue = entry.currentValue || 0;
    const limit = entry.limit || 0;
    const percentUsed = limit > 0 ? Math.round((currentValue / limit) * 100) : 0;
    const percentRemaining = Math.max(0, 100 - percentUsed);
    return {
      region,
      currentValue,
      limit,
      percentUsed,
      percentRemaining,
      unit: entry.unit || 'Count',
      label: (entry.name && entry.name.localizedValue) || 'Low Priority vCPUs'
    };
  } catch (err) {
    console.warn(`Spot quota lookup error for ${region}:`, err.message);
    return null;
  }
}

// Cache credential instance (thread-safe, handles token refresh internally)
let credential = null;
function getCredential() {
  if (!credential) {
    credential = new DefaultAzureCredential();
  }
  return credential;
}

// --- Dynamic SKU discovery from Azure ---

const VM_FAMILY_PREFIXES = ['NC', 'ND', 'NV', 'NP', 'NM', 'NG', 'HB', 'HC', 'HX', 'DC', 'EC', 'FX'];

function parseFamilyCode(familyCode) {
  let raw = familyCode
    .replace(/^standard/i, '')
    .replace(/Family$/i, '')
    .replace(/Promo$/i, '');
  if (!raw) return { category: 'General purpose', series: 'Other-series' };

  // Determine category from leading letter(s)
  const upper = raw.toUpperCase();
  let category;
  if (upper.startsWith('N')) category = 'GPU';
  else if (upper.startsWith('H')) category = 'High performance compute';
  else if (upper.startsWith('L')) category = 'Storage optimized';
  else if (upper.startsWith('M')) category = 'Memory optimized';
  else if (upper.startsWith('E')) category = 'Memory optimized';
  else if (upper.startsWith('F')) category = 'Compute optimized';
  else category = 'General purpose';

  // Format series name: keep multi-letter VM prefix uppercase, lowercase the rest
  let prefixLen = 1;
  for (const p of VM_FAMILY_PREFIXES) {
    if (upper.startsWith(p)) { prefixLen = p.length; break; }
  }
  const prefix = raw.substring(0, prefixLen).toUpperCase();
  const rest = raw.substring(prefixLen).toLowerCase();
  const series = prefix + rest + '-series';

  return { category, series };
}

let skuFetchPromise = null;
let skuCatalogCache = null;

async function fetchAndCategorizeSkus(armToken, subId) {
  if (skuCatalogCache) return skuCatalogCache;
  if (skuFetchPromise) return skuFetchPromise;
  if (!armToken || !subId) return CONFIG.skuFamilies; // fallback if called without auth context

  skuFetchPromise = (async () => {
    try {
      console.log('Fetching VM SKUs from Azure Resource SKUs API...');

      const allSkus = [];
      let url = `https://management.azure.com/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=resourceType%20eq%20%27virtualMachines%27`;

      while (url) {
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${armToken}` }
        });
        if (!resp.ok) throw new Error(`Resource SKUs API ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        allSkus.push(...(data.value || []));
        url = data.nextLink || null;
      }

      console.log(`Fetched ${allSkus.length} VM SKU entries`);

      // Keep only Spot-capable VMs
      const spotCapable = allSkus.filter(sku => {
        const cap = (sku.capabilities || []).find(c => c.name === 'LowPriorityCapable');
        return cap && cap.value === 'True';
      });

      // Group by family → unique SKU names
      const familyMap = new Map();
      for (const sku of spotCapable) {
        const fam = sku.family || 'unknownFamily';
        if (!familyMap.has(fam)) familyMap.set(fam, new Set());
        familyMap.get(fam).add(sku.name);
      }

      // Build "Category - Series" → sorted SKU name array
      const result = {};
      for (const [code, skuSet] of familyMap) {
        const { category, series } = parseFamilyCode(code);
        const key = `${category} - ${series}`;
        if (result[key]) {
          for (const s of skuSet) result[key].push(s);
          result[key] = [...new Set(result[key])].sort();
        } else {
          result[key] = [...skuSet].sort();
        }
      }

      // Return keys in sorted order
      const sorted = {};
      for (const k of Object.keys(result).sort()) sorted[k] = result[k];

      const total = Object.values(sorted).reduce((n, a) => n + a.length, 0);
      console.log(`Organized ${total} Spot-capable SKUs into ${Object.keys(sorted).length} series`);

      skuCatalogCache = sorted;
      return sorted;
    } catch (err) {
      console.error('SKU fetch failed, using static fallback:', err.message);
      return CONFIG.skuFamilies;
    } finally {
      skuFetchPromise = null;
    }
  })();

  return skuFetchPromise;
}

// --- API Routes ---

// Fetch eviction rates from Azure Resource Graph for a given region + SKU list
async function fetchEvictionRates(token, skus, region) {
  const evictionMap = {}; // sku → eviction rate string e.g. "5-10"
  try {
    const query = `SpotResources
| where type =~ 'microsoft.compute/skuspotevictionrate/location'
| where location =~ '${region}'
| project skuName = tostring(sku.name), location, spotEvictionRate = tostring(properties.evictionRate)`;

    const resp = await fetch('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (resp.ok) {
      const data = await resp.json();
      for (const row of (data.data || [])) {
        const name = (row.skuName || '').toLowerCase();
        evictionMap[name] = row.spotEvictionRate || 'N/A';
      }
      console.log(`Fetched eviction rates for ${Object.keys(evictionMap).length} SKUs in ${region}`);
    } else {
      console.warn(`Resource Graph eviction rate query failed: ${resp.status}`);
    }
  } catch (err) {
    console.warn('Eviction rate fetch error:', err.message);
  }
  return evictionMap;
}

// GET /api/me — returns the signed-in user (used by Angular to show name/initials).
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ oid: req.user.oid, name: req.user.name, upn: req.user.upn });
});

// GET /api/subscriptions — returns subscriptions the signed-in user has RBAC access to.
app.get('/api/subscriptions', requireAuth, async (req, res) => {
  try {
    const armToken = await getArmTokenForUser(req);
    const resp = await fetch('https://management.azure.com/subscriptions?api-version=2022-12-01', {
      headers: { 'Authorization': `Bearer ${armToken}` }
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `ARM /subscriptions failed: ${text}` });
    }
    const data = await resp.json();
    const subs = (data.value || [])
      .filter(s => s.state === 'Enabled' || s.state === 'PastDue' || !s.state)
      .map(s => ({ id: s.subscriptionId, name: s.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(subs);
  } catch (err) {
    console.error('Subscriptions lookup failed:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/config — returns regions + SKU families (subscriptions now come from /api/subscriptions).
app.get('/api/config', requireAuth, async (req, res) => {
  let skuFamilies = CONFIG.skuFamilies;
  try {
    const armToken = await getArmTokenForUser(req);
    // Need *some* subscription to query the SKUs catalog — grab the first the user can see.
    const subResp = await fetch('https://management.azure.com/subscriptions?api-version=2022-12-01', {
      headers: { 'Authorization': `Bearer ${armToken}` }
    });
    if (subResp.ok) {
      const subData = await subResp.json();
      const firstSub = (subData.value || []).find(s => s.subscriptionId);
      if (firstSub) {
        skuFamilies = await fetchAndCategorizeSkus(armToken, firstSub.subscriptionId);
      }
    }
  } catch (err) {
    console.warn('Config SKU fetch fell back to static:', err.message);
  }
  res.json({
    regions: CONFIG.regions,
    skuFamilies,
    defaultDesiredCount: CONFIG.defaultDesiredCount
  });
});

// GET /api/quota — legacy local Spot API quota tracker (still exposed but no longer auto-polled by UI).
app.get('/api/quota', requireAuth, (req, res) => {
  const subscriptionId = req.query.subscriptionId;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId query parameter is required' });
  }
  res.json({ apiName: 'Spot Placement Score API', ...getQuotaSnapshot(subscriptionId) });
});

// POST /api/scores — fetches Spot Placement Scores for given parameters
// Body: { subscriptionId, region, skus: string[], desiredCount?: number }
// Streams NDJSON progress events back to the client. Azure RBAC on the subscription
// (enforced via the user's OBO token) is the source of truth for what the user can query.
app.post('/api/scores', requireAuth, async (req, res) => {
  const { subscriptionId, region, skus, desiredCount } = req.body;

  if (!subscriptionId || !region || !Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'subscriptionId, region, and skus[] are required' });
  }

  // Validate region is in allowed list
  if (!CONFIG.regions.includes(region)) {
    return res.status(403).json({ error: 'Region not in allowed list' });
  }

  // Stream NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify(event) + '\n');
    }
  };

  try {
    const armToken = await getArmTokenForUser(req);

    const count = Math.min(Math.max(desiredCount || CONFIG.defaultDesiredCount, 1), 10);
    const totalBatches = Math.ceil(skus.length / CONFIG.batchSize);

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 30000;

    // Fetch real eviction rates from Resource Graph in parallel with scoring
    const evictionMap = await fetchEvictionRates(armToken, skus, region);

    send({ type: 'start', totalBatches, totalSkus: skus.length });
    // Emit initial quota snapshot so the UI shows current usage even before the first batch
    send({ type: 'quota', apiName: 'Spot Placement Score API', ...getQuotaSnapshot(subscriptionId) });

    // Look up regional Spot vCPU pool quota (best-effort; won't block scoring if it fails)
    const vmQuota = await fetchSpotVmQuota(armToken, subscriptionId, region);
    if (vmQuota) {
      send({ type: 'vmQuota', ...vmQuota });
    }

    for (let i = 0; i < skus.length; i += CONFIG.batchSize) {
      if (res.writableEnded) break; // client disconnected

      const batchIndex = Math.floor(i / CONFIG.batchSize);
      const batch = skus.slice(i, i + CONFIG.batchSize);

      send({ type: 'batch', batchIndex, totalBatches, skus: batch });

      const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/placementScores/spot/generate?api-version=${CONFIG.apiVersion}`;

      const payload = {
        availabilityZones: true,
        desiredLocations: [region],
        desiredCount: count,
        desiredSizes: batch.map(sku => ({ sku }))
      };

      let success = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${armToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const data = await response.json();
          const scores = (data.placementScores || []).map(s => ({
            ...s,
            evictionRate: evictionMap[(s.sku || '').toLowerCase()] || 'N/A'
          }));
          send({ type: 'scores', batchIndex, count: scores.length, scores });
          // Record the call against our quota budget and broadcast the new snapshot
          const snap = recordApiCall(subscriptionId);
          send({ type: 'quota', apiName: 'Spot Placement Score API', ...snap });
          success = true;
          break;
        } else if (response.status === 429) {
          // Parse wait time from body or Retry-After header
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
            // Hourly quota exhausted — no point retrying
            send({ type: 'error', batchIndex, status: 429, message: `Rate limit reached — try again in ${Math.ceil(waitSec / 60)} minutes`, skus: batch });
            send({ type: 'done', timestamp: new Date().toISOString() });
            res.end();
            return;
          }

          if (attempt < MAX_RETRIES) {
            send({ type: 'retry', batchIndex, attempt: attempt + 1, maxRetries: MAX_RETRIES, delaySec: waitSec, skus: batch });
            console.warn(`429 on batch ${batchIndex} [${batch.join(',')}] — retry ${attempt + 1}/${MAX_RETRIES} after ${waitSec}s`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
          } else {
            send({ type: 'error', batchIndex, status: 429, message: 'Rate limited after all retries', skus: batch });
          }
        } else {
          const text = await response.text();
          send({ type: 'error', batchIndex, status: response.status, message: text, skus: batch });
          break;
        }
      }

      // 3s delay between batches
      if (i + CONFIG.batchSize < skus.length) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    send({ type: 'done', timestamp: new Date().toISOString() });
    res.end();
  } catch (err) {
    console.error('Error fetching scores:', err);
    send({ type: 'fatal', message: err.message });
    res.end();
  }
});

// SPA fallback — serve Angular index.html for all non-API routes
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist/spotvm-dashboard/browser/index.html'));
});

// --- Start Server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Spot VM Dashboard server running on port ${PORT}`);
  // SKU catalog is now fetched on-demand using the first authenticated user's OBO token.
});
