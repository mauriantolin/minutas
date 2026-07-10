<#
.SYNOPSIS
  VALIDATES OPTION B: does forcing Chromium renderer accessibility expose the Teams caption DOM
  as DISCRETE UIA nodes (author + text), instead of one flat RootWebArea.patternText blob?

.DESCRIPTION
  Chromium on Windows exposes IAccessible(MSAA), IAccessible2 and UI Automation, and maps between
  IA2 and UIA nodes. By default the renderer runs a reduced AXMode, which is why our RootWebArea
  has only empty scaffold Groups and all text collapses into patternText.
  `--force-renderer-accessibility=complete` forces the full AXMode for the whole process lifetime.

  Teams is a WebView2 host, so the flag is injected via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
  Teams-in-Edge is covered by launching msedge.exe with the flag directly.

  VERDICT the probe prints:
    FLAT       -> RootWebArea has ~no descendants with text; captions only live in patternText.
                  Option B is NOT viable by this mechanism.
    STRUCTURAL -> discrete descendant nodes carry caption author/text. Option B IS viable:
                  we can read captions by structure, name/locale/tenant independent.

.EXAMPLE
  # 1) BASELINE  -  Teams already running, in a meeting, captions ON:
  powershell -ExecutionPolicy Bypass -File .\Probe-ForcedAccessibility.ps1 -Label baseline

  # 2) FORCED  -  relaunch Teams with full AXMode, rejoin the meeting, captions ON, then:
  powershell -ExecutionPolicy Bypass -File .\Probe-ForcedAccessibility.ps1 -Relaunch -Target Teams
  #    ...rejoin meeting + enable captions, wait for a few caption lines, then:
  powershell -ExecutionPolicy Bypass -File .\Probe-ForcedAccessibility.ps1 -Label forced

  # Send me both JSONL files. The verdict line is what decides Option B.
#>
param(
  [ValidateSet("Teams", "Edge")][string]$Target = "Teams",
  [switch]$Relaunch,
  # Inherit the flag through the child process environment ONLY - never write the persisted user
  # variable. This is the shape a client installer could actually ship: the flag reaches the Teams
  # instance we launch and no other WebView2 app on the machine. The plain -Relaunch sets BOTH, so
  # it cannot tell us which one did the work.
  [switch]$NoPersist,
  [string]$Label = "probe",
  [int]$MaxDepth = 25,
  [int]$MaxElements = 20000,
  [string]$OutDir = (Get-Location)
)

$ErrorActionPreference = "Stop"
$FLAG = "--force-renderer-accessibility=complete"

# ---------------------------------------------------------------- relaunch mode
if ($Relaunch) {
  if ($Target -eq "Teams") {
    Write-Host "Closing Teams..." -ForegroundColor Yellow
    Get-Process -Name "ms-teams", "msteams", "Teams" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    $pkg = Get-AppxPackage -Name "MSTeams" -ErrorAction SilentlyContinue
    if (-not $pkg) { throw "MSTeams appx package not found. Use -Target Edge, or launch Teams manually with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$FLAG set." }
    $exe = Join-Path $pkg.InstallLocation "ms-teams.exe"
    if (-not (Test-Path $exe)) { throw "ms-teams.exe not found under $($pkg.InstallLocation)" }

    # Child process inherits this session's environment -> the flag reaches the WebView2 renderer.
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $FLAG

    if ($NoPersist) {
      # Prove the per-process inheritance alone is enough: a leftover user variable would make a
      # success meaningless, so refuse to run with one set.
      if ([Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "User")) {
        throw "The persisted user variable is still set, so a positive result would prove nothing. Clear it first: [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',`$null,'User')"
      }
      Write-Host "Launching Teams with $FLAG (process-scoped, nothing persisted)" -ForegroundColor Green
    }
    else {
      # Also persist for the user, so a Teams started from the shell/tray picks it up too.
      [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $FLAG, "User")
      Write-Host "Launching Teams with $FLAG (persisted user variable: affects EVERY WebView2 app)" -ForegroundColor Yellow
    }

    Start-Process -FilePath $exe
  }
  else {
    Write-Host "Closing Edge..." -ForegroundColor Yellow
    Get-Process -Name "msedge" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    Write-Host "Launching Edge with $FLAG" -ForegroundColor Green
    Start-Process "msedge.exe" -ArgumentList $FLAG, "https://teams.microsoft.com/v2/"
  }
  Write-Host ""
  Write-Host "NOW: rejoin the meeting, turn live captions ON, wait for a few caption lines." -ForegroundColor Cyan
  Write-Host "THEN run:  .\Probe-ForcedAccessibility.ps1 -Label forced" -ForegroundColor Cyan
  Write-Host ""
  if ($NoPersist) {
    Write-Host "Nothing was persisted. Close this Teams and reopen it normally to go back." -ForegroundColor DarkGray
    Write-Host "If -Label forced now reports STRUCTURAL, process-scoped inheritance is enough:" -ForegroundColor DarkGray
    Write-Host "the app can launch Teams itself and no other WebView2 app is affected." -ForegroundColor DarkGray
  }
  else {
    Write-Host "To undo later:  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',`$null,'User')" -ForegroundColor DarkGray
  }
  return
}

