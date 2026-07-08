param(
  [int]$DurationSeconds = 0,
  [int]$PollIntervalMs = 750,
  [double]$StableSeconds = 2.0,
  [string]$OutputPath = (Join-Path (Get-Location) "teams-captions-live.txt"),
  [string]$JsonOutputPath = (Join-Path (Get-Location) "teams-captions-live.jsonl"),
  [string]$WindowTitlePattern = "(\| Microsoft Teams$|^Microsoft Teams$|Teams$)",
  [string[]]$KnownSpeaker = @(),
  [switch]$ListTargets,
  [switch]$DebugTargets
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32TeamsCaptionWatcher {
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

function Get-TeamsProcessIds {
  $ids = New-Object System.Collections.Generic.HashSet[int]

  try {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    foreach ($proc in $processes) {
      $commandLine = [string]$proc.CommandLine
      if (
        $proc.Name -match "^(ms-teams|msteams|teams)\.exe$" -or
        $commandLine -match "(?i)(\\Microsoft\\Teams\\current\\Teams\.exe|\\MSTeams_|ms-teams\.exe)"
      ) {
        [void]$ids.Add([int]$proc.ProcessId)
      }
    }
  } catch {
    Get-Process | Where-Object {
      $_.ProcessName -match "^(ms-teams|msteams|teams)$" -or
      $_.MainWindowTitle -match $WindowTitlePattern
    } | ForEach-Object {
      [void]$ids.Add([int]$_.Id)
    }
  }

  return @($ids)
}

function Get-WindowTextByHandle {
  param([IntPtr]$Handle)

  $length = [Win32TeamsCaptionWatcher]::GetWindowTextLength($Handle)
  if ($length -le 0) {
    return ""
  }

  $builder = [System.Text.StringBuilder]::new($length + 1)
  [void][Win32TeamsCaptionWatcher]::GetWindowText($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-WindowClassByHandle {
  param([IntPtr]$Handle)

  $builder = [System.Text.StringBuilder]::new(256)
  [void][Win32TeamsCaptionWatcher]::GetClassName($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-VisibleTeamsWindowHandles {
  param([int[]]$TeamsProcessIds)

  $handles = New-Object System.Collections.Generic.List[IntPtr]
  $callback = [Win32TeamsCaptionWatcher+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    [uint32]$windowProcessId = 0
    [void][Win32TeamsCaptionWatcher]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $title = Get-WindowTextByHandle $hWnd
    $className = Get-WindowClassByHandle $hWnd
    $visible = [Win32TeamsCaptionWatcher]::IsWindowVisible($hWnd)

    if (Test-TeamsChatSurfaceTitle $title) {
      return $true
    }

    if (-not $visible -and -not (Test-WebViewCallWindowTitle $title)) {
      return $true
    }

    if (
      $TeamsProcessIds -contains [int]$windowProcessId -or
      (Test-MeetingWindowName $title) -or
      $title -match $WindowTitlePattern -or
      ($className -match "Teams|MSTeams" -and $title)
    ) {
      $handles.Add($hWnd)
    }

    return $true
  }

  [void][Win32TeamsCaptionWatcher]::EnumWindows($callback, [IntPtr]::Zero)
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

  $targets = New-Object System.Collections.Generic.List[object]
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

    if (Test-TeamsChatSurfaceTitle $name) {
      continue
    }

    $priority = Get-TeamsWindowPriority $name
    if ($priority -ge 0) {
      # keep priority from window title
    } elseif (
      $TeamsProcessIds -contains $processId -or
      $name -match $WindowTitlePattern -or
      ($className -match "Teams|MSTeams" -and $name) -or
      $automationId -match "Teams"
    ) {
      $priority = 1
    }

    if ($priority -ge 0) {
      $targets.Add([pscustomobject]@{
        Element = $window
        Priority = $priority
      })
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
      $title = Get-WindowTextByHandle $handle
      $priority = Get-TeamsWindowPriority $title
      if ($priority -lt 0) {
        $priority = 1
      }
      $targets.Add([pscustomobject]@{
        Element = $element
        Priority = $priority
      })
      $seenHandles[$handleKey] = $true
    }
  }

  if ($targets.Count -eq 0) {
    return @()
  }

  return @($targets | Sort-Object Priority | ForEach-Object { $_.Element })
}

function Test-MeetingWindowName {
  param([string]$Name)

  return (Get-TeamsWindowPriority $Name) -ge 0
}

function Get-TeamsWindowPriority {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return -1
  }

  if (Test-TeamsChatSurfaceTitle $Name) {
    return -1
  }

  if (Test-WebViewCallWindowTitle $Name) {
    return 0
  }

  if (Test-TeamsAppSurfaceTitle $Name) {
    return -1
  }

  if ($Name -match "^(?i)(?!Chat \|).+\|\s*Microsoft Teams$") {
    return 0
  }

  if ($Name -match "(?i)(Microsoft Teams Meeting|Reuni[oó]n|Llamada|Call)") {
    return 1
  }

  if ($Name -match "^(?i)Chat \| .+\|\s*Microsoft Teams$" -or
      $Name -match "(?i)Meeting with") {
    return 2
  }

  if (Test-CaptionsWindowTitle $Name) {
    return 1
  }

  return -1
}

function Normalize-TeamsTitle {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return ""
  }

  $value = $Name.Trim()
  $value = $value -replace "^(?i)WebView2:\s*", ""
  $value = $value -replace "^(?i)Chat\s*\|\s*", ""
  $value = $value -replace "^(?i)(Captions|Subt[ií]tulos)\s*\|\s*", ""
  $value = $value -replace "(?i)\s*\|\s*Microsoft Teams$", ""
  return $value.Trim()
}

function Test-TeamsAppSurfaceTitle {
  param([string]$Name)

  $value = Normalize-TeamsTitle $Name
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $false
  }

  return $value -match "^(?i)(Activity|Calendar|Chat|Chats|Teams|Calls|Files|OneDrive|Apps|Copilot|People|Meet|Search|Settings|Help|Assignments|Viva Engage|Runtime Broker|Microsoft Teams)$"
}

function Test-TeamsChatSurfaceTitle {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  $value = $Name.Trim() -replace "^(?i)WebView2:\s*", ""
  return $value -match "^(?i)Chat\s*\|"
}

function Test-CaptionsWindowTitle {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  $value = $Name.Trim() -replace "^(?i)WebView2:\s*", ""
  return $value -match "^(?i)(Captions|Subt[ií]tulos)\s*\|"
}

function Test-WebViewCallWindowTitle {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  if (Test-TeamsChatSurfaceTitle $Name) {
    return $false
  }

  if ($Name -notmatch "^(?i)WebView2:\s*.+\|\s*Microsoft Teams$") {
    return $false
  }

  $value = Normalize-TeamsTitle $Name
  return $value -ne "Microsoft Teams" -and
    $value -notmatch "^(?i)(Subframe|Utility|Manager|GPU Process|Crashpad)\b"
}

function Test-MeetingSurfaceText {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $false
  }

  $value = Normalize-Text $Text
  $score = 0

  if ($value -match "(?i)\b(Leave|Salir|Abandonar|Colgar)\b") {
    $score += 3
  }
  if ($value -match "(?i)\b(Share content|Compartir contenido|Presentar)\b") {
    $score += 2
  }
  if ($value -match "(?i)\b(Raise your hand|Levantar la mano)\b") {
    $score += 2
  }
  if ($value -match "(?i)\b(Open audio options|Opciones de audio|Mute mic|Silenciar|Unmute|Reactivar audio)\b") {
    $score += 2
  }
  if ($value -match "(?i)\b(Open video options|Opciones de video|Turn camera on|Activar c[aá]mara|Camera|C[aá]mara)\b") {
    $score += 2
  }
  if ($value -match "(?i)\b(People|Personas|Participants|Participantes|React|Reaccionar|Rooms|Salas|Notes|Notas)\b") {
    $score += 1
  }

  return $score -ge 5
}

function Test-MeetingEndedText {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $false
  }

  $value = Normalize-Text $Text
  return $value -match "(?i)\b(Meeting ended|Call ended|Meeting has ended|The meeting has ended|You left the meeting|You've left the meeting|You have left the meeting|La reuni[oó]n termin[oó]|La llamada termin[oó]|Reuni[oó]n finalizada|Llamada finalizada|Saliste de la reuni[oó]n|Has salido de la reuni[oó]n|Te fuiste de la reuni[oó]n)\b"
}

