<#
.SYNOPSIS
  Finds a way to make Chromium expose the FULL accessibility tree (discrete caption nodes) on ANY
  client machine  -  without the global WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var and WITHOUT
  restarting Teams.

.DESCRIPTION
  Screen readers (NVDA/JAWS) get Chromium's full tree with no flags: they announce themselves as
  assistive-technology clients and Chromium escalates its AXMode. This probe tests, empirically,
  which activation handshake (if any) does that  -  because the Chromium docs do not state it.

  It applies each candidate trigger against the Teams renderer HWNDs, then re-scans the meeting
  RootWebArea with the SAME structural reader the app uses (anchor on the captions Buttons'
  AutomationId) and reports how many discrete caption utterances became visible.

  TRIGGERS, least invasive first:
    none        control - plain UIA read (what the app does today)
    msaa        AccessibleObjectFromWindow(OBJID_CLIENT, IAccessible)   -> usually enables "basic"
    ia2         + QueryService(IID_IAccessible2)                        -> the NVDA/JAWS handshake
    simpledom   + QueryService(ISimpleDOMNode)                          -> historic "kHTML" signal
    uia-root    WM_GETOBJECT(lParam = UiaRootObjectId)                  -> native UIA provider
    screenreader SPI_SETSCREENREADER on                                 -> legacy AT signal, restored after

  COM references obtained are held alive for the process lifetime: Chromium auto-disables
  accessibility once no AT client is listening, so a real implementation must keep them too.

  POSITIVE CONTROL: an open captions pane is NOT the same as a pane with lines. With no captions
  on screen every trigger reports zero nodes and the run proves nothing. So the probe snapshots
  the patternText chunks, asks you to SPEAK, and looks for genuinely new ones. Digits are
  normalised away first, because the toolbar chunk carries the elapsed-time clock and would
  otherwise look new every second - it fooled an earlier version of this probe.
  It then ASKS whether captions are visible on screen, and aborts if they are not. If they are
  visible yet reached neither the structural tree nor patternText, that is reported as a distinct
  finding: the shipped flat parser would be blind too, and this is no longer an AXMode question.

