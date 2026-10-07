<#
.SYNOPSIS
    Creates Entra ID app registrations for SpoStorage (engine app-only, web Easy Auth, optional GitHub OIDC deploy).
.DESCRIPTION
    Compatible with PowerShell 7 and Windows PowerShell 5.1. Requires Azure CLI (az) signed in to the target tenant.
    Does not write secrets to disk unless -OutFile is supplied. Prints admin-consent URL and next steps.
.PARAMETER TenantId
    Directory (tenant) ID or primary domain (e.g. contoso.onmicrosoft.com).
.PARAMETER WebAppName
    Azure App Service name for the UI/API app (used for Easy Auth redirect URI).
.PARAMETER EngineAppName
    Azure App Service name for the engine (required with -GitHubRepo for role assignment).
.PARAMETER ResourceGroup
    Resource group that contains the web apps (required with -GitHubRepo).
.PARAMETER SubscriptionId
    Azure subscription ID (optional; uses current az account when omitted).
.PARAMETER GitHubRepo
    Optional owner/name repository for a GitHub Actions OIDC federated credential on branch main.
.PARAMETER OutFile
    Optional path to write a JSON summary including secrets (PEM base64 and web client secret).
.EXAMPLE
    .\New-SpoStorageEntraApps.ps1 -TenantId contoso.onmicrosoft.com -WebAppName spostorage-web-contoso
.EXAMPLE
    .\New-SpoStorageEntraApps.ps1 -TenantId contoso.onmicrosoft.com -WebAppName spostorage-web-contoso `
      -EngineAppName spostorage-engine-contoso -ResourceGroup rg-spostorage -GitHubRepo contoso/spostorage
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [string]$WebAppName,

    [string]$EngineAppName = '',

    [string]$ResourceGroup = '',

    [string]$SubscriptionId = '',

    [string]$GitHubRepo = '',

    [string]$OutFile = '',

    [string]$EngineDisplayName = 'SpoStorage Engine',

    [string]$WebDisplayName = 'SpoStorage Web',

    [string]$DeployDisplayName = 'SpoStorage GitHub Deploy',

    [int]$CertValidYears = 2
)

# 'Continue': Azure CLI writes progress/warnings to stderr; with 'Stop' PS 5.1 treats them as terminating.
$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin;' + $env:PATH

# Well-known Microsoft API application (client) IDs only — role/permission IDs are resolved at runtime.
$script:SharePointAppId = '00000003-0000-0ff1-ce00-000000000000'
$script:GraphAppId = '00000003-0000-0000-c000-000000000000'
$script:O365ManagementAppId = 'c5393580-f805-4401-95e8-94b7a6ef0ba5'
$script:WebsiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbfe998e3'

function Write-Step {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-WarnLine {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Invoke-AzCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Arguments,
        [switch]$AllowFailure
    )
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    try {
        $azCmd = Get-Command az -ErrorAction SilentlyContinue
        if (-not $azCmd) {
            throw 'Azure CLI (az) was not found on PATH. Install it from https://aka.ms/installazurecliwindows'
        }
        # cmd.exe avoids PowerShell binding az flags like -o / -g as PS parameters.
        $p = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c az $Arguments" -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        $out = [string](Get-Content -LiteralPath $tmpOut -Raw -ErrorAction SilentlyContinue)
        $err = [string](Get-Content -LiteralPath $tmpErr -Raw -ErrorAction SilentlyContinue)
        if ($p.ExitCode -ne 0 -and -not $AllowFailure) {
            $detail = ($err + "`n" + $out).Trim()
            throw ("az {0} failed ({1}): {2}" -f $Arguments, $p.ExitCode, $detail)
        }
        return $out
    }
    finally {
        Remove-Item -LiteralPath $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
}

function Get-AzCliJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Arguments,
        [switch]$AllowFailure
    )
    $txt = Invoke-AzCli -Arguments $Arguments -AllowFailure:$AllowFailure
    if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
    return ($txt | ConvertFrom-Json)
}

function ConvertTo-Base64PemLines {
    param([byte[]]$Bytes)
    $b64 = [Convert]::ToBase64String($Bytes)
    $lines = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $b64.Length; $i += 64) {
        $len = [Math]::Min(64, $b64.Length - $i)
        [void]$lines.Add($b64.Substring($i, $len))
    }
    return ($lines -join "`n")
}

