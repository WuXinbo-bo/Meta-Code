param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataRoot = if ($env:METACODE_HOME) { $env:METACODE_HOME } elseif ($env:WORKBENCH_DATA_DIR) { $env:WORKBENCH_DATA_DIR } elseif ($env:WORKBENCH_RUNTIME_DIR) { $env:WORKBENCH_RUNTIME_DIR } elseif ($env:METACODE_PROFILE) { Join-Path $env:USERPROFILE ".metacode-$($env:METACODE_PROFILE)" } else { Join-Path $env:USERPROFILE ".metacode" }
$env:METACODE_HOME = $dataRoot

# One source of truth for the development launcher. Vite and the server
# consume the same environment variables when started via npm.
$backendPort = if ($env:WORKBENCH_API_PORT) { [int]$env:WORKBENCH_API_PORT } elseif ($env:METACODE_BACKEND_PORT) { [int]$env:METACODE_BACKEND_PORT } else { 4338 }
$webPort = if ($env:WORKBENCH_WEB_PORT) { [int]$env:WORKBENCH_WEB_PORT } else { 4339 }
$env:WORKBENCH_API_PORT = [string]$backendPort
$env:PORT = [string]$backendPort
$env:WORKBENCH_WEB_PORT = [string]$webPort
$runtimeLogRoot = Join-Path $dataRoot "logs"
$instanceManifestPath = Join-Path $runtimeLogRoot "development-instance.json"
$backendUrl = "http://127.0.0.1:$backendPort/api/health"
$webUrl = "http://127.0.0.1:$webPort/"
$packageVersion = node -p "require('./package.json').version"
$startedProcesses = @()

