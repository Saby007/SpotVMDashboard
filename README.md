# Spot VM Placement Score Dashboard

An Angular + Node/Express dashboard that shows **Azure Spot VM placement recommendations**, historical eviction-risk bands, and Spot quota for the VM sizes and regions you choose. These are snapshots, not capacity reservations or deployment guarantees.

The app currently runs **without any user login**. All Azure calls are made **server-side** by the Node host:

- **Locally**, the host uses your **Azure CLI** session (`az login`).
- **In Azure App Service**, the host uses the site's **system-assigned managed identity**.

> Microsoft Entra user sign-in is planned for a later phase. The frontend has no auth gate today.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Angular 21 SPA (browser)                     │
│  • No login screen                            │
│  • Calls the Node host's /api/* endpoints     │
└───────────────────────┬──────────────────────┘
                        │  /api/subscriptions
                        │  /api/config
                        │  /api/eviction-rates
                        │  /api/vm-quota
                        │  /api/placement-scores
                        ▼
┌──────────────────────────────────────────────┐
│  Node / Express host (server.js)              │
│  • Serves the Angular bundle                  │
│  • Acquires an ARM token:                     │
│      – local:  Azure CLI (az account ...)     │
│      – Azure:  App Service managed identity   │
│  • Calls management.azure.com on your behalf  │
└───────────────────────┬──────────────────────┘
                        ▼
┌──────────────────────────────────────────────┐
│  Azure Resource Manager (management.azure.com)│
│  Every call is authorized by Azure RBAC on    │
│  the CLI user (local) or the MI (App Service).│
└──────────────────────────────────────────────┘
```

**Bottom line:** whoever/whatever the host authenticates as needs two **read-only** roles on the target subscription — **`Reader`** and **`Compute Recommendations Role`**. That is the CLI user locally, and the App Service managed identity in the cloud.

---

## Features

- Spot **placement scores** (High / Medium / Low / Restricted) per SKU and zone
- Real **eviction rates** (last 28 days) via Azure Resource Graph
- Regional **Spot vCPU quota** (low-priority cores) usage
- Subscription- and region-scoped **SKU discovery**, excluding known region-wide restrictions (a visibly unverified static fallback is used only if discovery fails)
- Sortable score table + heatmap view, live batch progress, and 429 back-off handling

### Reading and validating results

- **Eviction** is interruption of a Spot VM when Azure reclaims capacity or the configured maximum price is exceeded. The VM is deallocated or deleted according to its eviction policy.
- **Eviction history** comes from Azure Resource Graph's trailing 28-day SKU/region data. It is not zone-specific, a promised lifetime, or your application's measured failure rate. Unknown history is not zero risk.
- **Placement scores** estimate allocation likelihood for the exact subscription, Spot VM count, size, region, zone, and query time. High/Medium/Low do not guarantee deployment or continued availability. Restricted is distinct from missing, stale, or unrecognized data.
- **Quota** is a permitted resource allowance, not Azure's spare capacity. The table shows the placement API's quota sufficiency signal for the requested count: sufficient, insufficient, or unknown. A smaller request may fit when the requested count does not.
- The separate **regional Spot vCPU pool** shows remaining allowance shared across Spot sizes and scale-set instances. Its percentage is not a per-SKU/family quota or deployment-success probability. A zero limit means zero remaining allowance, not 100%.
- The **heatmap** has SKU rows and zone columns. Its 3/2/1/0 values are display rankings, not probabilities; only an explicit restricted score maps to 0. `?` means unknown/stale data and `–` means no returned result. Colours do not incorporate quota.
- The host validates subscription GUIDs, configured regions, integer counts (1–10), up to five distinct SKU names, up to eight distinct locations, and boolean zone selection. Invalid values are rejected rather than silently clamped.
- Azure metric payloads and placement scope are validated server-side. Invalid upstream metrics return errors; absent quota flags remain unknown. Lookup failures and incomplete results have visible warnings. Resource Graph continuation pages are read rather than silently ignored.
- SKU discovery is cached for 15 minutes per subscription and region. Zone-only restrictions keep the SKU in the catalogue because other zones may still be usable; consult the zonal placement results. An empty verified catalogue is not replaced with static sizes.
- Changing any selection cancels outstanding score requests and clears the old results. Cancelled or failed batches are marked incomplete. Snapshots at least 15 minutes old have an age warning, but even newer scores can change immediately. Retrieval timestamps are not the age of Azure's underlying data.

The dashboard does not create or block VMs. Compare the same Spot/regular priority, subscription, size, region, zone, and count when investigating a successful deployment after a poor score. Azure performs the authoritative validation and allocation when the VM is deployed.

See [Spot VM behavior and history](https://learn.microsoft.com/azure/virtual-machines/spot-vms) and [placement-score considerations](https://learn.microsoft.com/azure/virtual-machine-scale-sets/spot-placement-score#considerations).

---

## Repository layout

```
.
├── README.md
├── deploy.ps1                     # One-shot build + deploy helper (PowerShell)
└── webapp/
    ├── server.js                  # Express host + /api/* Azure proxy
    ├── package.json
    ├── angular.json
    ├── proxy.conf.json            # ng serve → localhost:8080 proxy for /api
    ├── infra/
    │   ├── webapp.bicep           # App Service Plan + Web App + managed identity
    │   └── webapp.bicepparam
    └── src/                       # Angular application
