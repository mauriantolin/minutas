<#
.SYNOPSIS
  High-frequency, LOSSLESS logger of the Teams RootWebArea patternText  -  the exact raw
  input the desktop watcher reads, BEFORE any filtering.

.DESCRIPTION
  Every poll it records one JSONL line per RootWebArea found under any Teams window:
  { ts, elapsedMs, windowName, rootName, isOffscreen, textLen, patternText }.

  Unlike Probe-TeamsUiAutomation.ps1 (full-tree dump, collapses whitespace, strips U+FFFC),
  this tool:
    - polls fast (default 250 ms) so we can measure what a 750 ms watcher poll MISSES,
    - preserves the raw U+FFFC (?) chunk separators  -  they delimit caption lines,
    - keeps ONLY the RootWebArea document text (cheap to scan, no 12k-element walk).

  Pair its output with a browser-side reference truth (groundtruth-devtools-observer.js or
  Zerg00s/Live-Captions-Saver) and run Analyze-CaptionRecall.py to compute recall and attribute
  every lost line to a pipeline stage.

.EXAMPLE
  # Record a whole meeting at 250 ms into a timestamped file, INCLUDING a stretch where you do
  # NOT touch the mouse for >15 s (to exercise the auto-hidden-toolbar root-gate hypothesis).
  powershell -ExecutionPolicy Bypass -File .\Log-TeamsCaptionGroundTruth.ps1 -DurationSeconds 900
#>
param(
  [int]$DurationSeconds = 900,
  [int]$PollIntervalMs = 250,
  [int]$MaxTextChars = 20000,
  [string]$WindowTitlePattern = "Teams|Microsoft Teams|Reuni|Llamada|Call|Captions|Subt",
  [string]$OutputPath = (Join-Path (Get-Location) ("teams-groundtruth-{0}.jsonl" -f (Get-Date -Format "yyyyMMdd-HHmmss")))
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Invoke-Safe { param([scriptblock]$Fn, $Fallback = $null) try { & $Fn } catch { $Fallback } }

$rootAutomationId = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
$rootWebAreaCond = New-Object System.Windows.Automation.PropertyCondition($rootAutomationId, "RootWebArea")

function Get-RootWebAreas {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = Invoke-Safe { $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } $null
  $result = New-Object System.Collections.Generic.List[object]
  if ($null -eq $windows) { return $result }
  foreach ($w in $windows) {
    $wname = Invoke-Safe { $w.Current.Name } ""
    if ([string]::IsNullOrWhiteSpace($wname) -or ($wname -notmatch $WindowTitlePattern)) { continue }
    $areas = Invoke-Safe { $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $rootWebAreaCond) } $null
    if ($null -eq $areas) { continue }
    foreach ($a in $areas) {
      $result.Add([pscustomobject]@{ Window = $wname; Area = $a })
    }
  }
  return $result
}

function Get-RawPatternText {
  param([System.Windows.Automation.AutomationElement]$Element)
  $out = ""
  $vp = Invoke-Safe { $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }
  if ($vp) {
    $v = Invoke-Safe { $vp.Current.Value } ""
    if (-not [string]::IsNullOrWhiteSpace($v)) { $out += $v }
  }
  $tp = Invoke-Safe { $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) }
  if ($tp) {
    $t = Invoke-Safe { $tp.DocumentRange.GetText($MaxTextChars) } ""
    if (-not [string]::IsNullOrWhiteSpace($t)) {
      # Preserve U+FFFC (object replacement char = chunk separator). Drop only U+FFFF (private).
      $t = $t -replace [string][char]0xffff, " "
      if ($out.Length -gt 0) { $out += ([string][char]0xfffc) }
      $out += $t
    }
  }
  return $out
}

Write-Host "Logging Teams RootWebArea patternText -> $OutputPath"
Write-Host "Poll=$PollIntervalMs ms  Duration=$DurationSeconds s. Ctrl+C to stop early."
Write-Host "TIP: leave a >15 s window with NO mouse movement to test the auto-hidden-toolbar hypothesis."

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$writer = [System.IO.StreamWriter]::new($OutputPath, $false, [System.Text.Encoding]::UTF8)
try {
  while ($sw.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $elapsedMs = [int]$sw.Elapsed.TotalMilliseconds
    foreach ($item in Get-RootWebAreas) {
      $a = $item.Area
      $pt = Get-RawPatternText $a
      if ([string]::IsNullOrWhiteSpace($pt)) { continue }
      $rec = [pscustomobject]@{
        ts          = (Get-Date).ToString("o")
        elapsedMs   = $elapsedMs
        windowName  = $item.Window
        rootName    = (Invoke-Safe { $a.Current.Name } "")
        isOffscreen = (Invoke-Safe { $a.Current.IsOffscreen } $null)
        textLen     = $pt.Length
        patternText = $pt
      }
      $writer.WriteLine(($rec | ConvertTo-Json -Compress -Depth 4))
    }
    $writer.Flush()
    Start-Sleep -Milliseconds $PollIntervalMs
  }
} finally {
  $writer.Dispose()
  Write-Host "Done. Wrote $OutputPath"
}
