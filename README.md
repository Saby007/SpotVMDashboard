# Spot VM Placement Score Dashboard

Angular web app that queries the Azure Spot Placement Score API in real-time and displays results as a sortable table and heatmap — deployed on Azure App Service with Managed Identity.

## Architecture

```
┌─────────────────────────────────────┐
│  Angular 19 Frontend (browser)       │
│  Select region → click Get Scores    │
│  Live streaming progress + stop btn  │
└───────────┬─────────────────────────┘
            │ POST /api/scores (NDJSON stream)
            ▼
┌─────────────────────────────────────┐
│  Express Backend (App Service)       │
│  Managed Identity → ARM API          │
│  Dynamic SKU discovery (no cache)    │
│  Batches SKUs in groups of 5         │
│  Retry with backoff on 429           │
└──────┬────────────────┬─────────────┘
       │                │ POST resourcegraph/resources
       │                ▼
       │  ┌─────────────────────────────────┐
       │  │  Azure Resource Graph API        │
       │  │  Real eviction rates per SKU     │
       │  │  (last 28 days historical data)  │
       │  └─────────────────────────────────┘
       │ POST /placementScores/spot/generate
       ▼
┌─────────────────────────────────────┐
│  Spot Placement Score ARM API        │
│  Returns scores per SKU × AZ         │
│  Rate limit: ~hourly quota           │
└─────────────────────────────────────┘
```

## Features

- **Dynamic SKU discovery** — automatically fetches all Spot-capable VM SKUs from the Azure Resource SKUs API (no hardcoded list)
- **Real eviction rates** — per-SKU eviction percentages from Azure Resource Graph (last 28 days), shown in 5 granular buckets: 0-5%, 5-10%, 10-15%, 15-20%, 20+%
- **37 Azure regions** pre-configured
- **Real-time streaming** — see batch-by-batch progress, retry countdowns, and scores as they arrive
- **Sortable score table** with independent column sorting (SKU, Region, Zone, Score, Eviction Rate) + **heatmap view** with color-coded availability
- **Stop button** to cancel in-flight requests
- **429 rate limit handling** — exponential backoff with live countdown, auto-stops on hourly quota exhaustion
- **Light theme** UI with radar loading animation
- **No caching** — every request fetches fresh data from Azure APIs

## Prerequisites

- Azure CLI with Bicep support (`az bicep version` >= 0.25)
- Node.js 20+
- Permissions: Contributor on a resource group + User Access Administrator on target subscriptions

## Deployment

### Step 1: Deploy Infrastructure

```powershell
$RG = "rg-spotvm-dashboard"
$LOCATION = "centralindia"

# Create resource group (if needed)
az group create --name $RG --location $LOCATION

# Deploy App Service Plan + Web App
cd webapp/infra
az deployment group create `
  --resource-group $RG `
  --template-file webapp.bicep `
  --parameters webapp.bicepparam
```

Save the outputs — you'll need `webAppPrincipalId` for the next step.

### Step 2: Create Custom RBAC Role

The Spot Placement Score API requires `Microsoft.Compute/locations/placementScores/generate/action`, which isn't in any built-in role.

```powershell
# Use the subscription you're currently logged into (same one the web app will be deployed in by default)
$SUB_ID = az account show --query id -o tsv
$rolePath = "$env:TEMP\spot-role.json"

@{
  Name = "Spot Placement Score Reader"
  Description = "Can generate Spot VM Placement Scores"
  Actions = @("Microsoft.Compute/locations/placementScores/generate/action")
  NotActions = @()
  DataActions = @()
  NotDataActions = @()
  AssignableScopes = @("/subscriptions/$SUB_ID")
} | ConvertTo-Json -Depth 5 | Out-File $rolePath -Encoding utf8