function Get-TextFromElement {
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
    $text = Invoke-Safe { $textPattern.DocumentRange.GetText(20000) }
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      $text = $text -replace [string][char]0xffff, ""
      $texts.Add($text.Trim())
    }
  }

  return ($texts | Select-Object -Unique) -join " | "
}

function Normalize-Text {
  param([string]$Text)

  if ($null -eq $Text) {
    return ""
  }

  $Text = $Text -replace [string][char]0xfffc, "`n"
  $Text = $Text -replace "\r", "`n"
  $Text = $Text -replace "\|", "`n"
  $Text = $Text -replace "[\t ]+", " "
  return $Text
}

function Get-CaptionCandidates {
  param([string]$PatternText)

  $lines = @(Normalize-Text $PatternText |
    ForEach-Object { $_ -split "`n" } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ })

  if ($lines.Count -eq 0) {
    return @()
  }

  $start = -1
  $fallbackStart = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^(Invite people to join you|Live Captions)$") {
      $start = $i
    }
    if ($fallbackStart -lt 0 -and (Test-SpeakerLine $lines[$i])) {
      $fallbackStart = $i
    }
  }

  if ($start -lt 0) {
    if ($fallbackStart -lt 0) {
      return @()
    }
    $start = $fallbackStart - 1
  }

  $end = $lines.Count
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if (($lines[$i] -match "Closed captions overflow menu|Hide live captions|More options|Calling controls") -or
      (Test-TeamsChromeLine $lines[$i])) {
      $end = $i
      break
    }
  }

  if ($end -le ($start + 1)) {
    return @()
  }

  $skip = "^(Settings and more|Calling indicators|Encryption status|Elapsed time|Meeting controls|Chat|People|Raise your hand|React|View|More|Turn camera|Open video|Open audio|Mute mic|Share content|Leave|Shared content view|Invite people to join you|Live Captions)$"
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = $start + 1; $i -lt $end; $i++) {
    $line = $lines[$i]
    if (Test-TeamsChromeLine $line) {
      continue
    }
    if ($line -match $skip) {
      continue
    }
    if ($line -match "^\d{1,2}:\d{2}$") {
      continue
    }
    $out.Add($line)
  }

  return @($out.ToArray())
}

