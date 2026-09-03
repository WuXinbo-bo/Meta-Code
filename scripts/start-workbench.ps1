param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataRoot = if ($env:METACODE_HOME) { $env:METACODE_HOME } elseif ($env:WORKBENCH_DATA_DIR) { $env:WORKBENCH_DATA_DIR } elseif ($env:WORKBENCH_RUNTIME_DIR) { $env:WORKBENCH_RUNTIME_DIR } elseif ($env:METACODE_PROFILE) { Join-Path $env:USERPROFILE ".metacode-$($env:METACODE_PROFILE)" } else { Join-Path $env:USERPROFILE ".metacode" }
$env:METACODE_HOME = $dataRoot
$runtimeLogRoot = Join-Path $dataRoot "logs"
$backendUrl = "http://127.0.0.1:4338/api/health"
$webUrl = "http://127.0.0.1:4339/"

function Test-HttpEndpoint([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Test-ListeningPort([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-NodeService([string]$Name, [string[]]$Arguments, [int]$Port) {
  if (Test-ListeningPort $Port) {
    Write-Host "$Name is already listening on port $Port."
    return
  }
  $node = (Get-Command node -ErrorAction Stop).Source
  $stdout = Join-Path $runtimeLogRoot "$Name.out.log"
  $stderr = Join-Path $runtimeLogRoot "$Name.err.log"
  Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  Write-Host "Starting $Name on port $Port..."
}

function Wait-ForEndpoint([string]$Name, [string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Url) {
      Write-Host "$Name is ready."
      return
    }
    Start-Sleep -Milliseconds 400
  }
  throw "$Name did not become ready. Check $runtimeLogRoot for details."
}

Set-Location $projectRoot
if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
  throw "Dependencies are missing. Run npm install in $projectRoot first."
}

New-Item -ItemType Directory -Path $runtimeLogRoot -Force | Out-Null
Start-NodeService "backend" @(
  (Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"),
  "server/index.ts"
) 4338
Start-NodeService "web" @(
  (Join-Path $projectRoot "node_modules\vite\bin\vite.js"),
  "--host", "127.0.0.1", "--port", "4339"
) 4339

Wait-ForEndpoint "Backend" $backendUrl 35
Wait-ForEndpoint "Web" $webUrl 35

if (-not $NoBrowser) {
  Start-Process $webUrl
}

Write-Host "Meta Code: $webUrl"