az role definition create --role-definition $rolePath
```

> Only needed **once per subscription**. To make the role assignable across many subs at once, set `AssignableScopes` to a management-group scope instead.

### Step 3: Assign Roles to Web App Managed Identity

Two roles are required on **each subscription** the dashboard will query:

| Role | Type | Purpose |
|------|------|---------|
| **Reader** | Built-in | ARM API access |
| **Spot Placement Score Reader** | Custom | Generate placement scores |

```powershell
$PRINCIPAL_ID = "<webAppPrincipalId from Step 1>"
$SUB_ID = "<target-subscription-id>"

# Reader
az role assignment create `
  --assignee-object-id $PRINCIPAL_ID `
  --assignee-principal-type ServicePrincipal `
  --role "Reader" `
  --scope "/subscriptions/$SUB_ID"

# Spot Placement Score Reader
az role assignment create `
  --assignee-object-id $PRINCIPAL_ID `
  --assignee-principal-type ServicePrincipal `
  --role "Spot Placement Score Reader" `
  --scope "/subscriptions/$SUB_ID"
```

> RBAC propagation can take **up to 5 minutes**.

### Step 4: Build and Deploy App Code

You have two options. Use **Option A** if you just want to ship what's already in the repo; use **Option B** if you've modified code and need a fresh build.

#### Option A — Quick deploy using the pre-built `deploy.zip` (recommended)

A ready-to-deploy package (`deploy.zip`) is checked in at the repo root. It contains `server.js`, `package.json`, `package-lock.json`, the Angular source under `src/`, and the pre-built bundle under `dist/spotvm-dashboard/browser/`. On upload, App Service runs `npm install` (which triggers `postinstall` → `ng build`) so Angular is rebuilt on the host before `node server.js` starts.

```powershell
# From the repo root
az webapp deploy `
  --resource-group $RG `
  --name spotvm-hdfc-webapp `
  --src-path .\deploy.zip `
  --type zip --async true
```

> First deploy can take 3–5 minutes while Oryx installs dependencies and rebuilds Angular. Tail logs with:
> ```powershell
> az webapp log tail --resource-group $RG --name spotvm-hdfc-webapp
> ```

#### Option B — Build locally and create a fresh zip

Use this when you've changed `server.js`, the Angular source, or dependencies.

```powershell
cd webapp

# Build Angular
npx ng build

# Create deployment package (pre-built, no server-side build needed)
$deployDir = "$env:TEMP\spotvm-deploy"
if (Test-Path $deployDir) { Remove-Item $deployDir -Recurse -Force }
New-Item $deployDir -ItemType Directory | Out-Null
Copy-Item server.js, package-lock.json $deployDir
Copy-Item -Path dist -Destination "$deployDir\dist" -Recurse

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$pkg.scripts = [PSCustomObject]@{ start = 'node server.js'; build = 'echo skip' }
$pkg | ConvertTo-Json -Depth 10 | Out-File "$deployDir\package.json" -Encoding utf8

cd $deployDir
$zipPath = "$env:TEMP\spotvm-final.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
tar -acf $zipPath *

# Deploy
az webapp deploy `
  --resource-group $RG `
  --name spotvm-hdfc-webapp `
  --src-path $zipPath `
  --type zip --async true
```

### Step 5: Verify

```powershell
# Test API
Invoke-RestMethod -Uri "https://spotvm-hdfc-webapp.azurewebsites.net/api/config"

# Open dashboard
Start-Process "https://spotvm-hdfc-webapp.azurewebsites.net"
```

## Adding More Subscriptions

By default the dashboard queries **the subscription it is deployed in** — the Bicep template injects `AZURE_SUBSCRIPTION_ID` and `AZURE_SUBSCRIPTION_NAME` as App Service settings using the `subscription()` function, and `server.js` reads them at startup.

To query **additional** subscriptions (same tenant):

1. Grant both roles (Reader + Spot Placement Score Reader) to the webapp MI on each new subscription (repeat Step 3).
2. Override the subscription list via an App Service setting — set **`AZURE_SUBSCRIPTIONS`** to a JSON array (this takes precedence over `AZURE_SUBSCRIPTION_ID`):

   ```powershell
   $subsJson = '[{"id":"<sub-id-1>","name":"Prod"},{"id":"<sub-id-2>","name":"Dev"}]'
   az webapp config appsettings set `
     --resource-group $RG `
     --name spotvm-hdfc-webapp `
     --settings "AZURE_SUBSCRIPTIONS=$subsJson"
   ```