function Test-SpeakerLine {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $false
  }

  if (Test-TeamsChromeLine $Line) {
    return $false
  }

  foreach ($speaker in $KnownSpeaker) {
    if ($Line -eq $speaker) {
      return $true
    }
  }

  if ($Line -notmatch "^(?<name>[^,;:!?()]{2,90})\s+\((?<org>[^)]+)\)$") {
    return $false
  }

  $name = $Matches.name.Trim()
  $org = $Matches.org.Trim()
  if ($org -match "(?i)Ctrl|Alt|Shift|\+|You|more tabs|participant|participants") {
    return $false
  }
  if ($name -match "^(?i)(Meeting with|Chat|Chats|New message|Teams|General|All Company|Shared|Join|See more|Type a message)") {
    return $false
  }

  return $name -match "\s"
}

function Test-TeamsChromeLine {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $false
  }

  return ($Line -match "^(?i)(New message|Chats? \(|More filters|Copilot|Quick views|Mentions|Discover|Drafts|Favorites|Teams and channels|Chat participants|Shared$|[0-9]+ more tabs\.|Add a tab|Join$|View and add participants|Find in chat|Open chat details|More chat options|Type a message|See more|See all your teams|Communities|Join communities|Resize left panel|Meeting ended|Meeting started)") -or
    ($Line -match "^(?i).+:\s*(joined the conversation\.|named the meeting|Chat has been turned on|Meeting ended:|[0-9]{1,2}:[0-9]{2}\s*(AM|PM).*(Meeting ended|Meeting started))")
}

