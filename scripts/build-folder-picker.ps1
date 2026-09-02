[CmdletBinding()]
param(
  [string]$OutputPath = ""
)

$sourcePath = Join-Path $PSScriptRoot "..\native\FolderPicker\Program.cs"
$defaultOutputPath = Join-Path $PSScriptRoot "..\server-assets\FolderPicker.exe"
$compilerPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compilerPath)) {
  throw "未找到 Windows .NET Framework C# 编译器：$compilerPath"
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "未找到 FolderPicker 源文件：$sourcePath"
}

$resolvedOutput = [System.IO.Path]::GetFullPath($(if ($OutputPath) { $OutputPath } else { $defaultOutputPath }))
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutput) | Out-Null
& $compilerPath /nologo /target:winexe /platform:anycpu /optimize+ "/out:$resolvedOutput" $sourcePath
if ($LASTEXITCODE -ne 0) {
  throw "FolderPicker.exe 编译失败，退出代码：$LASTEXITCODE"
}

Write-Output "已生成 $resolvedOutput"