3. The app restarts automatically and the dropdown picks up the new list — **no code change or redeploy required**.

For subscriptions **in a different tenant**, use [Azure Lighthouse](https://learn.microsoft.com/en-us/azure/lighthouse/overview) to delegate access to your tenant's MI.

## Configuration

Edit `server.js` → `CONFIG` object to modify:

| Setting | Description |
|---------|-------------|
| `subscriptions` | Loaded at startup from `AZURE_SUBSCRIPTIONS` (JSON array) **or** `AZURE_SUBSCRIPTION_ID` (+ `AZURE_SUBSCRIPTION_NAME`) env vars — not hardcoded. Bicep injects the deploy subscription automatically. |
| `regions` | Azure regions to query |
| `skuFamilies` | Static fallback SKU families (used only if Azure Resource SKUs API is unavailable) |
| `batchSize` | SKUs per API call (max 5) |
| `apiVersion` | ARM API version (currently `2025-06-05`) |
| `defaultDesiredCount` | Default VM count for scoring (1–10) |

## Local Development

```powershell
cd webapp
npm install

# Tell the backend which subscription to query (same value you use for $SUB_ID above)
$env:AZURE_SUBSCRIPTION_ID = az account show --query id -o tsv
$env:AZURE_SUBSCRIPTION_NAME = az account show --query name -o tsv

# Terminal 1: Backend (port 8080)
node server.js

# Terminal 2: Angular dev server (port 4200, proxies /api to 8080)
npx ng serve --proxy-config proxy.conf.json
```

> Locally uses `DefaultAzureCredential` — authenticates via `az login`, VS Code, or environment variables.

## Files

```
SpotVMDashboard/
├── webapp/
│   ├── server.js                       # Express backend (Spot API proxy, ARG eviction rates, dynamic SKU discovery, NDJSON streaming)
│   ├── package.json                    # Node.js + Angular dependencies
│   ├── angular.json                    # Angular CLI config
│   ├── proxy.conf.json                 # Dev proxy config
│   ├── tsconfig.json                   # TypeScript config
│   ├── tsconfig.app.json               # App TypeScript config
│   ├── src/                            # Angular 19 frontend source
│   │   ├── index.html
│   │   ├── main.ts
│   │   ├── styles.css
│   │   └── app/
│   │       ├── app.component.ts        # Main dashboard component
│   │       ├── app.component.html      # Dashboard template
│   │       ├── app.component.css       # Light theme + radar animation
│   │       ├── app.config.ts           # Angular providers
│   │       ├── models/
│   │       │   └── spot-score.model.ts # TypeScript interfaces
│   │       └── services/
│   │           └── spot-score.service.ts # API service (NDJSON streaming)
│   └── infra/
│       ├── webapp.bicep                # App Service Bicep (Linux, Node 20, MI)
│       └── webapp.bicepparam           # Deployment parameters
└── README.md
```

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| **403 AuthorizationFailed** | Assign both Reader + Spot Placement Score Reader roles to the webapp MI on the target subscription |
| **429 Rate limited** | Hourly API quota exhausted — wait ~60 minutes, or select fewer SKU families |
| **429 with short retry** | Per-request throttle — the app retries automatically with backoff |
| **500 on /api/scores** | Check App Service logs: `az webapp log tail --resource-group $RG --name spotvm-hdfc-webapp` |
| **Blank page** | Verify Angular build output exists in `dist/spotvm-dashboard/browser/` |
| **API version error** | Ensure `CONFIG.apiVersion` in server.js matches a supported version (`2025-06-05`) |