function Test-CaptionUiLine {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $true
  }

  return $Line -match "^(Captions will be shown|Live Caption,|Closed captions|Hide live captions|Caption Settings|Open captions|Live captions language|Speaker attribution|Turn off live captions|Show captions|Subtitles|More options)"
}

function Test-CaptionLikeText {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $false
  }

  $candidates = @(Get-CaptionCandidates $Text)
  foreach ($caption in Convert-CandidatesToCaptions -Candidates $candidates) {
    if ($caption -and -not [string]::IsNullOrWhiteSpace($caption.speaker) -and -not [string]::IsNullOrWhiteSpace($caption.text)) {
      return $true
    }
  }

  return $false
}

function ConvertTo-Caption {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $null
  }

  foreach ($speaker in $KnownSpeaker) {
    if ($Line.StartsWith($speaker + " ")) {
      return [ordered]@{
        speaker = $speaker
        text = $Line.Substring($speaker.Length).Trim()
      }
    }
  }

  if ($Line -match "^(?<speaker>.+?\([^)]+\))\s+(?<text>.+)$") {
    return [ordered]@{
      speaker = $Matches.speaker.Trim()
      text = $Matches.text.Trim()
    }
  }

  return [ordered]@{
    speaker = ""
    text = $Line.Trim()
  }
}

function Convert-CandidatesToCaptions {
  param([string[]]$Candidates)

  $items = New-Object System.Collections.Generic.List[object]
  $currentSpeaker = ""

  foreach ($candidate in $Candidates) {
    if (Test-CaptionUiLine $candidate) {
      continue
    }

    if (Test-SpeakerLine $candidate) {
      $currentSpeaker = $candidate.Trim()
      continue
    }

    $caption = ConvertTo-Caption $candidate
    if (-not $caption -or [string]::IsNullOrWhiteSpace($caption.text)) {
      continue
    }

    if ([string]::IsNullOrWhiteSpace($caption.speaker) -and -not [string]::IsNullOrWhiteSpace($currentSpeaker)) {
      $caption.speaker = $currentSpeaker
    }

    $items.Add($caption)
  }

  return @($items.ToArray())
}

function Get-RootWebAreas {
  param([System.Windows.Automation.AutomationElement]$Window)

  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      "RootWebArea"
    )),
    [System.Windows.Automation.Condition]::TrueCondition
  )

  return @(
    Invoke-Safe {
      $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    } @()
  )
}

function Get-CaptionSnapshot {
  param(
    [double]$ElapsedSeconds,
    [string]$WindowName,
    [System.Windows.Automation.AutomationElement]$RootWebArea
  )

  $name = Invoke-Safe { $RootWebArea.Current.Name } ""
  if (Test-TeamsChatSurfaceTitle $name) {
    return @()
  }

  $isOffscreen = Invoke-Safe { $RootWebArea.Current.IsOffscreen } $null
  $patternText = Get-TextFromElement $RootWebArea
  $isCaptionsWindow = (Test-CaptionsWindowTitle $WindowName) -or (Test-CaptionsWindowTitle $name)

  if (-not (Test-MeetingSurfaceText $patternText) -and -not $isCaptionsWindow) {
    return @()
  }

  if (-not (Test-CaptionLikeText $patternText)) {
    return @()
  }

  $items = New-Object System.Collections.Generic.List[object]
  $candidates = @(Get-CaptionCandidates $patternText)
  foreach ($caption in Convert-CandidatesToCaptions -Candidates $candidates) {
    if (-not $caption -or [string]::IsNullOrWhiteSpace($caption.text)) {
      continue
    }

    $items.Add([ordered]@{
      elapsedSeconds = [math]::Round($ElapsedSeconds, 3)
      speaker = $caption.speaker
      text = $caption.text
      isOffscreen = $isOffscreen
      windowName = $name
    })
  }

  return @($items.ToArray())
}

