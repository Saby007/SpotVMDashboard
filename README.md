# Spot VM Placement Score Dashboard

Angular SPA that queries the Azure Spot Placement Score API in real-time using the **signed-in user's own Azure RBAC** — deployed on Azure App Service as a static SPA + thin Node host. No managed identity, no server-side secrets, no backend ARM calls.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Angular 19 SPA (browser)                     │
│  • MSAL PKCE → Entra ID                       │
│  • Acquires ARM token for the user            │
│  • Calls management.azure.com directly        │
│  • Streams scores, retries 429, etc.          │
└─────┬──────────────────┬──────────────────┬──┘
      │                  │                  │
      │ GET /subs        │ POST resource-   │ POST /placementScores
      │ GET /skus        │ graph/resources  │ /spot/generate
      │ GET /usages      │                  │
      ▼                  ▼                  ▼
┌────────────────────────────────────────────────┐
│  Azure Resource Manager (management.azure.com)  │
│  All calls authenticated with the USER's token  │
│  (delegated ARM user_impersonation scope).      │
│  Azure RBAC on the user gates every read.       │
└────────────────────────────────────────────────┘

         App Service only serves static files
         (Angular bundle + /healthz). It is not
         in the auth or data path.
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

- Azure CLI 2.55+
- Node.js 20+
- For deployment: `Contributor` on the resource group that hosts the App Service
- For Entra app registration: ability to create an app registration in the target tenant (any user can do this unless the tenant has disabled it)
- For each end-user: **`Reader`** role at subscription scope on whichever subscriptions they need to see (see [Authentication & Authorization](#authentication--authorization))

## Authentication & Authorization

This is the trickiest part of the project, so the full story is documented here.

### How auth actually works

1. The user opens the SPA and clicks **Sign in**.
2. MSAL.js redirects to Entra ID using **Authorization Code + PKCE** (no client secret — SPAs cannot keep one).
3. Entra returns an ID token and an access token scoped to **`https://management.azure.com/user_impersonation`** (ARM's built-in delegated permission).
4. The Angular HTTP interceptor automatically attaches that bearer token to every call to `https://management.azure.com/*`.
5. ARM enforces normal **Azure RBAC** on the user — the dashboard sees exactly the subscriptions/regions/SKUs the user can see, and nothing more.

There is no server-side token exchange, no on-behalf-of (OBO), no managed identity, no custom Web API scope. The Node process on App Service only serves the static Angular bundle and a `/healthz` probe.

### What each user needs (RBAC)

| ARM call the app makes                              | Minimum role on the subscription |
| --------------------------------------------------- | -------------------------------- |
| `GET /subscriptions`                                | (any role; none needed beyond directory membership) |
| `GET .../Microsoft.Compute/skus`                    | **Reader** |
| `GET .../locations/{region}/usages` (spot quota)    | **Reader** |
| `POST providers/Microsoft.ResourceGraph/resources`  | **Reader** |
| `POST .../locations/{region}/placementScores/spot/generate` | **Reader** (this is a read-only data action even though it's POST) |

**Bottom line: `Reader` at subscription scope is sufficient for the entire dashboard.** No custom role and no Owner/Contributor needed. RBAC propagation can take up to 5 minutes; token refresh ~1 hour (sign out / sign in for immediate effect).

### Tenant complexities — the part that bit us

ARM's `user_impersonation` is a **delegated permission marked "user-consentable"**, which in a default Entra tenant means each user can self-consent on first sign-in. In practice many enterprise tenants tighten that policy and you hit one of these:

| Symptom                                                              | Root cause                                                                                                  | Fix                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in shows **"Need admin approval"** with a *Request approval* button | Tenant **User consent settings** = *Do not allow user consent* (or *Allow user consent for verified publishers only* and the app reg is not from a verified publisher) | A tenant admin grants tenant-wide consent **once** (Entra portal → Enterprise applications → the app → Permissions → *Grant admin consent*), or an admin approves the user's request                          |
| **AADSTS50020 / AADSTS90072** — *user account does not exist in the tenant* | App reg is single-tenant in tenant A, user is from tenant B                                                  | Either register the app in the user's tenant, or convert the app reg to multi-tenant (`signInAudience = AzureADMultipleOrgs`) and use authority `https://login.microsoftonline.com/organizations`            |
| Sign-in succeeds but **`getSubscriptions()` returns `[]`**          | User has no role assignment on any subscription in this tenant                                              | Assign `Reader` at subscription scope to the user                                                                                                                                                            |
| **AADSTS65001** — *consent_required* after a clean cache             | Token cache is stale or scopes changed                                                                      | Clear `localStorage` for the site and sign in again                                                                                                                                                          |

### Why the app is currently pointed at a personal tenant

During development the app reg lived in the Microsoft corporate tenant. MS-corp's policy blocks user consent for third-party / new apps, so every test user got the *"Need admin approval"* screen. To unblock end-to-end testing without filing an admin-consent ticket, the app reg was re-created in a personal Microsoft tenant where the default consent policy applies. The two IDs are kept in [`webapp/src/app/auth.config.ts`](webapp/src/app/auth.config.ts) — change them to point at any other tenant; no other code changes are needed.

```ts
export const ENTRA_TENANT_ID    = '780a4ea6-63fc-43dd-8d57-764f0db161ed'; // personal test tenant
export const ENTRA_APP_CLIENT_ID = '5ce73c51-046b-492d-89c6-66517b817e63';
```

### Single-tenant vs multi-tenant

| Option                                                       | Pro                                                                                          | Con                                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Single-tenant (current)** — `signInAudience: AzureADMyOrg` | Simplest; one consent decision; users from other tenants are blocked outright (good if HDFC wants strict isolation) | Must register a separate app per tenant (or move the registration); other tenants cannot use it                                                  |
| **Multi-tenant** — `signInAudience: AzureADMultipleOrgs` + authority `/organizations` | A single app reg works for HDFC + personal + MS-corp + any other tenant; each tenant's first user (or admin) self-consents into *their* tenant   | The host tenant of the app reg sees the app under "Enterprise applications" in every consenting tenant; some orgs treat this as a vendor relationship and require review |

### Entra app registration checklist (whichever tenant you choose)

1. **Create** the app registration (display name of your choice; `signInAudience` per the table above).
2. **Platform: SPA** — add redirect URIs (`spa.redirectUris`, *not* `web.redirectUris` — Entra blocks implicit-flow tokens on Web platform):
   - `https://<your-app>.azurewebsites.net/`
   - `http://localhost:4200/` (for local dev)
3. **API permission** — add **delegated** `Azure Service Management → user_impersonation` (resource app `797f4846-ba00-4fd7-ba43-dac1f8f63013`, scope id `41094075-9dad-400e-a0bd-54e686782033`).
4. Decide on consent: either let users self-consent (default tenant policy), or have a tenant admin **Grant admin consent for `<tenant>`** once.
5. Copy the **Application (client) ID** and **Directory (tenant) ID** into `webapp/src/app/auth.config.ts`, rebuild, redeploy.

Reference scripted setup (single-tenant; mirrors what the SPA expects):

```powershell
# Run while signed into the target tenant
$app = az ad app create `
  --display-name "SpotVMDashboard" `
  --sign-in-audience AzureADMyOrg `
  --query "{appId:appId, id:id}" -o json | ConvertFrom-Json

# SPA redirects (Graph PATCH; az ad app does not expose 'spa' directly)
$body = @{ spa = @{ redirectUris = @(
  "https://<your-app>.azurewebsites.net/",
  "http://localhost:4200/"
) } } | ConvertTo-Json -Depth 5
$tmp = "$env:TEMP\spa-patch.json"
$body | Out-File $tmp -Encoding utf8
az rest --method PATCH `
  --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" `
  --headers "Content-Type=application/json" `
  --body "@$tmp"

# ARM user_impersonation
az ad app permission add `
  --id $app.appId `
  --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 `
  --api-permissions "41094075-9dad-400e-a0bd-54e686782033=Scope"
```

## Deployment

### Step 1: Provision the App Service

```powershell
$RG = "rg-spotvm-dashboard"
$LOCATION = "centralindia"

az group create --name $RG --location $LOCATION

cd webapp/infra
az deployment group create `
  --resource-group $RG `
  --template-file webapp.bicep `
  --parameters webapp.bicepparam
```

> The Bicep still provisions a system-assigned managed identity for backward compatibility, but the current SPA-only code does not use it. You can remove that block from `webapp.bicep` if you want a strictly minimal footprint.

### Step 2: Create / configure the Entra app registration

See [Entra app registration checklist](#entra-app-registration-checklist-whichever-tenant-you-choose) above. Make sure the App Service hostname is in `spa.redirectUris` **before** the first sign-in.

### Step 3: Build and deploy the SPA

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

#### Option A — Quick deploy using the pre-built `deploy.zip`

A ready-to-deploy package (`deploy.zip`) is committed at the repo root. It contains the pre-built Angular bundle under `dist/spotvm-dashboard/browser/`, plus `server.js`, `package.json`, `package-lock.json`, and `node_modules`. On upload App Service just runs `node server.js` — no on-host build.

```powershell
az webapp deploy `
  --resource-group $RG `
  --name spotvm-hdfc-webapp `
  --src-path .\deploy.zip `
  --type zip --timeout 900
```

> If OneDrive holds a lock on `deploy.zip`, copy it to `$env:TEMP\spotvm-deploy.zip` first and deploy from there.

#### Option B — Build locally and create a fresh zip

Do this whenever you change Angular source, `server.js`, or any constants in `auth.config.ts`.

```powershell
cd webapp
npm install
npm run build           # writes dist/spotvm-dashboard/browser/main-<hash>.js

# Stage outside OneDrive to avoid file locks
$stage = "$env:TEMP\spotvm-zip-stage"
New-Item $stage -ItemType Directory -Force | Out-Null
robocopy .\dist        "$stage\dist" /E /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item -Force server.js, package.json, package-lock.json $stage
Copy-Item -Recurse -Force .\node_modules "$stage\node_modules"

$zip = "$env:TEMP\spotvm-deploy.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -Assembly 'System.IO.Compression.FileSystem'
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

az webapp deploy `
  --resource-group $RG `
  --name spotvm-hdfc-webapp `
  --src-path $zip --type zip --timeout 900
```

### Step 4: Verify

```powershell
# Static host alive?
Invoke-RestMethod "https://spotvm-hdfc-webapp.azurewebsites.net/healthz"

# Bundle hash (sanity check that the latest build is live)
(Invoke-WebRequest "https://spotvm-hdfc-webapp.azurewebsites.net/" -UseBasicParsing).Content `
  | Select-String -Pattern 'main-[A-Z0-9]+\.js'

Start-Process "https://spotvm-hdfc-webapp.azurewebsites.net"
```

In the browser, hard-refresh (`Ctrl+F5`) and clear `localStorage` after any auth-config change so MSAL doesn't replay a stale account.

## Subscriptions visible to a user

The SPA calls `GET https://management.azure.com/subscriptions?api-version=2022-12-01` with the signed-in user's token. ARM returns whatever subscriptions that user has any RBAC role on in the current tenant — there is **no app-side list**, no env var, no `AZURE_SUBSCRIPTIONS` setting. To give a user another subscription, grant them `Reader` (or higher) on it and sign in again.

Cross-tenant access is the user's responsibility — e.g. via [Azure Lighthouse](https://learn.microsoft.com/azure/lighthouse/overview) projecting a subscription into the user's home tenant, or by signing in with a guest account.

## Configuration

| Where                                       | What                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `webapp/src/app/auth.config.ts`             | `ENTRA_TENANT_ID`, `ENTRA_APP_CLIENT_ID`, `ARM_SCOPE`                                                       |
| `webapp/src/app/services/spot-score.service.ts` | `REGIONS` (38 Azure regions), `STATIC_SKU_FAMILIES` (B/Dv5/Dsv5 fallback), `SCORE_API_VERSION` (`2025-06-05`), `BATCH_SIZE` (max 5), `DEFAULT_DESIRED_COUNT`, `SPOT_API_HOURLY_QUOTA` |
| `webapp/server.js`                          | Static host only — port via `PORT` env var (defaults to 8080)                                              |

## Local development

```powershell
cd webapp
npm install

# Build once so server.js has something to serve, then start either:
#  (a) the static host (production-like, port 8080)
npm run build
node server.js

#  (b) the Angular dev server (hot reload, port 4200) — preferred during UI work
npx ng serve
```

Both `http://localhost:4200/` and `http://localhost:8080/` should already be in the app registration's `spa.redirectUris` (the checklist adds 4200; add 8080 if you also test against the static host).

No Azure credentials are read on the server side. Sign-in happens in the browser exactly as in production.

## Files

```
SpotVMDashboard/
├── webapp/
│   ├── server.js                          # Pure static host (Express); no Azure SDKs
│   ├── package.json                       # express + Angular + MSAL
│   ├── angular.json / tsconfig*.json      # Angular build config
│   ├── src/
│   │   ├── index.html / main.ts / styles.css
│   │   └── app/
│   │       ├── auth.config.ts             # MSAL config: tenant + client id + ARM scope
│   │       ├── app.config.ts              # Angular providers (HttpClient, MSAL, interceptor, guard)
│   │       ├── app.component.{ts,html,css}
│   │       ├── models/spot-score.model.ts
│   │       └── services/spot-score.service.ts  # All ARM calls (subs, SKUs, usages, RG, score gen)
│   └── infra/
│       ├── webapp.bicep                   # App Service (Linux, Node 20)
│       └── webapp.bicepparam              # Deployment parameters
├── deploy.zip                             # Pre-built deploy package
└── README.md
```

## Troubleshooting

| Issue                                                                                  | Resolution                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Need admin approval"** on first sign-in                                              | Tenant blocks user consent — see [Tenant complexities](#tenant-complexities--the-part-that-bit-us). An admin must grant tenant-wide consent. |
| **AADSTS50020 / 90072** (user not in tenant)                                            | App reg is single-tenant; either move it to the user's tenant or switch to multi-tenant + `/organizations` authority.                       |
| **AADSTS9002326** (Cross-origin token redemption permitted only for SPA)                | App reg redirect URI is configured under *Web* not *SPA*. Move it to `spa.redirectUris`.                                                    |
| **Subscription dropdown is empty**                                                      | User has no role assignment on any subscription in the signed-in tenant. Grant `Reader` at sub scope.                                       |
| **403 AuthorizationFailed** on scoring/usages/SKUs                                      | User lacks `Reader` on that subscription, or RBAC propagation hasn't finished (wait ~5 min, then sign out and back in).                     |
| **429 rate limited**                                                                    | Spot Placement Score API hourly quota exhausted — wait ~60 min, or reduce selected SKU families/regions. The SPA shows a live countdown.    |
| **Blank page / old behaviour after deploy**                                             | Browser cached the previous bundle. Hard-refresh (`Ctrl+F5`) and clear site `localStorage`.                                                  |
| **App Service returns `Site Disabled` / 403 right after deploy**                        | The site is in *Stopped* state. `az webapp start -g $RG -n spotvm-hdfc-webapp`.                                                              |
| **`az webapp deploy` fails to read `deploy.zip` (file locked)**                          | OneDrive is syncing. Copy the zip to `$env:TEMP\spotvm-deploy.zip` and deploy from there.                                                    |
| **MSAL keeps redirecting between login and the app**                                    | The current hostname is not in `spa.redirectUris`. Add it via the Entra portal or the Graph PATCH snippet above.                            |