.PREREQUISITES  (this is what makes the result representative of a fresh client install)
  1. Clear the env var and RESTART Teams, otherwise you are measuring the forced path:
       [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',$null,'User')
     then fully quit Teams (tray icon -> Quit) and reopen it.
  2. Join a meeting and turn live captions ON.
  3. Run this script. When it says SPEAK NOW, say a couple of full sentences out loud.
     It prints a table; send me the JSON it writes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Probe-AccessibilityActivation.ps1
#>
param(
  [int]$SettleSeconds = 3,
  [int]$AutoDisableCheckSeconds = 35,
  [string]$OutPath = (Join-Path (Get-Location) ("teams-a11y-activation-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss")))
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Only the PERSISTED (User) var matters: that is what a freshly started Teams inherits. This
# PowerShell session's own $env: copy is irrelevant here (we never launch Teams) and warning on
# it produced a false alarm.
if ([Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "User")) {
  Write-Host "WARNING: the persisted WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is still set." -ForegroundColor Red
  Write-Host "         Clear it, restart Teams, rerun. Otherwise you measure the forced path." -ForegroundColor Red
  Write-Host ""
}

# Objective evidence of whether Teams was restarted after the var was cleared.
# StartTime throws Access Denied on protected processes, and $ErrorActionPreference is Stop.
try {
  Get-Process -Name "ms-teams", "msteams" -ErrorAction SilentlyContinue |
  Sort-Object StartTime -ErrorAction SilentlyContinue | Select-Object -First 1 |
  ForEach-Object { Write-Host ("Teams process started at: {0}" -f $_.StartTime) -ForegroundColor DarkGray }
}
catch { Write-Host "Teams process start time: unavailable" -ForegroundColor DarkGray }

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class A11yActivation {
  public const uint OBJID_CLIENT = 0xFFFFFFFC;
  public const int  UiaRootObjectId = -25;
  public const uint WM_GETOBJECT = 0x003D;

  // Keeps every AT reference alive: Chromium auto-disables accessibility when no client holds one.
  public static List<object> Kept = new List<object>();

  [DllImport("oleacc.dll")]
  public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid,
    [MarshalAs(UnmanagedType.IUnknown)] out object ppv);

  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IServiceProvider {
    [PreserveSig] int QueryService(ref Guid guidService, ref Guid riid, out IntPtr ppv);
  }

  public static List<IntPtr> RendererWindows(IntPtr top) {
    var found = new List<IntPtr>();
    EnumChildWindows(top, (h, l) => {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      var cls = sb.ToString();
      if (cls.StartsWith("Chrome_RenderWidgetHostHWND") || cls.StartsWith("Chrome_WidgetWin"))
        found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Returns "ok" / "hr=0x..." / "no-sp" so a wrong GUID shows up as a failed handshake,
  // not as a silent false negative.
  public static string Handshake(IntPtr hwnd, string service) {
    var iidAccessible = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    object acc;
    int hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iidAccessible, out acc);
    if (hr != 0 || acc == null) return "msaa-fail hr=0x" + hr.ToString("X8");
    Kept.Add(acc);
    if (service == "msaa") return "ok";

    var sp = acc as IServiceProvider;
    if (sp == null) return "no-serviceprovider";

    Guid svc;
    if (service == "ia2") svc = new Guid("E89F726E-C4F4-4c19-BB19-B647D7FA8478");        // IAccessible2
    else if (service == "simpledom") svc = new Guid("1814ceeb-49e2-407f-af99-fa755a7d2607"); // ISimpleDOMNode
    else return "unknown-service";

    var riid = svc;
    IntPtr ppv;
    hr = sp.QueryService(ref svc, ref riid, out ppv);
    if (hr != 0 || ppv == IntPtr.Zero) return "queryservice-fail hr=0x" + hr.ToString("X8");
    Kept.Add(Marshal.GetObjectForIUnknown(ppv));
    Marshal.Release(ppv);
    return "ok";
  }

  public static string UiaRoot(IntPtr hwnd) {
    var r = SendMessage(hwnd, WM_GETOBJECT, IntPtr.Zero, new IntPtr(UiaRootObjectId));
    return r == IntPtr.Zero ? "wm_getobject-returned-0" : "ok";
  }

  // Legacy system-wide "a screen reader is running" flag. Chromium has historically consulted it.
  // Reversible and not persisted (SPIF_SENDCHANGE only, no SPIF_UPDATEINIFILE).
  public const uint SPI_SETSCREENREADER = 0x0047;
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
  public static string SetScreenReader(bool on) {
    return SystemParametersInfo(SPI_SETSCREENREADER, on ? 1u : 0u, IntPtr.Zero, 2) ? "ok" : "spi-failed";
  }
}
"@

function Invoke-Safe { param([scriptblock]$Fn, $Fallback = $null) try { & $Fn } catch { $Fallback } }

# --- structural reader: identical to TeamsCaptionWatcher.GetStructuralCaptions -----------------
function Get-StructuralCaptions {
  param([System.Windows.Automation.AutomationElement]$Root)
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $grpCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Group)
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
        if (Invoke-Safe { $c.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } $false) {
          $n = Invoke-Safe { $c.Current.Name } ""
          if (-not [string]::IsNullOrWhiteSpace($n)) { $texts += $n.Trim() }
        }
        $c = Invoke-Safe { $walker.GetNextSibling($c) } $null
      }
      if ($texts.Count -ge 2) { $items += [pscustomobject]@{ speaker = $texts[0]; text = $texts[-1] } }
    }
    if ($items.Count -gt 0) { return $items }
  }
  return @()
}

function Get-MeetingRoots {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, "RootWebArea")
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $out = @()
  foreach ($w in $wins) {
    $n = Invoke-Safe { $w.Current.Name } ""
    if ([string]::IsNullOrWhiteSpace($n) -or $n -notmatch "Teams|Reuni|Llamada|Call") { continue }
    if ($n -match "^\s*(Chat|Calendar|Calendario|Planner|Activity|Files)\s*\|") { continue }
    $hwnd = [IntPtr](Invoke-Safe { $w.Current.NativeWindowHandle } 0)
    $areas = Invoke-Safe { $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) } $null
    if ($null -eq $areas) { continue }
    foreach ($a in $areas) { $out += [pscustomobject]@{ Window = $n; Hwnd = $hwnd; Area = $a } }
  }
  return , @($out)   # comma keeps it an array even with 0/1 elements, so .Count is never $null
}