function Convert-Rect {
  param($Rect)

  if ($null -eq $Rect -or $Rect.IsEmpty) {
    return ""
  }

  return ("x={0:n0} y={1:n0} w={2:n0} h={3:n0}" -f $Rect.X, $Rect.Y, $Rect.Width, $Rect.Height)
}

function Show-CaptionTargets {
  $teamsProcessIds = Get-TeamsProcessIds
  if ($DebugTargets) {
    Write-Host "Native Teams windows that look relevant:"
    foreach ($handle in Get-VisibleTeamsWindowHandles -TeamsProcessIds $teamsProcessIds) {
      [uint32]$windowProcessId = 0
      [void][Win32TeamsCaptionWatcher]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
      $title = Get-WindowTextByHandle $handle
      $className = Get-WindowClassByHandle $handle
      $priority = Get-TeamsWindowPriority $title
      $visible = [Win32TeamsCaptionWatcher]::IsWindowVisible($handle)
      Write-Host ("HANDLE pid={0} visible={1} priority={2} class='{3}' title='{4}'" -f $windowProcessId, $visible, $priority, $className, $title)
    }
  }

  $windows = @(Get-TopLevelTeamsWindows -TeamsProcessIds $teamsProcessIds)
  Write-Host "Confirmed Teams meeting windows/root web areas:"
  foreach ($window in $windows) {
    $windowName = Invoke-Safe { $window.Current.Name } ""
    $windowPid = Invoke-Safe { $window.Current.ProcessId } 0
    $windowClass = Invoke-Safe { $window.Current.ClassName } ""
    $windowPriority = Get-TeamsWindowPriority $windowName
    $windowRect = Convert-Rect (Invoke-Safe { $window.Current.BoundingRectangle } $null)
    $printedWindow = $false

    foreach ($rootWebArea in Get-RootWebAreas -Window $window) {
      $name = Invoke-Safe { $rootWebArea.Current.Name } ""
      $rootPid = Invoke-Safe { $rootWebArea.Current.ProcessId } 0
      $className = Invoke-Safe { $rootWebArea.Current.ClassName } ""
      $automationId = Invoke-Safe { $rootWebArea.Current.AutomationId } ""
      $isOffscreen = Invoke-Safe { $rootWebArea.Current.IsOffscreen } $null
      $rect = Convert-Rect (Invoke-Safe { $rootWebArea.Current.BoundingRectangle } $null)
      $text = Get-TextFromElement $rootWebArea
      $preview = (Normalize-Text $text -replace "\s+", " ").Trim()
      if ($preview.Length -gt 220) {
        $preview = $preview.Substring(0, 220) + "..."
      }
      $isMeetingSurface = Test-MeetingSurfaceText $text
      $isCaptionsWindow = (Test-CaptionsWindowTitle $windowName) -or (Test-CaptionsWindowTitle $name)
      $hasCaption = Test-CaptionLikeText $text
      $meetingEnded = Test-MeetingEndedText $text
      if (-not $isMeetingSurface -and -not ($isCaptionsWindow -and $hasCaption) -and -not $meetingEnded -and -not $DebugTargets) {
        continue
      }
      if (-not $printedWindow) {
        Write-Host ("WINDOW pid={0} priority={1} class='{2}' name='{3}' {4}" -f $windowPid, $windowPriority, $windowClass, $windowName, $windowRect)
        $printedWindow = $true
      }
      Write-Host ("  ROOT pid={0} offscreen={1} meetingChrome={2} captionLike={3} captionsWindow={4} meetingEnded={5} aid='{6}' class='{7}' name='{8}' {9}" -f $rootPid, $isOffscreen, $isMeetingSurface, $hasCaption, $isCaptionsWindow, $meetingEnded, $automationId, $className, $name, $rect)
      if ($preview) {
        Write-Host ("    text: {0}" -f $preview)
      }
    }
  }
}