function ConvertTo-Asn1Length {
    param([int]$Length)
    if ($Length -lt 128) {
        return [byte[]]@([byte]$Length)
    }
    if ($Length -lt 256) {
        return [byte[]]@(0x81, [byte]$Length)
    }
    return [byte[]]@(0x82, [byte](($Length -shr 8) -band 0xFF), [byte]($Length -band 0xFF))
}

function ConvertTo-Asn1Integer {
    param([byte[]]$Value)
    $i = 0
    while ($i -lt $Value.Length - 1 -and $Value[$i] -eq 0) { $i++ }
    $slice = $Value[$i..($Value.Length - 1)]
    if ($slice[0] -ge 0x80) {
        $slice = [byte[]](@(0) + $slice)
    }
    $len = ConvertTo-Asn1Length -Length $slice.Length
    return [byte[]](@(0x02) + $len + $slice)
}

function ConvertTo-Asn1Sequence {
    param([byte[][]]$Elements)
    $payload = New-Object System.Collections.Generic.List[byte]
    foreach ($el in $Elements) {
        foreach ($b in $el) { [void]$payload.Add($b) }
    }
    $arr = $payload.ToArray()
    $len = ConvertTo-Asn1Length -Length $arr.Length
    return [byte[]](@(0x30) + $len + $arr)
}

function Export-RsaPrivateKeyPkcs1Der {
    param([System.Security.Cryptography.RSA]$Rsa)
    $p = $Rsa.ExportParameters($true)
    $version = ConvertTo-Asn1Integer -Value ([byte[]]@(0x00))
    $n = ConvertTo-Asn1Integer -Value $p.Modulus
    $e = ConvertTo-Asn1Integer -Value $p.Exponent
    $d = ConvertTo-Asn1Integer -Value $p.D
    $p1 = ConvertTo-Asn1Integer -Value $p.P
    $q = ConvertTo-Asn1Integer -Value $p.Q
    $dp = ConvertTo-Asn1Integer -Value $p.DP
    $dq = ConvertTo-Asn1Integer -Value $p.DQ
    $iq = ConvertTo-Asn1Integer -Value $p.InverseQ
    return ConvertTo-Asn1Sequence -Elements @($version, $n, $e, $d, $p1, $q, $dp, $dq, $iq)
}

function New-EngineCertificateMaterials {
    param([int]$ValidYears)

    $subject = 'CN=SpoStorage Engine'
    $notAfter = (Get-Date).ToUniversalTime().AddYears($ValidYears)
    $cert = New-SelfSignedCertificate `
        -Subject $subject `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyExportPolicy Exportable `
        -KeySpec Signature `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyAlgorithm RSA `
        -NotAfter $notAfter `
        -Provider 'Microsoft Software Key Storage Provider'

    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        if (-not $rsa) {
            throw 'Could not access the certificate private key. Ensure the key is exportable.'
        }

        $pkcs1 = Export-RsaPrivateKeyPkcs1Der -Rsa $rsa
        $keyPem = "-----BEGIN RSA PRIVATE KEY-----`n$(ConvertTo-Base64PemLines -Bytes $pkcs1)`n-----END RSA PRIVATE KEY-----"
        $certDer = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        $certPem = "-----BEGIN CERTIFICATE-----`n$(ConvertTo-Base64PemLines -Bytes $certDer)`n-----END CERTIFICATE-----"
        $pem = $keyPem + "`n" + $certPem + "`n"
        $pemBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pem))

        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('spostorage-entra-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmpDir | Out-Null
        $cerPath = Join-Path $tmpDir 'engine.cer'
        [System.IO.File]::WriteAllBytes($cerPath, $certDer)

        return [pscustomobject]@{
            Certificate = $cert
            Thumbprint  = $cert.Thumbprint
            CerPath     = $cerPath
            TempDir     = $tmpDir
            PemBase64   = $pemBase64
        }
    }
    catch {
        if ($cert) {
            Remove-Item -LiteralPath ("Cert:\CurrentUser\My\$($cert.Thumbprint)") -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Get-AppRoleIdByValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ApiAppId,
        [Parameter(Mandatory = $true)]
        [string]$RoleValue
    )
    $sp = Get-AzCliJson -Arguments "ad sp show --id $ApiAppId -o json"
    if (-not $sp) {
        throw "Service principal for API app $ApiAppId was not found in this tenant. Ensure the API is available."
    }
    $role = @($sp.appRoles) | Where-Object { $_.value -eq $RoleValue -and $_.isEnabled -ne $false } | Select-Object -First 1
    if (-not $role) {
        throw "Application role '$RoleValue' was not found on API app $ApiAppId."
    }
    return [string]$role.id
}

