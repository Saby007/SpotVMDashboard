<#
.SYNOPSIS
    Builds and deploys the Spot VM Dashboard (Angular + Node) to Azure App Service.

.DESCRIPTION
    This app runs without user login. Locally it uses your `az login` session; in
    App Service it uses the site's system-assigned managed identity. This script:
      1. Builds the Angular bundle.
      2. Packages server.js + package.json + package-lock.json + dist/.
      3. Ensures the web app has a system-assigned managed identity.
      4. Sets the subscription app settings the backend reads at startup.
      5. Grants the identity two least-privilege read-only roles on the subscription:
         'Reader' and 'Spot Placement Score Reader'.
      6. Zip-deploys the package and restarts the app.

.EXAMPLE
    ./deploy.ps1

.EXAMPLE
    ./deploy.ps1 -ResourceGroup rg-spotvm-dashboard -AppName my-spotvm-webapp -SubscriptionId <your-subscription-id>
#>

[CmdletBinding()]
param(
    # Target subscription. Leave empty to use your current `az account` context.
    [string]$SubscriptionId = '',
    [string]$ResourceGroup  = 'rg-spotvm-dashboard',
    [string]$AppName        = 'spotvm-webapp',

    # Skip `npm install` (use when node_modules is already present and current).
    [switch]$SkipInstall,

    # Skip the role assignments (use when they already exist or you lack rights).
    [switch]$SkipRoleAssignment
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$webappDir  = Join-Path $scriptRoot 'webapp'

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

# --- Preflight -------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI (az) not found on PATH. Install it and run 'az login' first."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found on PATH. Install Node.js 20+ first."
}
if (-not (Test-Path (Join-Path $webappDir 'server.js'))) {
    throw "Could not find webapp/server.js. Run this script from the repo root."
}

# --- Azure context ---------------------------------------------------------
Write-Step "Setting Azure subscription context"
if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
    $SubscriptionId = az account show --query id -o tsv
    if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
        throw "No subscription specified and no active az session. Run 'az login' or pass -SubscriptionId."
    }
    Write-Host "Using current az subscription context."
}
az account set --subscription $SubscriptionId | Out-Null
$subscriptionName = az account show --query name -o tsv
if ([string]::IsNullOrWhiteSpace($subscriptionName)) {
    throw "Not signed in. Run 'az login' and retry."
}
Write-Host "Subscription: $subscriptionName ($SubscriptionId)"

# --- Build -----------------------------------------------------------------
Push-Location $webappDir
try {
    if (-not $SkipInstall) {
        Write-Step "Installing npm dependencies"
        npm install
    }

    Write-Step "Building Angular bundle"
    npm run build

    $browserDist = Join-Path $webappDir 'dist/spotvm-dashboard/browser'
    if (-not (Test-Path $browserDist)) {
        throw "Expected build output not found at dist/spotvm-dashboard/browser."
    }

    # --- Package -----------------------------------------------------------
    Write-Step "Creating deployment package"
    $stage = Join-Path $env:TEMP 'spotvm-package'
    $zip   = Join-Path $env:TEMP 'spotvm-package.zip'

    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $stage | Out-Null

    Copy-Item (Join-Path $webappDir 'server.js') -Destination $stage
    Copy-Item (Join-Path $webappDir 'dist')      -Destination $stage -Recurse

    # Ship a runtime-only package.json. The Angular bundle is already built into
    # dist/, so the host must NOT run `ng build`. Keeping the original scripts here
    # would trigger `postinstall` -> `ng build` on App Service, which fails because
    # the Angular workspace (angular.json/src) isn't in the package. We keep only
    # the express runtime dependency and a start script.
    $srcPkg = Get-Content (Join-Path $webappDir 'package.json') -Raw | ConvertFrom-Json
    $expressVersion = $srcPkg.dependencies.express
    if ([string]::IsNullOrWhiteSpace($expressVersion)) { $expressVersion = '^4.21.0' }
    $runtimePkg = [ordered]@{
        name         = 'spotvm-dashboard-webapp'
        version      = $srcPkg.version
        private      = $true
        scripts      = [ordered]@{ start = 'node server.js' }
        dependencies = [ordered]@{ express = $expressVersion }
        engines      = [ordered]@{ node = '>=20.0.0' }
    }
    $runtimePkg | ConvertTo-Json -Depth 10 | Out-File (Join-Path $stage 'package.json') -Encoding utf8

    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
    Write-Host "Package: $zip"
}
finally {
    Pop-Location
}