function Get-NewSnapshotItems {
  param(
    [object[]]$Previous,
    [object[]]$Current
  )

  if (-not $Previous -or $Previous.Count -eq 0) {
    return @($Current)
  }

  $newItems = New-Object System.Collections.Generic.List[object]
  $previousKeys = @{}
  foreach ($previousItem in $Previous) {
    $previousKey = "$($previousItem.speaker)|$($previousItem.text)"
    $previousKeys[$previousKey] = $true
  }

  foreach ($item in $Current) {
    $key = "$($item.speaker)|$($item.text)"
    if (-not $previousKeys.ContainsKey($key)) {
      $newItems.Add($item)
    }
  }

  return @($newItems.ToArray())
}

function Get-ComparableCaptionText {
  param([string]$Text)

  if ($null -eq $Text) {
    return ""
  }

  $value = $Text.Trim() -replace "\s+", " "
  return $value.TrimEnd(".", ",", ";", ":", "?", "!", " ")
}

function Test-CaptionRevision {
  param(
    [string]$PreviousText,
    [string]$CurrentText
  )

  $previous = Get-ComparableCaptionText $PreviousText
  $current = Get-ComparableCaptionText $CurrentText

  if ($previous.Length -eq 0 -or $current.Length -lt $previous.Length) {
    return $false
  }

  return $current.StartsWith($previous, [System.StringComparison]::OrdinalIgnoreCase)
}

function Add-CaptionLines {
  param([object[]]$Captions)

  foreach ($caption in $Captions) {
    $stamp = [TimeSpan]::FromSeconds([double]$caption.elapsedSeconds).ToString("hh\:mm\:ss")
    if ($caption.speaker) {
      $line = "[$stamp] $($caption.speaker): $($caption.text)"
    } else {
      $line = "[$stamp] $($caption.text)"
    }

    Add-Content -LiteralPath $script:ResolvedOutputPath -Value $line -Encoding UTF8
    Add-Content -LiteralPath $script:ResolvedJsonOutputPath -Value ($caption | ConvertTo-Json -Compress) -Encoding UTF8
    Write-Host $line
  }
}

function Publish-PendingCaption {
  if (-not $script:PendingCaption) {
    return
  }

  Add-CaptionLines -Captions @($script:PendingCaption)
  $script:PendingCaption = $null
  $script:PendingChangedAt = $null
}

function Set-PendingCaption {
  param(
    [object]$Caption,
    [DateTime]$ObservedAt
  )

  $script:PendingCaption = [ordered]@{
    elapsedSeconds = $Caption.elapsedSeconds
    speaker = $Caption.speaker
    text = $Caption.text
    isOffscreen = $Caption.isOffscreen
    windowName = $Caption.windowName
  }
  $script:PendingChangedAt = $ObservedAt
}

function Submit-CaptionObservation {
  param(
    [object]$Caption,
    [DateTime]$ObservedAt
  )

  if (-not $Caption -or [string]::IsNullOrWhiteSpace($Caption.text)) {
    return
  }

  if (-not $script:PendingCaption) {
    Set-PendingCaption -Caption $Caption -ObservedAt $ObservedAt
    return
  }

  $sameSpeaker = ([string]$script:PendingCaption.speaker) -eq ([string]$Caption.speaker)
  if ($sameSpeaker -and (Test-CaptionRevision -PreviousText $script:PendingCaption.text -CurrentText $Caption.text)) {
    if ((Get-ComparableCaptionText $Caption.text).Length -gt (Get-ComparableCaptionText $script:PendingCaption.text).Length) {
      $script:PendingCaption.text = $Caption.text
      $script:PendingCaption.isOffscreen = $Caption.isOffscreen
      $script:PendingCaption.windowName = $Caption.windowName
      $script:PendingChangedAt = $ObservedAt
    }
    return
  }

  if ($sameSpeaker -and (Test-CaptionRevision -PreviousText $Caption.text -CurrentText $script:PendingCaption.text)) {
    return
  }

  Publish-PendingCaption
  Set-PendingCaption -Caption $Caption -ObservedAt $ObservedAt
}

