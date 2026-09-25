[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'object-tracker-installer.iss'
$readmeSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\install-and-use.md'
$outputFile = Join-Path $OutputDirectory 'Object Tracker-Setup-0.1.0.exe'

$compilerCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)
$compiler = $compilerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (!$compiler) { throw 'Inno Setup 6 or 7 is required to build the installer. Install it from https://jrsoftware.org/isdl.php and run this script again.' }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $OutputDirectory 'README.txt') -Force
& $compiler "--output-dir=$OutputDirectory" $scriptFile
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compiler failed with exit code $LASTEXITCODE." }
Write-Host "Created $outputFile"