```

---

## Prerequisites

- **Node.js 20.19+, 22.12+, or 24+** and npm
- **Azure CLI 2.55+** (`az`)
- **PowerShell 7+** (for `deploy.ps1` on any OS)
- An Azure subscription where you have rights to create a resource group and an App Service, and to assign roles (`Reader` and `Compute Recommendations Role`).

---

## Get the code

```powershell
git clone https://github.com/Saby007/SpotVMDashboard.git
cd SpotVMDashboard
```

> If the repo is private, `git clone` will prompt for your GitHub credentials — or use the GitHub CLI: `gh repo clone Saby007/SpotVMDashboard`. All commands below assume you are in the cloned `SpotVMDashboard` folder (the repo root).

---

## Run locally

Local mode uses your `az login` session — no app registration or secrets required.

```powershell
az login                 # sign in; sets the CLI session the host will use
cd webapp
npm install              # also builds the Angular bundle (postinstall)
npm start                # starts the Express host on http://localhost:8080
```

Open http://localhost:8080. The header shows a **LOCAL DEV** badge, and the app calls `/api/*`, which the host services using your CLI token.

### Validate changes

From the `webapp` directory, run `npm test` for the Node built-in regression suite and `npm run build` for Angular's production build and strict template/type checks. Tests exercise the API and frontend state with mocked Azure responses; they do not sign in, query your subscription, or create VMs.

> Want live Angular reload? Run the host and the dev server in two terminals:
> ```powershell
> npm run dev:backend    # terminal 1 → node server.js on :8080
> npm run dev:frontend   # terminal 2 → ng serve on :4200 (proxies /api to :8080)
> ```

---

## Deploy to Azure

You need three things in Azure: a **resource group**, an **App Service** (Linux, Node 22) with a **managed identity**, and two least-privilege **read-only** roles for that identity on your subscription (**`Reader`** + **`Compute Recommendations Role`**). Then you deploy the built app.

Pick **Option A** (guided script) or **Option B** (manual `az` commands). Both assume you've run `az login`.

Set these once in your shell (App Service names are **globally unique** — choose your own):

```powershell
$SUBSCRIPTION_ID = (az account show --query id -o tsv)
$RG              = "rg-spotvm-dashboard"
$LOCATION        = "centralindia"
$APP_NAME        = "spotvm-webapp-$((Get-Random -Maximum 9999))"   # must be globally unique
$PLAN_NAME       = "$APP_NAME-plan"
```

### Step 1 — Create the resource group

```powershell
az account set --subscription $SUBSCRIPTION_ID
az group create --name $RG --location $LOCATION
```

### Step 2 — Create the App Service (Linux, Node 22)

```powershell
# App Service plan (B1 Basic is fine for this app)
az appservice plan create `
  --name $PLAN_NAME `
  --resource-group $RG `
  --location $LOCATION `
  --sku B1 `
  --is-linux

# Web app on the Node 22 runtime
az webapp create `
  --name $APP_NAME `
  --resource-group $RG `
  --plan $PLAN_NAME `
  --runtime "NODE:22-lts"

# Start the host with `node server.js`, and let Oryx install deps on deploy
az webapp config set `
  --name $APP_NAME `
  --resource-group $RG `
  --startup-file "node server.js"

az webapp config appsettings set `
  --name $APP_NAME `
  --resource-group $RG `
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true WEBSITE_NODE_DEFAULT_VERSION="~22"
```

### Step 3 — Enable the managed identity and grant least-privilege roles

Turn on the web app's system-assigned managed identity, then grant it two **read-only** roles on the subscription (no Contributor or Owner):

- **`Reader`** — read VM SKUs, Spot vCPU quota (usages), and eviction rates (Resource Graph).
- **`Compute Recommendations Role`** — call the Spot placement score API (`Microsoft.Compute/locations/placementScores/generate/action`), which `Reader` alone does not permit.

```powershell
# Turn on the system-assigned managed identity and capture its principal id
$PRINCIPAL_ID = az webapp identity assign `
  --name $APP_NAME `
  --resource-group $RG `
  --query principalId -o tsv

# Grant both read-only roles at subscription scope
foreach ($role in 'Reader', 'Compute Recommendations Role') {
  az role assignment create `
    --assignee-object-id $PRINCIPAL_ID `
    --assignee-principal-type ServicePrincipal `
    --role $role `
    --scope "/subscriptions/$SUBSCRIPTION_ID"
}
```

### Step 4 — Tell the host which subscription to expose

```powershell
$SUBSCRIPTION_NAME = (az account show --query name -o tsv)
az webapp config appsettings set `
  --name $APP_NAME `
  --resource-group $RG `
  --settings AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID AZURE_SUBSCRIPTION_NAME="$SUBSCRIPTION_NAME"
```

> To expose **multiple** subscriptions, set `AZURE_SUBSCRIPTIONS` to a JSON array instead, e.g.
> `[{"id":"<sub-guid>","name":"Prod"},{"id":"<sub-guid>","name":"Dev"}]`.
> The identity needs both roles (`Reader` + `Compute Recommendations Role`) on each. If neither app
> setting is present, the host lists every subscription the identity can see.

### Step 5 — Build and deploy

**Option A — Use the deploy script (recommended).** It builds Angular, packages a runtime-only bundle, ensures the identity + role, sets the subscription app settings, deploys, and health-checks the site:

```powershell
# From the repo root
./deploy.ps1 -SubscriptionId $SUBSCRIPTION_ID -ResourceGroup $RG -AppName $APP_NAME
```

If you already assigned the roles in Step 3, you can skip that step on repeat runs:

```powershell
./deploy.ps1 -SubscriptionId $SUBSCRIPTION_ID -ResourceGroup $RG -AppName $APP_NAME -SkipRoleAssignment
```

**Option B — Build and zip-deploy manually.** Ship a runtime-only `package.json` so App Service does **not** try to rebuild Angular on the host (the bundle is already built):

```powershell
cd webapp
npm install
npm run build            # outputs dist/spotvm-dashboard/browser

# Stage a minimal package: server.js + runtime package.json + the built bundle
$stage = Join-Path $env:TEMP "spotvm-package"
$zip   = Join-Path $env:TEMP "spotvm-package.zip"
Remove-Item $stage,$zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item server.js -Destination $stage
Copy-Item dist       -Destination $stage -Recurse
'{ "name":"spotvm-dashboard-webapp","version":"1.0.0","private":true,' +
'"scripts":{"start":"node server.js"},"dependencies":{"express":"^4.21.0"},' +
'"engines":{"node":">=20.0.0"} }' | Out-File (Join-Path $stage "package.json") -Encoding utf8

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force

# Deploy the zip
az webapp deploy `
  --resource-group $RG `
  --name $APP_NAME `
  --src-path $zip `
  --type zip `
  --track-status false
```

> **Why the runtime-only `package.json`?** The repo `package.json` has a `postinstall` that runs `ng build`. On App Service the Angular workspace isn't present, so that would fail with *"This command is not available when running the Angular CLI outside a workspace."* Shipping only `express` + a `start` script avoids the on-host rebuild entirely.

### Step 6 — Verify

```powershell
$HOST_NAME = az webapp show --name $APP_NAME --resource-group $RG --query defaultHostName -o tsv
Invoke-RestMethod "https://$HOST_NAME/healthz"            # → { status: ok, localDev: false }
Invoke-RestMethod "https://$HOST_NAME/api/subscriptions"  # → your subscription(s)
Start-Process "https://$HOST_NAME"                        # open the dashboard
```

---

## Deploy the infrastructure with Bicep (optional)

Instead of the `az appservice`/`az webapp` commands in Steps 2–3, you can provision the plan, web app, and managed identity from `webapp/infra/webapp.bicep`:

```powershell
az group create --name $RG --location $LOCATION

az deployment group create `
  --resource-group $RG `
  --template-file webapp/infra/webapp.bicep `
  --parameters webapp/infra/webapp.bicepparam
```

Then assign the Reader role (Step 3) and deploy the app (Step 5). The Bicep sets `baseName` (default `spotvm`) so the web app is named `<baseName>-webapp`; override it in `webapp.bicepparam` if you like.

---

## Deploy via Kudu (browser upload)

If you prefer a manual upload:

1. Build and create the zip as in **Option B** above.
2. Browse to `https://<app-name>.scm.azurewebsites.net/ZipDeployUI`.
3. Drag the zip onto the page.

The package must contain `server.js`, the runtime `package.json`, and the `dist/` folder at the root — not just the Angular output.

---

## Configuration reference

| App setting                     | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `AZURE_SUBSCRIPTION_ID`         | Single subscription the dashboard exposes.                              |
| `AZURE_SUBSCRIPTION_NAME`       | Display name for that subscription.                                     |
| `AZURE_SUBSCRIPTIONS`           | JSON array of `{ id, name }` for multiple subscriptions (overrides the two above). |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`| `true` so App Service runs `npm install` (to fetch `express`) on deploy.|
| `LOCAL_DEV`                     | `1`/`0` to force local (Azure CLI) vs managed-identity token source.    |

The host auto-detects the environment: outside App Service it uses the Azure CLI; inside App Service it uses the managed identity. You normally don't set `LOCAL_DEV`.

---

## Troubleshooting

| Symptom                                                        | Cause / fix                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Deploy fails: *"...Angular CLI outside a workspace"*           | You shipped the repo `package.json` (with the `postinstall` build). Use `deploy.ps1` or the runtime-only package from Option B. |
| `az webapp deploy` reports *"Site failed to start in 10 mins"* | On Basic tiers a cold start + first `npm install` can exceed the CLI's poll. The site usually starts anyway — check `https://<app>/healthz`. `deploy.ps1` uses `--track-status false` to avoid the false failure. |
| `/api/*` returns 403 / empty                                  | The host identity is missing `Reader` and/or `Compute Recommendations Role`. Assign both (Step 3) and wait a few minutes. |
| Local run can't get a token                                   | Run `az login`, then restart `npm start`.                                                                     |
| Inspect deploy logs                                           | `az webapp log deployment show -g <rg> -n <app>` and `az webapp log tail -g <rg> -n <app>`.                   |

---

## Roadmap

- **Phase 2:** Microsoft Entra user sign-in with per-user RBAC, so each user only sees the subscriptions they can access.

---

## Security notes

- This repo contains **no** subscription IDs, tenant IDs, client IDs, secrets, or connection strings. Provide your subscription at deploy time via `deploy.ps1 -SubscriptionId` or the `az account` context.
- Production authentication uses a **managed identity** — there are no credentials to store or rotate.
- Grant the identity the **least privilege** it needs — two read-only roles (`Reader` + `Compute Recommendations Role`) on the target subscription. No Contributor or Owner.