# POSITIVE CONTROL. Without it, "0 caption nodes" is ambiguous: it could mean the AXMode never
# escalated, OR simply that no captions were on screen. The captions pane is proven open when a
# Button whose AutomationId contains "captions" exists (locale/tenant independent). And the flat
# patternText tells us whether Teams is actually rendering caption lines right now.
function Get-PaneState {
  param([System.Windows.Automation.AutomationElement]$Root)
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = Invoke-Safe { $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) } $null
  $pane = $false
  if ($null -ne $buttons) {
    foreach ($b in $buttons) { if ((Invoke-Safe { $b.Current.AutomationId } "") -match "captions") { $pane = $true; break } }
  }
  $pt = ""
  $tp = Invoke-Safe { $Root.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) }
  if ($tp) { $pt = Invoke-Safe { $tp.DocumentRange.GetText(20000) } "" }
  return [pscustomobject]@{ paneOpen = $pane; patternTextLen = $pt.Length; patternTextTail = ($pt.Substring([Math]::Max(0, $pt.Length - 400))) }
}

function Measure-Captions {
  $best = 0; $sample = $null; $win = ""; $pane = $false; $ptLen = 0; $tail = ""
  foreach ($r in Get-MeetingRoots) {
    $state = Get-PaneState $r.Area
    if ($state.paneOpen) { $pane = $true }
    if ($state.patternTextLen -gt $ptLen) { $ptLen = $state.patternTextLen; $tail = $state.patternTextTail }
    $caps = @(Get-StructuralCaptions $r.Area)
    if ($caps.Count -gt $best) { $best = $caps.Count; $sample = $caps[0]; $win = $r.Window }
  }
  return [pscustomobject]@{ count = $best; sample = $sample; window = $win; paneOpen = $pane; patternTextLen = $ptLen; patternTextTail = $tail }
}

# --- run the matrix ----------------------------------------------------------------------------
$roots = Get-MeetingRoots
if ($roots.Count -eq 0) { throw "No Teams meeting RootWebArea found. Join a meeting, enable captions, retry." }

# ABORT unless captions are demonstrably on screen. Otherwise every trigger reports 0 caption
# nodes and the run looks like a negative result when it measured nothing at all.
$pre = Measure-Captions
Write-Host ("precondition: captionsPane={0} patternTextLen={1}" -f $pre.paneOpen, $pre.patternTextLen)
if (-not $pre.paneOpen) {
  throw "Captions pane NOT found (no Button with AutomationId ~ 'captions'). You are not in a meeting with live captions ON. This run would be meaningless. Enable captions, let a few lines appear, then rerun."
}

# An OPEN pane is not the same as a pane WITH LINES. A previous run reported a "valid negative"
# from a meeting where nobody had spoken: every trigger reports zero caption nodes when there are
# no captions at all. So prove captions are flowing, without eyeballing and without depending on
# names or locale: snapshot the patternText chunks, have the operator speak, and require NEW
# chunks to appear. Those new chunks ARE the caption lines.
# Digits are normalised away before comparing: the meeting toolbar chunk embeds the elapsed-time
# clock ("14:39 Chat Gente ..."), so it changes every second and would otherwise masquerade as a
# brand-new caption line. It did, and the probe believed it.
function Get-Chunks {
  $sep = [char]0xfffc
  $map = @{}
  foreach ($r in Get-MeetingRoots) {
    $tp = Invoke-Safe { $r.Area.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) }
    if (-not $tp) { continue }
    $pt = Invoke-Safe { $tp.DocumentRange.GetText(20000) } ""
    foreach ($c in $pt.Split($sep)) {
      $raw = ($c -replace '\s+', ' ').Trim()
      if ($raw.Length -eq 0) { continue }
      $key = $raw -replace '\d', '#'
      $map[$key] = $raw
    }
  }
  return $map
}

