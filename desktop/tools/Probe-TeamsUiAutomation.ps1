param(
  [int]$DurationSeconds = 20,
  [int]$PollIntervalMs = 500,
  [int]$MaxDepth = 18,
  [int]$MaxElements = 12000,
  [string]$OutputPath = (Join-Path (Get-Location) "teams-uia-dump.jsonl"),
  [string]$WindowTitlePattern = "Teams|Microsoft Teams",
  [ValidateSet("Raw", "Control", "Content")]
  [string]$TreeView = "Raw",
  [switch]$IncludeEmpty
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32WindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

function Invoke-Safe {
  param(
    [scriptblock]$Block,
    $Default = $null
  )

  try {
    & $Block
  } catch {
    $Default
  }
}

function Convert-Rect {
  param($Rect)

  if ($null -eq $Rect -or $Rect.IsEmpty) {
    return $null
  }

  [ordered]@{
    x = [math]::Round($Rect.X, 1)
    y = [math]::Round($Rect.Y, 1)
    width = [math]::Round($Rect.Width, 1)
    height = [math]::Round($Rect.Height, 1)
  }
}

function Get-PatternText {
  param([System.Windows.Automation.AutomationElement]$Element)

  $texts = New-Object System.Collections.Generic.List[string]

  $valuePattern = Invoke-Safe {
    $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  }
  if ($valuePattern) {
    $value = Invoke-Safe { $valuePattern.Current.Value }
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $texts.Add($value.Trim())
    }
  }

  $textPattern = Invoke-Safe {
    $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  }
  if ($textPattern) {
    $text = Invoke-Safe { $textPattern.DocumentRange.GetText(5000) }
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      $text = $text -replace [string][char]0xffff, ""
      $text = $text -replace "\s+", " "
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        $texts.Add($text.Trim())
      }
    }
  }

  return ($texts | Select-Object -Unique) -join " | "
}

function Get-TeamsProcessIds {
  $ids = New-Object System.Collections.Generic.HashSet[int]

  try {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    $childrenByParent = @{}
    foreach ($proc in $processes) {
      $parent = 0
      if ($null -ne $proc.ParentProcessId) {
        $parent = [int]$proc.ParentProcessId
      }
      if (-not $childrenByParent.ContainsKey($parent)) {
        $childrenByParent[$parent] = New-Object System.Collections.Generic.List[object]
      }
      $childrenByParent[$parent].Add($proc)
    }

    $queue = New-Object System.Collections.Queue
    foreach ($proc in $processes) {
      $commandLine = [string]$proc.CommandLine
      if (
        $proc.Name -match "^(ms-teams|msteams|teams)\.exe$" -or
        $commandLine -match "(?i)(\\Microsoft\\Teams\\current\\Teams\.exe|\\MSTeams_|ms-teams\.exe)"
      ) {
        if ($ids.Add([int]$proc.ProcessId)) {
          $queue.Enqueue([int]$proc.ProcessId)
        }
      }
    }

    while ($queue.Count -gt 0) {
      $parentId = [int]$queue.Dequeue()
      if (-not $childrenByParent.ContainsKey($parentId)) {
        continue
      }
      foreach ($child in $childrenByParent[$parentId]) {
        if ($ids.Add([int]$child.ProcessId)) {
          $queue.Enqueue([int]$child.ProcessId)
        }
      }
    }
  } catch {
    Get-Process | Where-Object {
      $_.ProcessName -match "^(ms-teams|msteams|teams|msedgewebview2)$" -or
      $_.MainWindowTitle -match "Teams"
    } | ForEach-Object {
      [void]$ids.Add([int]$_.Id)
    }
  }

  return @($ids)
}

