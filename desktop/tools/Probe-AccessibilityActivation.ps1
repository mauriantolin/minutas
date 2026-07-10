<#
.SYNOPSIS
  Finds a way to make Chromium expose the FULL accessibility tree (discrete caption nodes) on ANY
  client machine — without the global WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var and WITHOUT
  restarting Teams.

.DESCRIPTION
  Screen readers (NVDA/JAWS) get Chromium's full tree with no flags: they announce themselves as
  assistive-technology clients and Chromium escalates its AXMode. This probe tests, empirically,
  which activation handshake (if any) does that — because the Chromium docs do not state it.

  It applies each candidate trigger against the Teams renderer HWNDs, then re-scans the meeting
  RootWebArea with the SAME structural reader the app uses (anchor on the captions Buttons'
  AutomationId) and reports how many discrete caption utterances became visible.

  TRIGGERS, least invasive first:
    none        control - plain UIA read (what the app does today)
    msaa        AccessibleObjectFromWindow(OBJID_CLIENT, IAccessible)   -> usually enables "basic"
    ia2         + QueryService(IID_IAccessible2)                        -> the NVDA/JAWS handshake
    simpledom   + QueryService(ISimpleDOMNode)                          -> historic "kHTML" signal
    uia-root    WM_GETOBJECT(lParam = UiaRootObjectId)                  -> native UIA provider

  COM references obtained are held alive for the process lifetime: Chromium auto-disables
  accessibility once no AT client is listening, so a real implementation must keep them too.

.PREREQUISITES  (this is what makes the result representative of a fresh client install)
  1. Clear the env var and RESTART Teams, otherwise you are measuring the forced path:
       [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',$null,'User')
     then fully quit Teams (tray icon -> Quit) and reopen it.
  2. Join a meeting, turn live captions ON, and let a few caption lines appear.
  3. Run this script. It prints a table; send me the JSON it writes.

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

if ($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -or
  [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "User")) {
  Write-Host "WARNING: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is still set." -ForegroundColor Red
  Write-Host "         Results will NOT represent a fresh client install. Clear it, restart Teams, rerun." -ForegroundColor Red
  Write-Host ""
}

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
  return $out
}

function Measure-Captions {
  $best = 0; $sample = $null; $win = ""
  foreach ($r in Get-MeetingRoots) {
    $caps = @(Get-StructuralCaptions $r.Area)
    if ($caps.Count -gt $best) { $best = $caps.Count; $sample = $caps[0]; $win = $r.Window }
  }
  return [pscustomobject]@{ count = $best; sample = $sample; window = $win }
}

# --- run the matrix ----------------------------------------------------------------------------
$roots = Get-MeetingRoots
if ($roots.Count -eq 0) { throw "No Teams meeting RootWebArea found. Join a meeting, enable captions, retry." }

$targets = @()
foreach ($r in $roots) {
  if ($r.Hwnd -ne [IntPtr]::Zero) { $targets += [A11yActivation]::RendererWindows($r.Hwnd) }
}
$targets = @($targets | Select-Object -Unique)
Write-Host ("Teams meeting roots: {0} | renderer HWNDs: {1}" -f $roots.Count, $targets.Count)
Write-Host ""

$results = @()
foreach ($trigger in @("none", "msaa", "ia2", "simpledom", "uia-root")) {
  $status = @()
  if ($trigger -ne "none") {
    foreach ($h in $targets) {
      $s = if ($trigger -eq "uia-root") { [A11yActivation]::UiaRoot($h) } else { [A11yActivation]::Handshake($h, $trigger) }
      $status += $s
    }
    Start-Sleep -Seconds $SettleSeconds
  }
  $m = Measure-Captions
  $results += [pscustomobject]@{
    trigger        = $trigger
    handshake      = ($status | Select-Object -Unique) -join ","
    captionNodes   = $m.count
    sampleSpeaker  = $m.sample.speaker
    sampleText     = $m.sample.text
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

@{
  envVarSet = [bool]([Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "User"))
  rendererHwnds = $targets.Count
  results = $results
} | ConvertTo-Json -Depth 5 | Set-Content -Path $OutPath -Encoding UTF8

Write-Host ""
Write-Host ("Wrote {0}" -f $OutPath) -ForegroundColor Green
$winner = $results | Where-Object { $_.trigger -ne "none" -and $_.captionNodes -gt 0 } | Select-Object -First 1
if ($winner) {
  Write-Host ("=> WINNER: '{0}' exposes captions with NO env var and NO Teams restart." -f $winner.trigger) -ForegroundColor Green
}
elseif (($results | Where-Object { $_.trigger -eq "none" }).captionNodes -gt 0) {
  Write-Host "=> Captions were ALREADY structural before any trigger (env var still set?)." -ForegroundColor Yellow
}
else {
  Write-Host "=> No handshake worked. The env var (or option C: our own WebView2) is required." -ForegroundColor Yellow
}