function Publish-StablePendingCaption {
  param([DateTime]$Now)

  if (-not $script:PendingCaption -or -not $script:PendingChangedAt) {
    return
  }

  if (($Now - $script:PendingChangedAt).TotalSeconds -ge $StableSeconds) {
    Publish-PendingCaption
  }
}

$script:ResolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$script:ResolvedJsonOutputPath = [System.IO.Path]::GetFullPath($JsonOutputPath)

if ($ListTargets) {
  Write-Host "Teams live captions UI Automation watcher"
  Show-CaptionTargets
  exit 0
}

foreach ($path in @($script:ResolvedOutputPath, $script:ResolvedJsonOutputPath)) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path
  }
}

$started = Get-Date
$deadline = $null
if ($DurationSeconds -gt 0) {
  $deadline = $started.AddSeconds($DurationSeconds)
}

$previousSnapshot = @()
$script:InitialSnapshotSeeded = $false
$script:PendingCaption = $null
$script:PendingChangedAt = $null
$lastStatusAt = [DateTime]::MinValue

Write-Host "Teams live captions UI Automation watcher"
Write-Host "Transcript: $script:ResolvedOutputPath"
Write-Host "JSONL: $script:ResolvedJsonOutputPath"
Write-Host "Stable delay: $StableSeconds seconds"
Write-Host "Tip: enable live captions in Teams. Press Ctrl+C to stop when DurationSeconds is 0."

while ($true) {
  if ($deadline -and (Get-Date) -ge $deadline) {
    break
  }

  $elapsed = ((Get-Date) - $started).TotalSeconds
  $teamsProcessIds = Get-TeamsProcessIds
  $windows = @(Get-TopLevelTeamsWindows -TeamsProcessIds $teamsProcessIds)
  $currentSnapshot = New-Object System.Collections.Generic.List[object]

  foreach ($window in $windows) {
    $windowName = Invoke-Safe { $window.Current.Name } ""
    foreach ($rootWebArea in Get-RootWebAreas -Window $window) {
      foreach ($caption in Get-CaptionSnapshot -ElapsedSeconds $elapsed -WindowName $windowName -RootWebArea $rootWebArea) {
        $currentSnapshot.Add($caption)
      }
    }
  }

  if ($currentSnapshot.Count -gt 0) {
    $now = Get-Date
    $currentItems = @($currentSnapshot.ToArray())
    if (-not $script:InitialSnapshotSeeded) {
      $previousSnapshot = $currentItems
      $script:InitialSnapshotSeeded = $true
    } else {
      $newItems = @(Get-NewSnapshotItems -Previous $previousSnapshot -Current $currentItems)
      if ($newItems.Count -gt 0) {
        foreach ($item in $newItems) {
          Submit-CaptionObservation -Caption $item -ObservedAt $now
        }
      }
      $previousSnapshot = $currentItems
    }
  } elseif (((Get-Date) - $lastStatusAt).TotalSeconds -ge 10) {
    Write-Host ("[{0}] Waiting for Teams live captions..." -f ([TimeSpan]::FromSeconds($elapsed).ToString("hh\:mm\:ss")))
    $lastStatusAt = Get-Date
  }

  Publish-StablePendingCaption -Now (Get-Date)
  Start-Sleep -Milliseconds $PollIntervalMs
}

Publish-PendingCaption
Write-Host "Done."