function Get-WindowTextByHandle {
  param([IntPtr]$Handle)

  $length = [Win32WindowProbe]::GetWindowTextLength($Handle)
  if ($length -le 0) {
    return ""
  }

  $builder = [System.Text.StringBuilder]::new($length + 1)
  [void][Win32WindowProbe]::GetWindowText($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-WindowClassByHandle {
  param([IntPtr]$Handle)

  $builder = [System.Text.StringBuilder]::new(256)
  [void][Win32WindowProbe]::GetClassName($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-VisibleTeamsWindowHandles {
  param([int[]]$TeamsProcessIds)

  $handles = New-Object System.Collections.Generic.List[IntPtr]
  $callback = [Win32WindowProbe+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [Win32WindowProbe]::IsWindowVisible($hWnd)) {
      return $true
    }

    [uint32]$windowProcessId = 0
    [void][Win32WindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $title = Get-WindowTextByHandle $hWnd
    $className = Get-WindowClassByHandle $hWnd

    if (
      $TeamsProcessIds -contains [int]$windowProcessId -or
      $title -match $WindowTitlePattern -or
      ($className -match "Teams|MSTeams" -and $title)
    ) {
      $handles.Add($hWnd)
    }

    return $true
  }

  [void][Win32WindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
  return @($handles)
}

function Get-TopLevelTeamsWindows {
  param([int[]]$TeamsProcessIds)

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = Invoke-Safe {
    $root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  }

  $targets = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  $seenHandles = @{}
  foreach ($window in @($windows)) {
    if (-not $window) {
      continue
    }

    $processId = Invoke-Safe { $window.Current.ProcessId } 0
    $name = Invoke-Safe { $window.Current.Name } ""
    $className = Invoke-Safe { $window.Current.ClassName } ""
    $automationId = Invoke-Safe { $window.Current.AutomationId } ""
    $handle = Invoke-Safe { $window.Current.NativeWindowHandle } 0

    if (
      $TeamsProcessIds -contains $processId -or
      $name -match $WindowTitlePattern -or
      ($className -match "Teams|MSTeams" -and $name) -or
      $automationId -match "Teams"
    ) {
      $targets.Add($window)
      if ($handle) {
        $seenHandles[[string]$handle] = $true
      }
    }
  }

  foreach ($handle in Get-VisibleTeamsWindowHandles -TeamsProcessIds $TeamsProcessIds) {
    $handleKey = [string]$handle.ToInt64()
    if ($seenHandles.ContainsKey($handleKey)) {
      continue
    }

    $element = Invoke-Safe {
      [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    }
    if ($element) {
      $targets.Add($element)
      $seenHandles[$handleKey] = $true
    }
  }

  return $targets
}

function Get-TreeWalker {
  switch ($TreeView) {
    "Content" { return [System.Windows.Automation.TreeWalker]::ContentViewWalker }
    "Control" { return [System.Windows.Automation.TreeWalker]::ControlViewWalker }
    default { return [System.Windows.Automation.TreeWalker]::RawViewWalker }
  }
}

function New-ElementRecord {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [int]$Depth,
    [double]$ElapsedSeconds
  )

  $name = Invoke-Safe { $Element.Current.Name } ""
  $automationId = Invoke-Safe { $Element.Current.AutomationId } ""
  $className = Invoke-Safe { $Element.Current.ClassName } ""
  $controlType = Invoke-Safe { $Element.Current.ControlType.ProgrammaticName } ""
  $helpText = Invoke-Safe { $Element.Current.HelpText } ""
  $localizedType = Invoke-Safe { $Element.Current.LocalizedControlType } ""
  $isOffscreen = Invoke-Safe { $Element.Current.IsOffscreen } $null
  $processId = Invoke-Safe { $Element.Current.ProcessId } 0
  $nativeWindowHandle = Invoke-Safe { $Element.Current.NativeWindowHandle } 0
  $rect = Invoke-Safe { $Element.Current.BoundingRectangle }
  $patternText = Get-PatternText $Element

  [ordered]@{
    elapsedSeconds = [math]::Round($ElapsedSeconds, 3)
    depth = $Depth
    processId = $processId
    nativeWindowHandle = $nativeWindowHandle
    controlType = $controlType
    localizedControlType = $localizedType
    name = $name
    patternText = $patternText
    automationId = $automationId
    className = $className
    helpText = $helpText
    isOffscreen = $isOffscreen
    bounds = Convert-Rect $rect
  }
}

function Walk-Element {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [int]$Depth,
    [double]$ElapsedSeconds,
    [System.Collections.Generic.List[string]]$Lines,
    [hashtable]$SeenText,
    [ref]$Count
  )

  if ($Count.Value -ge $MaxElements -or $Depth -gt $MaxDepth) {
    return
  }

  $Count.Value++
  $record = New-ElementRecord -Element $Element -Depth $Depth -ElapsedSeconds $ElapsedSeconds
  $hasText = -not [string]::IsNullOrWhiteSpace($record.name) -or
    -not [string]::IsNullOrWhiteSpace($record.patternText) -or
    -not [string]::IsNullOrWhiteSpace($record.automationId)

  if ($IncludeEmpty -or $hasText) {
    $Lines.Add(($record | ConvertTo-Json -Compress -Depth 8))
  }

  $candidateText = (($record.name, $record.patternText) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique) -join " | "

  if (-not [string]::IsNullOrWhiteSpace($candidateText)) {
    $candidateText = $candidateText -replace "\s+", " "
    if ($candidateText.Length -gt 2 -and -not $SeenText.ContainsKey($candidateText)) {
      $SeenText[$candidateText] = $true
      Write-Host ("[{0,6:n2}s] {1}" -f $ElapsedSeconds, $candidateText)
    }
  }

  $walker = Get-TreeWalker
  $child = Invoke-Safe { $walker.GetFirstChild($Element) }
  if (-not $child) {
    return
  }

  while ($child) {
    Walk-Element -Element $child -Depth ($Depth + 1) -ElapsedSeconds $ElapsedSeconds -Lines $Lines -SeenText $SeenText -Count $Count
    $child = Invoke-Safe { $walker.GetNextSibling($child) }
  }
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDir = Split-Path -Parent $resolvedOutputPath
if ($outputDir -and -not (Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

if (Test-Path $resolvedOutputPath) {
  Remove-Item -LiteralPath $resolvedOutputPath
}

$started = Get-Date
$deadline = $started.AddSeconds($DurationSeconds)
$seenText = @{}

Write-Host "UI Automation Teams probe"
Write-Host "Tree view: $TreeView"
Write-Host "Output: $resolvedOutputPath"
Write-Host "Tip: keep Teams desktop visible, join a meeting, and enable live captions."

while ((Get-Date) -lt $deadline) {
  $elapsed = ((Get-Date) - $started).TotalSeconds
  $teamsProcessIds = Get-TeamsProcessIds
  $windows = @(Get-TopLevelTeamsWindows -TeamsProcessIds $teamsProcessIds)

  if ($windows.Count -eq 0) {
    Write-Host ("[{0,6:n2}s] No Teams top-level window found. Bring Teams desktop to the foreground." -f $elapsed)
  } else {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($window in $windows) {
      $count = 0
      Walk-Element -Element $window -Depth 0 -ElapsedSeconds $elapsed -Lines $lines -SeenText $seenText -Count ([ref]$count)
    }

    if ($lines.Count -gt 0) {
      Add-Content -LiteralPath $resolvedOutputPath -Value $lines -Encoding UTF8
    }
  }

  Start-Sleep -Milliseconds $PollIntervalMs
}

Write-Host "Done."
Write-Host "Review the JSONL file and search for caption text or speaker names."
