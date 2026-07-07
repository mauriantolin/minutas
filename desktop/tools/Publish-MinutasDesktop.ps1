param(
  [string]$Runtime = "win-x64",
  [string]$PackageOutputPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "src\Minutas.Desktop\Minutas.Desktop.csproj"
$publishDir = Join-Path $root "publish\Minutix.Desktop-$Runtime"
$tempRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$buildRoot = Join-Path $tempRoot "MinutixDesktopPublish"

function Assert-ExpectedChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + $separator
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected path: $fullPath"
  }
}

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

Assert-ExpectedChildPath -Path $publishDir -Parent (Join-Path $root "publish")
Assert-ExpectedChildPath -Path $buildRoot -Parent $tempRoot

if (Test-Path $publishDir) {
  Remove-Item -LiteralPath $publishDir -Recurse -Force
}

if (Test-Path $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $publishDir, $buildRoot | Out-Null

& $dotnet publish $project `
  --configuration Release `
  --runtime $Runtime `
  --self-contained true `
  --output $publishDir `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:NuGetAudit=false `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  -p:BaseIntermediateOutputPath="$(Join-Path $buildRoot 'obj\')" `
  -p:BaseOutputPath="$(Join-Path $buildRoot 'bin\')"

Write-Host "Published:"
Write-Host (Join-Path $publishDir "Minutix.Desktop.exe")

if (-not [string]::IsNullOrWhiteSpace($PackageOutputPath)) {
  $packagePath = [System.IO.Path]::GetFullPath($PackageOutputPath)
  $packageDir = Split-Path -Parent $packagePath
  if ($packageDir) {
    New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
  }

  if (Test-Path $packagePath) {
    Remove-Item -LiteralPath $packagePath -Force
  }

  Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $packagePath -Force
  Write-Host "Packaged:"
  Write-Host $packagePath
}
