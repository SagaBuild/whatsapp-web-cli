[CmdletBinding()]
param([string]$Destination)
$ErrorActionPreference = 'Stop'
$waInstallArgs = @((Join-Path $PSScriptRoot 'install.mjs'))
if ($Destination) { $waInstallArgs += @('--destination', $Destination) }
& node @waInstallArgs
if ($LASTEXITCODE -ne 0) { throw 'Skill installation failed. See the preceding error.' }
