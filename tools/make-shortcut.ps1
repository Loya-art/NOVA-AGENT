# ============================================================
#  make-shortcut.ps1 - create a desktop shortcut for NOVA Agent
#  Usage: powershell -File make-shortcut.ps1 -TargetDir "E:\NOVA-Agent"
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$TargetDir,
  [string]$LinkName = 'NOVA Agent'
)

$ErrorActionPreference = 'Stop'

$icon = Join-Path $TargetDir 'assets\icon.ico'
$bat  = Join-Path $TargetDir 'NOVA-AGENT.bat'

if (-not (Test-Path $bat)) { throw "launcher not found: $bat" }
if (-not (Test-Path $icon)) { $icon = '' }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$LinkName.lnk"

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = "$env:ComSpec"
$lnk.Arguments        = '/c "' + $bat + '"'
$lnk.WorkingDirectory = $TargetDir
if ($icon) { $lnk.IconLocation = $icon }
$lnk.Description       = 'NOVA Agent - portable AI agent (runs from the drive it is installed on)'
$lnk.Save()

Write-Host "shortcut created: $lnkPath"
