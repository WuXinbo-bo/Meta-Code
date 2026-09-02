param(
  [switch]$RefreshAddon
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot ".runtime"
$uvDir = Join-Path $runtimeDir "tools\uv"
$integrationDir = Join-Path $projectRoot "integrations\blender-mcp"
$addonPath = Join-Path $integrationDir "addon.py"
$uvxPath = Join-Path $uvDir "uvx.exe"

New-Item -ItemType Directory -Force -Path $uvDir, $integrationDir | Out-Null

if (-not (Test-Path -LiteralPath $uvxPath)) {
  $env:UV_INSTALL_DIR = $uvDir
  $env:UV_NO_MODIFY_PATH = "1"
  Invoke-RestMethod "https://astral.sh/uv/install.ps1" | Invoke-Expression
}

if ($RefreshAddon -or -not (Test-Path -LiteralPath $addonPath)) {
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/MCPBlender/blender-mcp/main/addon.py" -OutFile $addonPath
}

& $uvxPath --version
Write-Output "Blender addon: $addonPath"
Write-Output "MCP command: $uvxPath blender-mcp"
