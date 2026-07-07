param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "src\Minutas.Desktop\Minutas.Desktop.csproj"
$configuration = if ($Release) { "Release" } else { "Debug" }
$tempRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$buildRoot = Join-Path $tempRoot "MinutixDesktopBuild"
$baseIntermediate = Join-Path $buildRoot "obj\"
$baseOutput = Join-Path $buildRoot "bin\"

$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
$dotnet = if ($dotnetCommand) { $dotnetCommand.Source } else { $null }
if (-not $dotnet -and (Test-Path "C:\Program Files\dotnet\dotnet.exe")) {
  $dotnet = "C:\Program Files\dotnet\dotnet.exe"
}

if (-not $dotnet) {
  Write-Host "dotnet SDK is not installed or not in PATH."
  Write-Host "Install it with:"
  Write-Host "  winget install Microsoft.DotNet.SDK.10"
  exit 1
}

New-Item -ItemType Directory -Force -Path $baseIntermediate, $baseOutput | Out-Null

& $dotnet run `
  --configuration $configuration `
  --project $project `
  -p:BaseIntermediateOutputPath="$baseIntermediate" `
  -p:BaseOutputPath="$baseOutput"