# --- Managed identity ------------------------------------------------------
Write-Step "Ensuring system-assigned managed identity"
$principalId = az webapp identity assign `
    --resource-group $ResourceGroup `
    --name $AppName `
    --query principalId -o tsv
if ([string]::IsNullOrWhiteSpace($principalId)) {
    throw "Could not obtain a managed-identity principal for web app '$AppName' in resource group '$ResourceGroup'. Make sure the App Service exists (see README Step 2) before running the deploy."
}
Write-Host "Identity principalId: $principalId"

# --- App settings ----------------------------------------------------------
Write-Step "Configuring app settings"
az webapp config appsettings set `
    --resource-group $ResourceGroup `
    --name $AppName `
    --settings `
        "AZURE_SUBSCRIPTION_ID=$SubscriptionId" `
        "AZURE_SUBSCRIPTION_NAME=$subscriptionName" `
        "WEBSITE_NODE_DEFAULT_VERSION=~22" `
        "SCM_DO_BUILD_DURING_DEPLOYMENT=true" | Out-Null

# --- RBAC ------------------------------------------------------------------
if (-not $SkipRoleAssignment) {
    Write-Step "Assigning least-privilege roles on the subscription to the managed identity"
    # Reader                      -> read VM SKUs, Spot vCPU quota (usages), eviction rates (Resource Graph)
    # Spot Placement Score Reader -> call the Spot placement score API (generate action)
    foreach ($role in 'Reader', 'Spot Placement Score Reader') {
        try {
            az role assignment create `
                --assignee-object-id $principalId `
                --assignee-principal-type ServicePrincipal `
                --role $role `
                --scope "/subscriptions/$SubscriptionId" | Out-Null
            Write-Host "Assigned '$role' (or already present)."
        }
        catch {
            Write-Warning "Role assignment for '$role' failed: $($_.Exception.Message)"
            Write-Warning "Assign it manually, otherwise some backend /api calls will fail."
        }
    }
}
else {
    Write-Host "Skipping role assignments (per -SkipRoleAssignment)."
}

# --- Deploy ----------------------------------------------------------------
Write-Step "Deploying package to App Service"
# --track-status false avoids the flaky 10-minute runtime-startup poll on Basic
# tiers: a cold start plus the first-time `npm install` of express on the host
# can exceed that window even when the app ends up healthy. We verify startup
# ourselves via /healthz below. Build failures still return a non-zero exit code.
az webapp deploy `
    --resource-group $ResourceGroup `
    --name $AppName `
    --src-path $zip `
    --type zip `
    --track-status false
if ($LASTEXITCODE -ne 0) {
    throw "az webapp deploy failed (exit code $LASTEXITCODE). Inspect logs with: az webapp log deployment show --resource-group $ResourceGroup --name $AppName"
}

$hostName = az webapp show --resource-group $ResourceGroup --name $AppName --query defaultHostName -o tsv
$baseUrl = "https://$hostName"

# --- Verify ----------------------------------------------------------------
Write-Step "Verifying site health (cold starts can take a minute)"
$healthy = $false
for ($i = 1; $i -le 20; $i++) {
    try {
        $probe = Invoke-RestMethod -Uri "$baseUrl/healthz" -TimeoutSec 15
        if ($probe.status -eq 'ok') { $healthy = $true; break }
    }
    catch {
        Start-Sleep -Seconds 15
    }
}

Write-Host ""
if ($healthy) {
    Write-Host "Deployment complete and site is healthy." -ForegroundColor Green
}
else {
    Write-Warning "Deployed, but /healthz has not returned OK yet - the app may still be warming up."
    Write-Warning "Tail logs with: az webapp log tail --resource-group $ResourceGroup --name $AppName"
}
Write-Host "URL: $baseUrl" -ForegroundColor Green
