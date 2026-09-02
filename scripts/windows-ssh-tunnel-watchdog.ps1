param(
  [Parameter(Mandatory = $true)][int]$LocalPort,
  [Parameter(Mandatory = $true)][int]$RemotePort
)

$ErrorActionPreference = "SilentlyContinue"
$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
$target = "root@dancaixin-desktop.tail32cf0a.ts.net"
$logDir = Join-Path (Split-Path $PSScriptRoot -Parent) ".runtime"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "tunnel-$LocalPort.log"

while ($true) {
  $occupied = Get-NetTCPConnection -State Listen -LocalPort $LocalPort | Select-Object -First 1
  if ($occupied) {
    Start-Sleep -Seconds 5
    continue
  }

  "$(Get-Date -Format o) connecting localhost:$LocalPort -> server:$RemotePort" | Add-Content -Path $log
  & $ssh -p 2222 -N `
    -L "${LocalPort}:127.0.0.1:${RemotePort}" `
    -o ExitOnForwardFailure=yes `
    -o ConnectTimeout=10 `
    -o ConnectionAttempts=3 `
    -o ServerAliveInterval=15 `
    -o ServerAliveCountMax=20 `
    -o TCPKeepAlive=yes `
    $target 2>> $log
  "$(Get-Date -Format o) disconnected; retrying" | Add-Content -Path $log
  Start-Sleep -Seconds 3
}
