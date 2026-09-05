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
$packageVersion = node -p "require('./package.json').version"

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

function Get-PortOwner([int]$Port) {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
}

function Stop-StaleProjectService([int]$Port) {
  $owner = Get-PortOwner $Port
  if (-not $owner) { return $false }
  $commandLine = [string]$owner.CommandLine
  if ($commandLine -notlike "*$projectRoot*") {
    throw "端口 $Port 已被其他项目占用（PID $($owner.ProcessId)）。请先关闭占用该端口的服务，不能混用不同项目的工作台后端。"
  }
  Stop-Process -Id $owner.ProcessId -Force -ErrorAction Stop
  Start-Sleep -Milliseconds 300
  return $true
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
if (Test-ListeningPort 4338) {
  try {
    $health = Invoke-RestMethod -Uri $backendUrl -UseBasicParsing -TimeoutSec 2
    if ([string]$health.version -ne [string]$packageVersion) {
      Write-Host "发现旧版工作台后端（$($health.version)），当前源码为 $packageVersion，正在重启当前项目服务..."
      Stop-StaleProjectService 4338 | Out-Null
    }
  } catch {
    Stop-StaleProjectService 4338 | Out-Null
  }
}
if (Test-ListeningPort 4339) {
  $webOwner = Get-PortOwner 4339
  if ($webOwner -and ([string]$webOwner.CommandLine -notlike "*$projectRoot*")) {
    throw "端口 4339 已被其他项目占用（PID $($webOwner.ProcessId)）。请先关闭占用该端口的服务。"
  }
}
Start-NodeService "backend" @(
  (Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"),
  "server/index.ts"
) 4338
Start-NodeService "web" @(
  (Join-Path $projectRoot "node_modules\vite\bin\vite.js"),
  "--host", "127.0.0.1", "--port", "4339"
) 4339

Wait-ForEndpoint "Backend" $backendUrl 35
try {
  $finalHealth = Invoke-RestMethod -Uri $backendUrl -UseBasicParsing -TimeoutSec 2
  if ([string]$finalHealth.version -ne [string]$packageVersion) {
    throw "后端版本校验失败：收到 $($finalHealth.version)，预期 $packageVersion。"
  }
} catch {
  throw "工作台后端版本校验失败。$($_.Exception.Message)"
}
Wait-ForEndpoint "Web" $webUrl 35

if (-not $NoBrowser) {
  Start-Process $webUrl
}

Write-Host "Meta Code: $webUrl"