# Two samples 3s apart so anything that churns on its own is already in the "before" set.
$b1 = Get-Chunks; Start-Sleep -Seconds 3; $b2 = Get-Chunks
$before = New-Object System.Collections.Generic.HashSet[string]
foreach ($k in $b1.Keys) { [void]$before.Add($k) }
foreach ($k in $b2.Keys) { [void]$before.Add($k) }

Write-Host ""
Write-Host "SPEAK NOW - say a couple of full sentences out loud, WITH YOUR MIC UNMUTED." -ForegroundColor Cyan
Write-Host "Waiting up to 60s for new caption lines to appear in patternText..." -ForegroundColor Cyan
$spoken = @()
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  $after = Get-Chunks
  $new = @()
  foreach ($k in $after.Keys) {
    if ($before.Contains($k)) { continue }
    if (($after[$k] -split '\s+').Count -lt 3) { continue }
    $new += $after[$k]
  }
  if ($new.Count -ge 1) { $spoken = $new; break }
  Write-Host "  ...still nothing new" -ForegroundColor DarkGray
}

if ($spoken.Count -gt 0) {
  Write-Host ("New caption-like chunk(s) in patternText: {0}" -f $spoken.Count) -ForegroundColor Green
  $spoken | Select-Object -First 3 | ForEach-Object { Write-Host ("  + {0}" -f $_) -ForegroundColor Green }
}
else {
  Write-Host "No new chunks appeared in patternText." -ForegroundColor Yellow
}

# The machine check can only see patternText. Ask the human what Teams actually DISPLAYED: if
# captions are visible on screen but absent from patternText too, that is a different and worse
# finding than "the AXMode did not escalate" - the shipped flat parser would be blind as well.
Write-Host ""
$seen = Read-Host "Do you SEE caption text (spoken words) in the Teams window right now? [y/n]"
$captionsVisible = $seen -match '^(y|s)'
if (-not $captionsVisible) {
  throw "Captions are not being displayed. Every trigger reports zero nodes when there is nothing to read, so this run would prove nothing. Unmute your mic, confirm caption text appears in Teams, then rerun."
}
if ($spoken.Count -eq 0) {
  Write-Host "NOTE: captions are visible on screen but did NOT appear in patternText." -ForegroundColor Magenta
  Write-Host "      That is a separate finding: the flat parser cannot see them either." -ForegroundColor Magenta
}
Write-Host ""
# No magic length threshold: a real forced run with 3 caption lines measured only 814 chars, so
# any cutoff would reject valid runs. Show the tail instead and let the operator confirm that
# spoken lines are present before trusting a zero.
Write-Host "patternText tail (confirm you can see spoken caption lines here):" -ForegroundColor DarkGray
$sep = [string][char]0xfffc
$tail = $pre.patternTextTail
$tail = $tail.Replace("`r", " ").Replace("`n", " ").Replace($sep, " | ")
Write-Host ("  " + $tail) -ForegroundColor DarkGray
Write-Host ""

$targets = @()
foreach ($r in $roots) {
  if ($r.Hwnd -ne [IntPtr]::Zero) { $targets += [A11yActivation]::RendererWindows($r.Hwnd) }
}
$targets = @($targets | Select-Object -Unique)
Write-Host ("Teams meeting roots: {0} | renderer HWNDs: {1}" -f $roots.Count, $targets.Count)
Write-Host ""