function Get-OrCreateAdApp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DisplayName
    )
    $existing = @(Get-AzCliJson -Arguments "ad app list --display-name `"$DisplayName`" -o json")
    if ($existing -and $existing.Count -gt 0) {
        Write-WarnLine ("Reusing existing app registration: {0} ({1})" -f $DisplayName, $existing[0].appId)
        return $existing[0]
    }
    $created = Get-AzCliJson -Arguments "ad app create --display-name `"$DisplayName`" --sign-in-audience AzureADMyOrg -o json"
    Write-Ok ("Created app registration: {0} ({1})" -f $DisplayName, $created.appId)
    return $created
}

function Ensure-ServicePrincipal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AppId
    )
    $sp = Get-AzCliJson -Arguments "ad sp show --id $AppId -o json" -AllowFailure
    if ($sp -and $sp.id) { return $sp }
    $sp = Get-AzCliJson -Arguments "ad sp create --id $AppId -o json"
    Write-Ok ("Created service principal for {0}" -f $AppId)
    return $sp
}

# --- Preconditions ---
if ($GitHubRepo) {
    if ($GitHubRepo -notmatch '^[^/\s]+/[^/\s]+$') {
        throw '-GitHubRepo must be in the form owner/name.'
    }
    if (-not $EngineAppName) { throw '-EngineAppName is required when -GitHubRepo is set.' }
    if (-not $ResourceGroup) { throw '-ResourceGroup is required when -GitHubRepo is set.' }
}

Write-Step 'Checking Azure CLI login…'
$account = $null
try { $account = Get-AzCliJson -Arguments 'account show -o json' } catch { }
if (-not $account) {
    Write-Step ("Signing in to tenant {0}…" -f $TenantId)
    Invoke-AzCli -Arguments "login --tenant `"$TenantId`" -o none" | Out-Null
    $account = Get-AzCliJson -Arguments 'account show -o json'
}
if ($SubscriptionId) {
    Invoke-AzCli -Arguments "account set --subscription `"$SubscriptionId`" -o none" | Out-Null
    $account = Get-AzCliJson -Arguments 'account show -o json'
}
$tenantGuid = [string]$account.tenantId
$subId = [string]$account.id
Write-Ok ("Signed in as {0} · tenant {1} · subscription {2}" -f $account.user.name, $tenantGuid, $subId)

# --- Resolve application permission (role) IDs ---
Write-Step 'Resolving application permission IDs from the directory…'
$roleSitesFullControl = Get-AppRoleIdByValue -ApiAppId $script:SharePointAppId -RoleValue 'Sites.FullControl.All'
$roleGraphSitesRead = Get-AppRoleIdByValue -ApiAppId $script:GraphAppId -RoleValue 'Sites.Read.All'
$roleGraphGroupMember = Get-AppRoleIdByValue -ApiAppId $script:GraphAppId -RoleValue 'GroupMember.Read.All'
$roleGraphAudit = Get-AppRoleIdByValue -ApiAppId $script:GraphAppId -RoleValue 'AuditLogsQuery-SharePoint.Read.All'
$roleActivityFeed = Get-AppRoleIdByValue -ApiAppId $script:O365ManagementAppId -RoleValue 'ActivityFeed.Read'

# --- Engine app (certificate + application permissions) ---
Write-Step ("Ensuring engine app registration '{0}'…" -f $EngineDisplayName)
$engineApp = Get-OrCreateAdApp -DisplayName $EngineDisplayName
$engineAppId = [string]$engineApp.appId
$engineObjectId = [string]$engineApp.id

