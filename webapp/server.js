const express = require('express');
const { DefaultAzureCredential } = require('@azure/identity');
const path = require('path');

const app = express();
app.use(express.json());

// Serve Angular build output
app.use(express.static(path.join(__dirname, 'dist/spotvm-dashboard/browser')));

// --- Configuration ---

// Build the allowed-subscription list at startup.
// Priority:
//   1. AZURE_SUBSCRIPTIONS  — JSON array, e.g. '[{"id":"...","name":"Prod"}]' (multi-sub)
//   2. AZURE_SUBSCRIPTION_ID (+ optional AZURE_SUBSCRIPTION_NAME) — single sub
// Bicep injects AZURE_SUBSCRIPTION_ID/NAME with the subscription the web app is deployed into,
// so by default the dashboard queries its own hosting subscription. No code change needed to
// retarget — redeploy into a different subscription, or override the app settings in the portal.
function loadSubscriptions() {
  if (process.env.AZURE_SUBSCRIPTIONS) {
    try {
      const list = JSON.parse(process.env.AZURE_SUBSCRIPTIONS);
      if (Array.isArray(list) && list.length > 0) return list;
      console.warn('AZURE_SUBSCRIPTIONS env var is empty or not an array, ignoring');
    } catch (e) {
      console.warn('AZURE_SUBSCRIPTIONS env var is not valid JSON, ignoring:', e.message);
    }
  }
  if (process.env.AZURE_SUBSCRIPTION_ID) {
    return [{
      id: process.env.AZURE_SUBSCRIPTION_ID,
      name: process.env.AZURE_SUBSCRIPTION_NAME || process.env.AZURE_SUBSCRIPTION_ID
    }];
  }
  console.warn('No AZURE_SUBSCRIPTION_ID or AZURE_SUBSCRIPTIONS env var found — subscription list is empty. Set one of these in App Service configuration (or your shell for local dev).');
  return [];
}

const CONFIG = {
  subscriptions: loadSubscriptions(),
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
  defaultDesiredCount: 5
};

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

async function fetchAndCategorizeSkus() {
  if (skuFetchPromise) return skuFetchPromise;

  skuFetchPromise = (async () => {
    try {
      console.log('Fetching VM SKUs from Azure Resource SKUs API...');
      const cred = getCredential();
      const tokenResponse = await cred.getToken('https://management.azure.com/.default');
      const subId = CONFIG.subscriptions[0].id;

      const allSkus = [];
      let url = `https://management.azure.com/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=resourceType%20eq%20%27virtualMachines%27`;

      while (url) {
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${tokenResponse.token}` }
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

// GET /api/config — returns regions, SKU families, subscriptions for the UI dropdowns
app.get('/api/config', async (_req, res) => {
  const skuFamilies = await fetchAndCategorizeSkus();
  res.json({
    subscriptions: CONFIG.subscriptions,
    regions: CONFIG.regions,
    skuFamilies,
    defaultDesiredCount: CONFIG.defaultDesiredCount
  });
});

// POST /api/scores — fetches Spot Placement Scores for given parameters
// Body: { subscriptionId, region, skus: string[], desiredCount?: number }
// Streams NDJSON progress events back to the client
app.post('/api/scores', async (req, res) => {
  const { subscriptionId, region, skus, desiredCount } = req.body;

  if (!subscriptionId || !region || !Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'subscriptionId, region, and skus[] are required' });
  }

  // Validate subscriptionId is in allowed list
  const allowedSub = CONFIG.subscriptions.find(s => s.id === subscriptionId);
  if (!allowedSub) {
    return res.status(403).json({ error: 'Subscription not in allowed list' });
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
    const cred = getCredential();
    const tokenResponse = await cred.getToken('https://management.azure.com/.default');

    const count = Math.min(Math.max(desiredCount || CONFIG.defaultDesiredCount, 1), 10);
    const totalBatches = Math.ceil(skus.length / CONFIG.batchSize);

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 30000;

    // Fetch real eviction rates from Resource Graph in parallel with scoring
    const evictionMap = await fetchEvictionRates(tokenResponse.token, skus, region);

    send({ type: 'start', totalBatches, totalSkus: skus.length });

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
            'Authorization': `Bearer ${tokenResponse.token}`,
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
  // Pre-fetch SKU catalog in background
  fetchAndCategorizeSkus().catch(err => console.error('Background SKU fetch failed:', err.message));
});