function Test-HttpEndpoint([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-HttpJson([string]$Url) {
  try { return Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec 2 } catch { return $null }
}

function Get-PortConnection([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-ListeningPort([int]$Port) { return [bool](Get-PortConnection $Port) }

function Get-PortOwner([int]$Port) {
  $connection = Get-PortConnection $Port
  if (-not $connection) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-ProjectProcess($Owner) {
  if (-not $Owner) { return $false }
  return ([string]$Owner.CommandLine -like "*$projectRoot*")
}

function Stop-ExactProcess([int]$ProcessId, [string]$Name) {
  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
  Write-Host "Stopping stale $Name process (PID $ProcessId)..."
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 350
}

function Stop-PortOwner([int]$Port, [string]$Name) {
  $owner = Get-PortOwner $Port
  if (-not $owner) { throw "端口 $Port 已被占用，但无法识别占用进程，不能安全启动 $Name。" }
  if (-not (Test-ProjectProcess $owner)) {
    throw "端口 $Port 已被其他项目占用（PID $($owner.ProcessId)）。请先关闭占用该端口的服务。"
  }
  Stop-ExactProcess ([int]$owner.ProcessId) $Name
  if (Test-ListeningPort $Port) { throw "$Name 端口 $Port 仍被占用，无法安全启动。" }
}

function Write-InstanceManifest([string]$Status, [int]$BackendPid = 0, [int]$WebPid = 0) {
  [ordered]@{
    productId = "meta-code"
    role = "development"
    projectRoot = $projectRoot
    backendPort = $backendPort
    webPort = $webPort
    backendPid = $BackendPid
    webPid = $WebPid
    version = [string]$packageVersion
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $instanceManifestPath -Encoding UTF8
}

function Get-InstanceManifest {
  if (-not (Test-Path -LiteralPath $instanceManifestPath)) { return $null }
  try { return Get-Content -LiteralPath $instanceManifestPath -Raw | ConvertFrom-Json } catch { return $null }
}

function Start-NodeService([string]$Name, [string[]]$Arguments, [int]$Port) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $stdout = Join-Path $runtimeLogRoot "$Name.out.log"
  $stderr = Join-Path $runtimeLogRoot "$Name.err.log"
  $process = Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $script:startedProcesses += [pscustomobject]@{ Name = $Name; Id = [int]$process.Id; Port = $Port }
  Write-Host "Starting $Name on port $Port (PID $($process.Id))..."
  return $process
}

function Wait-ForEndpoint([string]$Name, [string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Url) { Write-Host "$Name is ready."; return }
    Start-Sleep -Milliseconds 400
  }
  throw "$Name did not become ready. Check $runtimeLogRoot for details."
}

function Cleanup-StartedProcesses {
  foreach ($entry in @($startedProcesses | Sort-Object -Property Name -Descending)) { Stop-ExactProcess $entry.Id $entry.Name }
  $script:startedProcesses = @()
}

Set-Location $projectRoot
if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) { throw "Dependencies are missing. Run npm install in $projectRoot first." }
New-Item -ItemType Directory -Path $runtimeLogRoot -Force | Out-Null

try {
  $existingManifest = Get-InstanceManifest
  $manifestMatches = $existingManifest -and [string]$existingManifest.projectRoot -eq [string]$projectRoot -and [int]$existingManifest.backendPort -eq $backendPort -and [int]$existingManifest.webPort -eq $webPort -and [string]$existingManifest.version -eq [string]$packageVersion
  $backendHealth = Get-HttpJson $backendUrl
  $backendOwner = Get-PortOwner $backendPort
  $backendReady = $backendHealth -and $backendHealth.ok -eq $true -and [string]$backendHealth.productId -eq "meta-code" -and [string]$backendHealth.version -eq [string]$packageVersion -and $backendOwner -and (Test-ProjectProcess $backendOwner) -and ((-not $existingManifest) -or $manifestMatches)
  if ($backendReady -and $backendOwner -and (Test-ProjectProcess $backendOwner)) {
    Write-Host "Reusing healthy Meta Code backend on port $backendPort."
  } elseif (Test-ListeningPort $backendPort) {
    Stop-PortOwner $backendPort "backend"
  }

  $webHealth = Test-HttpEndpoint $webUrl
  $webOwner = Get-PortOwner $webPort
  $webReady = $webHealth -and $webOwner -and (Test-ProjectProcess $webOwner) -and $backendReady
  if ($webReady) { Write-Host "Reusing healthy Meta Code web server on port $webPort." }
  elseif (Test-ListeningPort $webPort) { Stop-PortOwner $webPort "web" }

  $backendProcess = if ($backendReady) { $null } else { Start-NodeService "backend" @((Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"), "server/index.ts") $backendPort }
  $webProcess = if ($webReady) { $null } else { Start-NodeService "web" @((Join-Path $projectRoot "node_modules\vite\bin\vite.js"), "--host", "127.0.0.1", "--port", [string]$webPort) $webPort }
  $manifestBackendPid = if ($backendProcess) { [int]$backendProcess.Id } elseif ($backendOwner) { [int]$backendOwner.ProcessId } else { 0 }
  $manifestWebPid = if ($webProcess) { [int]$webProcess.Id } elseif ($webOwner) { [int]$webOwner.ProcessId } else { 0 }
  Write-InstanceManifest "starting" $manifestBackendPid $manifestWebPid

  Wait-ForEndpoint "Backend" $backendUrl 35
  $finalHealth = Get-HttpJson $backendUrl
  if (-not $finalHealth -or $finalHealth.ok -ne $true -or [string]$finalHealth.productId -ne "meta-code" -or [string]$finalHealth.version -ne [string]$packageVersion) {
    $actual = if ($finalHealth) { "$($finalHealth.productId)@$($finalHealth.version)" } else { "unavailable" }
    throw "工作台后端版本校验失败：收到 $actual，预期 meta-code@$packageVersion。"
  }
  Wait-ForEndpoint "Web" $webUrl 35
  Write-InstanceManifest "ready" $manifestBackendPid $manifestWebPid
} catch {
  Write-InstanceManifest "failed"
  Cleanup-StartedProcesses
  throw
}

if (-not $NoBrowser) { Start-Process $webUrl }
Write-Host "Meta Code: $webUrl"
Write-Host "Instance manifest: $instanceManifestPath"