Write-Step 'Creating self-signed certificate (private key stays on this machine)…'
$certMaterials = New-EngineCertificateMaterials -ValidYears $CertValidYears
try {
    Write-Step 'Uploading public certificate to the engine app…'
    # Quote path for cmd.exe; @file tells az to read certificate bytes from disk.
    $cerArg = '@' + $certMaterials.CerPath
    Invoke-AzCli -Arguments ("ad app credential reset --id {0} --cert `"{1}`" --display-name `"SpoStorage Engine`" --append -o none" -f $engineObjectId, $cerArg) | Out-Null
    Write-Ok ("Certificate uploaded (thumbprint {0})." -f $certMaterials.Thumbprint)

    Write-Step 'Adding application permissions to the engine app…'
    Invoke-AzCli -Arguments ("ad app permission add --id {0} --api {1} --api-permissions {2}=Role" -f $engineAppId, $script:SharePointAppId, $roleSitesFullControl) -AllowFailure | Out-Null
    Invoke-AzCli -Arguments ("ad app permission add --id {0} --api {1} --api-permissions {2}=Role {3}=Role {4}=Role" -f $engineAppId, $script:GraphAppId, $roleGraphSitesRead, $roleGraphGroupMember, $roleGraphAudit) -AllowFailure | Out-Null
    Invoke-AzCli -Arguments ("ad app permission add --id {0} --api {1} --api-permissions {2}=Role" -f $engineAppId, $script:O365ManagementAppId, $roleActivityFeed) -AllowFailure | Out-Null
    Ensure-ServicePrincipal -AppId $engineAppId | Out-Null
    Write-Ok 'Engine application permissions requested (admin consent still required).'
}
finally {
    if ($certMaterials.Certificate) {
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\$($certMaterials.Certificate.Thumbprint)") -Force -ErrorAction SilentlyContinue
    }
    if ($certMaterials.TempDir -and (Test-Path -LiteralPath $certMaterials.TempDir)) {
        Remove-Item -LiteralPath $certMaterials.TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$adminConsentUrl = "https://login.microsoftonline.com/$tenantGuid/adminconsent?client_id=$engineAppId"

# --- Web Easy Auth app ---
Write-Step ("Ensuring web sign-in app registration '{0}'…" -f $WebDisplayName)
$redirectUri = "https://$WebAppName.azurewebsites.net/.auth/login/aad/callback"
$webApp = Get-OrCreateAdApp -DisplayName $WebDisplayName
$webAppId = [string]$webApp.appId
$webObjectId = [string]$webApp.id

Invoke-AzCli -Arguments ("ad app update --id {0} --web-redirect-uris `"{1}`" --enable-id-token-issuance true -o none" -f $webObjectId, $redirectUri) | Out-Null
Ensure-ServicePrincipal -AppId $webAppId | Out-Null

Write-Step 'Creating Easy Auth client secret…'
$webCred = Get-AzCliJson -Arguments ("ad app credential reset --id {0} --display-name `"easy-auth`" --years 2 -o json" -f $webObjectId)
$webClientSecret = [string]$webCred.password
if (-not $webClientSecret) { throw 'Failed to create the web app client secret.' }
Write-Ok ("Web app client id: {0}" -f $webAppId)

# --- Optional GitHub Actions OIDC deploy app ---
$deployAppId = $null
$deployObjectId = $null
if ($GitHubRepo) {
    Write-Step ("Ensuring deploy app registration '{0}' for GitHub repo {1}…" -f $DeployDisplayName, $GitHubRepo)
    $deployApp = Get-OrCreateAdApp -DisplayName $DeployDisplayName
    $deployAppId = [string]$deployApp.appId
    $deployObjectId = [string]$deployApp.id
    $deploySp = Ensure-ServicePrincipal -AppId $deployAppId

    $fedName = 'github-main'
    $existingFed = Get-AzCliJson -Arguments ("ad app federated-credential list --id {0} -o json" -f $deployObjectId) -AllowFailure
    $hasFed = $false
    if ($existingFed) {
        $hasFed = [bool](@($existingFed) | Where-Object { $_.name -eq $fedName })
    }
    if (-not $hasFed) {
        $fedParams = @{
            name        = $fedName
            issuer      = 'https://token.actions.githubusercontent.com'
            subject     = "repo:${GitHubRepo}:ref:refs/heads/main"
            description = "GitHub Actions OIDC for $GitHubRepo (main)"
            audiences   = @('api://AzureADTokenExchange')
        }
        $fedFile = [System.IO.Path]::GetTempFileName() + '.json'
        try {
            ($fedParams | ConvertTo-Json -Compress) | Set-Content -LiteralPath $fedFile -Encoding UTF8
            Invoke-AzCli -Arguments ("ad app federated-credential create --id {0} --parameters `"{1}`" -o none" -f $deployObjectId, $fedFile) | Out-Null
            Write-Ok "Federated credential '$fedName' created."
        }
        finally {
            Remove-Item -LiteralPath $fedFile -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        Write-WarnLine "Federated credential '$fedName' already exists."
    }

    Write-Step 'Assigning Website Contributor on the web and engine App Services…'
    $webRes = Get-AzCliJson -Arguments ("webapp show -n {0} -g {1} -o json" -f $WebAppName, $ResourceGroup)
    $engineRes = Get-AzCliJson -Arguments ("webapp show -n {0} -g {1} -o json" -f $EngineAppName, $ResourceGroup)
    Invoke-AzCli -Arguments ("role assignment create --assignee-object-id {0} --assignee-principal-type ServicePrincipal --role `"{1}`" --scope `"{2}`" -o none" -f $deploySp.id, 'Website Contributor', $webRes.id) -AllowFailure | Out-Null
    Invoke-AzCli -Arguments ("role assignment create --assignee-object-id {0} --assignee-principal-type ServicePrincipal --role `"{1}`" --scope `"{2}`" -o none" -f $deploySp.id, 'Website Contributor', $engineRes.id) -AllowFailure | Out-Null
    Write-Ok 'Website Contributor assignments requested.'
}

# --- Summary ---
$result = [ordered]@{
    tenantId                         = $tenantGuid
    subscriptionId                   = $subId
    engineAppId                      = $engineAppId
    engineDisplayName                = $EngineDisplayName
    webAppId                         = $webAppId
    webDisplayName                   = $WebDisplayName
    webRedirectUri                   = $redirectUri
    entraClientSecretSettingName     = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
    adminConsentUrl                  = $adminConsentUrl
    SPOSTORAGE_APP_ONLY_CLIENT_ID    = $engineAppId
    SPOSTORAGE_APP_ONLY_TENANT_ID    = $tenantGuid
    SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64 = $certMaterials.PemBase64
    entraWebClientId                 = $webAppId
    entraWebClientSecret             = $webClientSecret
}

if ($deployAppId) {
    $result.deployAppId = $deployAppId
    $result.githubRepo = $GitHubRepo
    $result.repositoryVariables = [ordered]@{
        AZURE_CLIENT_ID       = $deployAppId
        AZURE_TENANT_ID       = $tenantGuid
        AZURE_SUBSCRIPTION_ID = $subId
        WEB_APP_NAME          = $WebAppName
        ENGINE_APP_NAME       = $EngineAppName
    }
}

Write-Host ''
Write-Host '========== SpoStorage Entra setup ==========' -ForegroundColor Cyan
Write-Host ("Engine app (app-only): {0}  appId={1}" -f $EngineDisplayName, $engineAppId)
Write-Host ("Web app (Easy Auth):   {0}  appId={1}" -f $WebDisplayName, $webAppId)
Write-Host ("Redirect URI:          {0}" -f $redirectUri)
Write-Host ''
Write-Host 'SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64 (paste into Bicep / App Settings):' -ForegroundColor Yellow
Write-Host $certMaterials.PemBase64
Write-Host ''
Write-Host 'Easy Auth client secret (entraWebClientSecret / MICROSOFT_PROVIDER_AUTHENTICATION_SECRET):' -ForegroundColor Yellow
Write-Host $webClientSecret
Write-Host ''
Write-Host 'Admin consent URL (Global Admin must open this once):' -ForegroundColor Yellow
Write-Host $adminConsentUrl
Write-Host ''

if ($deployAppId) {
    Write-Host 'GitHub repository variables to set:' -ForegroundColor Yellow
    Write-Host ("  AZURE_CLIENT_ID       = {0}" -f $deployAppId)
    Write-Host ("  AZURE_TENANT_ID       = {0}" -f $tenantGuid)
    Write-Host ("  AZURE_SUBSCRIPTION_ID = {0}" -f $subId)
    Write-Host ("  WEB_APP_NAME          = {0}" -f $WebAppName)
    Write-Host ("  ENGINE_APP_NAME       = {0}" -f $EngineAppName)
    Write-Host ''
}

Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Copy the PEM base64 and web client secret into your parameters file (or App Settings).'
Write-Host '  2. Deploy infra/main.bicep to your resource group.'
Write-Host '  3. Open the admin consent URL and accept the engine application permissions.'
Write-Host '  4. Set GitHub repository variables (if using Actions), then push to main to deploy.'
Write-Host '  5. Verify https://<web-app>.azurewebsites.net/api/health'
Write-Host '============================================' -ForegroundColor Cyan

if ($OutFile) {
    $json = ($result | ConvertTo-Json -Depth 6)
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
    Write-Ok ("Wrote summary (includes secrets) to {0}" -f $OutFile)
}

# Clear secret locals from casual inspection of leftover variables in interactive sessions.
$webClientSecret = $null
$certMaterials = $null

return [pscustomobject]$result
