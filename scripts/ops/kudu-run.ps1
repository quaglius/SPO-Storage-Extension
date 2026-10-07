<#
.SYNOPSIS
  Runs a Node script inside the engine App Service through Kudu, with the app's environment (Azure SQL connection
  string, app-only certificate) and the deployed node_modules, and prints its output. Useful for read-only
  diagnostics without copying secrets to your machine. Requires Azure CLI signed in with access to the web app.
.EXAMPLE
  .\scripts\ops\kudu-run.ps1 -App my-spostorage-engine -ScriptPath .\scripts\ops\engine-status.mjs
#>
param(
  [Parameter(Mandatory)] [string]$App,
  [Parameter(Mandatory)] [string]$ScriptPath,
  [int]$Timeout = 600,
  [string]$ScriptArgs = ''
)
$ErrorActionPreference = 'Continue'
$tok = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $ScriptPath)))
$name = [IO.Path]::GetFileName($ScriptPath)
# Kudu ships an older Node; the app needs Node 22, so an official Node 22 build is cached in /tmp.
$cmd = "bash -c `"cd /tmp && (test -x /tmp/node22/bin/node || (curl -sSL https://nodejs.org/dist/v22.15.0/node-v22.15.0-linux-x64.tar.xz -o n.tar.xz && mkdir -p node22 && tar -xJf n.tar.xz -C node22 --strip-components=1)); P=/tmp/spo-ops; mkdir -p `$P/node_modules; (test -d `$P/node_modules/mssql || tar -xzf /home/site/wwwroot/node_modules.tar.gz -C `$P/node_modules); cp -r /home/site/wwwroot/server /home/site/wwwroot/shared /home/site/wwwroot/package.json `$P/ && cd `$P && echo $b64 | base64 -d > $name && timeout $Timeout /tmp/node22/bin/node $name $ScriptArgs 2>&1 | tail -c 60000`""
$body = @{ command = $cmd; dir = '/tmp' } | ConvertTo-Json
$r = Invoke-RestMethod -Uri "https://$App.scm.azurewebsites.net/api/command" -Method Post -Headers @{ Authorization = "Bearer $tok" } -Body $body -ContentType 'application/json' -TimeoutSec ($Timeout + 180)
$r.Output
if ($r.Error) { $r.Error | Select-Object -First 5 }