$results = @()
$screenReaderSet = $false
foreach ($trigger in @("none", "msaa", "ia2", "simpledom", "uia-root", "screenreader")) {
  $status = @()
  if ($trigger -eq "screenreader") {
    $status += [A11yActivation]::SetScreenReader($true)
    $screenReaderSet = $true
    Start-Sleep -Seconds $SettleSeconds
  }
  elseif ($trigger -ne "none") {
    foreach ($h in $targets) {
      $s = if ($trigger -eq "uia-root") { [A11yActivation]::UiaRoot($h) } else { [A11yActivation]::Handshake($h, $trigger) }
      $status += $s
    }
    Start-Sleep -Seconds $SettleSeconds
  }
  $m = Measure-Captions
  $results += [pscustomobject]@{
    trigger         = $trigger
    handshake       = ($status | Select-Object -Unique) -join ","
    captionNodes    = $m.count
    paneOpen        = $m.paneOpen
    patternTextLen  = $m.patternTextLen
    patternTextTail = $m.patternTextTail
    sampleSpeaker   = $m.sample.speaker
    sampleText      = $m.sample.text
  }
  $color = if ($m.count -gt 0) { "Green" } else { "DarkGray" }
  Write-Host ("{0,-10} handshake={1,-28} captionNodes={2}" -f $trigger, (($status | Select-Object -Unique) -join ","), $m.count) -ForegroundColor $color
  if ($m.count -gt 0 -and $m.sample) { Write-Host ("           e.g. {0}: {1}" -f $m.sample.speaker, $m.sample.text) }
}

# Auto-disable check: Chromium drops accessibility when no client is listening. We still hold the
# COM refs, so captions must REMAIN visible. If they vanish, the app must re-handshake periodically.
$first = $results | Where-Object { $_.captionNodes -gt 0 } | Select-Object -First 1
if ($first) {
  Write-Host ""
  Write-Host ("Holding AT references, re-checking in {0}s (auto-disable test)..." -f $AutoDisableCheckSeconds)
  Start-Sleep -Seconds $AutoDisableCheckSeconds
  $after = Measure-Captions
  Write-Host ("after {0}s: captionNodes={1}" -f $AutoDisableCheckSeconds, $after.count) -ForegroundColor (@{$true = "Green"; $false = "Red" }[$after.count -gt 0])
  $results += [pscustomobject]@{ trigger = "hold-$AutoDisableCheckSeconds`s"; handshake = "kept-refs"; captionNodes = $after.count; sampleSpeaker = $after.sample.speaker; sampleText = $after.sample.text }
}

if ($screenReaderSet) {
  $r = [A11yActivation]::SetScreenReader($false)
  Write-Host ("Restored SPI_SETSCREENREADER to off ({0})" -f $r) -ForegroundColor DarkGray
}

@{
  envVarSet        = [bool]([Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "User"))
  rendererHwnds    = $targets.Count
  captionsVisible  = $captionsVisible   # what the human saw on screen
  spokenChunks     = @($spoken)         # caption lines that reached the flat patternText
  results          = $results
} | ConvertTo-Json -Depth 5 | Set-Content -Path $OutPath -Encoding UTF8

Write-Host ""
Write-Host ("Wrote {0}" -f $OutPath) -ForegroundColor Green
$winner = $results | Where-Object { $_.trigger -ne "none" -and $_.captionNodes -gt 0 } | Select-Object -First 1
if ($winner) {
  Write-Host ("=> WINNER: '{0}' exposes captions with NO env var and NO Teams restart." -f $winner.trigger) -ForegroundColor Green
}
elseif (($results | Where-Object { $_.trigger -eq "none" }).captionNodes -gt 0) {
  Write-Host "=> Captions were ALREADY structural before any trigger (env var still set / Teams not restarted)." -ForegroundColor Yellow
}
elseif ($spoken.Count -gt 0) {
  # Captions were provably on screen AND in the flat blob, yet no trigger produced nodes.
  Write-Host ("=> VALID NEGATIVE: {0} caption chunk(s) reached patternText (see spokenChunks)," -f $spoken.Count) -ForegroundColor Yellow
  Write-Host "   yet no trigger exposed discrete nodes. Captions live only in the flat patternText." -ForegroundColor Yellow
  Write-Host "   The env var (or option C: our own WebView2) is required." -ForegroundColor Yellow
}
else {
  # Visible on screen, absent from BOTH the structural tree and the flat blob.
  Write-Host "=> DIFFERENT FINDING: captions are visible in Teams but reach NEITHER the structural" -ForegroundColor Magenta
  Write-Host "   tree NOR patternText. The shipped flat parser is blind here too - this is not an" -ForegroundColor Magenta
  Write-Host "   AXMode question. Send me the JSON; the caption pane may live in another process." -ForegroundColor Magenta
}