# ---------------------------------------------------------------- probe mode
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Invoke-Safe { param([scriptblock]$Fn, $Fallback = $null) try { & $Fn } catch { $Fallback } }

$outPath = Join-Path $OutDir ("teams-axprobe-{0}-{1}.jsonl" -f $Label, (Get-Date -Format "yyyyMMdd-HHmmss"))
$rootWebAreaCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty, "RootWebArea")

function Get-PatternText {
  param([System.Windows.Automation.AutomationElement]$El)
  $tp = Invoke-Safe { $El.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) }
  if ($tp) { return (Invoke-Safe { $tp.DocumentRange.GetText(20000) } "") }
  return ""
}

$records = New-Object System.Collections.Generic.List[object]
$count = 0

# Mirrors TeamsCaptionWatcher.GetStructuralCaptions  -  keep the two in sync.
function Get-StructuralCaptions {
  param([System.Windows.Automation.AutomationElement]$Root)
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $grpCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Group)
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $buttons = Invoke-Safe { $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) } $null
  if ($null -eq $buttons) { return @() }
  foreach ($b in $buttons) {
    $aid = Invoke-Safe { $b.Current.AutomationId } ""
    if ($aid -notmatch "captions") { continue }
    $container = Invoke-Safe { $walker.GetParent($b) } $null
    if ($null -eq $container) { continue }
    $groups = Invoke-Safe { $container.FindAll([System.Windows.Automation.TreeScope]::Descendants, $grpCond) } $null
    if ($null -eq $groups) { continue }
    $items = @()
    foreach ($g in $groups) {
      $texts = @()
      $c = Invoke-Safe { $walker.GetFirstChild($g) } $null
      while ($null -ne $c) {
        $isText = Invoke-Safe { $c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } $false
        if ($isText) {
          $n = Invoke-Safe { $c.Current.Name } ""
          if (-not [string]::IsNullOrWhiteSpace($n)) { $texts += $n.Trim() }
        }
        $c = Invoke-Safe { $walker.GetNextSibling($c) } $null
      }
      if ($texts.Count -ge 2) { $items += [pscustomobject]@{ controlType = "CaptionItem"; name = ("{0}: {1}" -f $texts[0], $texts[-1]) } }
    }
    if ($items.Count -gt 0) { return $items }
  }
  return @()
}

function Walk {
  param([System.Windows.Automation.AutomationElement]$El, [int]$Depth)
  if ($script:count -ge $MaxElements -or $Depth -gt $MaxDepth) { return }
  $script:count++
  $name = Invoke-Safe { $El.Current.Name } ""
  $ct = Invoke-Safe { $El.Current.ControlType.ProgrammaticName } ""
  $records.Add([pscustomobject]@{
      depth        = $Depth
      controlType  = $ct
      name         = $name
      automationId = (Invoke-Safe { $El.Current.AutomationId } "")
      className    = (Invoke-Safe { $El.Current.ClassName } "")
    })
  $kids = Invoke-Safe { $El.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } $null
  if ($null -eq $kids) { return }
  foreach ($k in $kids) { Walk -El $k -Depth ($Depth + 1) }
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

$areas = New-Object System.Collections.Generic.List[object]
foreach ($w in $windows) {
  $wn = Invoke-Safe { $w.Current.Name } ""
  if ([string]::IsNullOrWhiteSpace($wn) -or ($wn -notmatch "Teams|Reuni|Llamada|Call")) { continue }
  $found = Invoke-Safe { $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $rootWebAreaCond) } $null
  if ($null -ne $found) { foreach ($a in $found) { $areas.Add([pscustomobject]@{ Window = $wn; Area = $a }) } }
}

if ($areas.Count -eq 0) { throw "No Teams RootWebArea found. Is Teams open and in a meeting?" }

$writer = [System.IO.StreamWriter]::new($outPath, $false, [System.Text.Encoding]::UTF8)
$verdicts = @()
try {
  foreach ($item in $areas) {
    $script:count = 0
    $records.Clear()
    Walk -El $item.Area -Depth 0
    $pt = Get-PatternText $item.Area

    # STRUCTURAL means the caption pane exposes one discrete subtree per utterance. We run the
    # SAME algorithm the app uses: anchor on the sibling Button whose AutomationId contains
    # "captions" (stable, locale/tenant independent), take its parent, then collect descendant
    # Groups having >=2 direct Text children (author ... text).
    # Do NOT score on "nodes with >=3 words"  -  chrome labels ("Controles de llamada") match that.
    $named = @($records | Where-Object { $_.depth -gt 0 -and -not [string]::IsNullOrWhiteSpace($_.name) })
    $captionish = @(Get-StructuralCaptions $item.Area)

    $verdict = if ($captionish.Count -ge 1) { "STRUCTURAL" } elseif ($named.Count -le 5) { "FLAT" } else { "PARTIAL" }
    $verdicts += $verdict

    foreach ($r in $records) {
      $writer.WriteLine(($r | ConvertTo-Json -Compress -Depth 3))
    }
    $writer.WriteLine((([pscustomobject]@{ marker = "SUMMARY"; window = $item.Window; descendants = $records.Count; namedDescendants = $named.Count; captionishNodes = $captionish.Count; patternTextLen = $pt.Length; verdict = $verdict }) | ConvertTo-Json -Compress -Depth 3))

    Write-Host ""
    Write-Host ("WINDOW: {0}" -f $item.Window)
    Write-Host ("  descendants of RootWebArea : {0}" -f $records.Count)
    Write-Host ("  with a non-empty Name      : {0}" -f $named.Count)
    Write-Host ("  caption-ish (>=3 words)    : {0}" -f $captionish.Count)
    Write-Host ("  patternText length         : {0}" -f $pt.Length)
    Write-Host ("  VERDICT                    : {0}" -f $verdict) -ForegroundColor (@{FLAT = "Red"; PARTIAL = "Yellow"; STRUCTURAL = "Green" }[$verdict])
    if ($captionish.Count -gt 0) {
      Write-Host "  sample caption-ish nodes:"
      $captionish | Select-Object -First 5 | ForEach-Object { Write-Host ("    [{0}] {1}" -f $_.controlType, $_.name.Substring(0, [Math]::Min(80, $_.name.Length))) }
    }
  }
} finally { $writer.Dispose() }

Write-Host ""
Write-Host ("Wrote {0}" -f $outPath) -ForegroundColor Green
if ($verdicts -contains "STRUCTURAL") {
  Write-Host "=> OPTION B IS VIABLE: captions are readable as discrete UIA nodes." -ForegroundColor Green
}
else {
  Write-Host "=> OPTION B NOT PROVEN by this mechanism (still FLAT/PARTIAL). Send the JSONL anyway." -ForegroundColor Yellow
}
