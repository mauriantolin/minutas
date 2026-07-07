param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$OutputPath = (Join-Path (Get-Location) "teams-captions.txt"),
  [string]$JsonOutputPath = (Join-Path (Get-Location) "teams-captions.jsonl"),
  [string[]]$KnownSpeaker = @()
)

$ErrorActionPreference = "Stop"

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
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^(Invite people to join you|Live Captions)$") {
      $start = $i
    }
  }

  if ($start -lt 0) {
    return @()
  }

  $end = $lines.Count
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "Closed captions overflow menu|Hide live captions|More options|Calling controls") {
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

function Get-NewSnapshotItems {
  param(
    [object[]]$Previous,
    [object[]]$Current
  )

  if (-not $Previous -or $Previous.Count -eq 0) {
    return @($Current)
  }

  $newItems = New-Object System.Collections.Generic.List[object]
  $previousIndex = 0

  foreach ($item in $Current) {
    $key = "$($item.speaker)|$($item.text)"
    $matched = $false

    while ($previousIndex -lt $Previous.Count) {
      $previousItem = $Previous[$previousIndex]
      $previousKey = "$($previousItem.speaker)|$($previousItem.text)"
      $previousIndex++
      if ($previousKey -eq $key) {
        $matched = $true
        break
      }
    }

    if (-not $matched) {
      $newItems.Add($item)
    }
  }

  return @($newItems.ToArray())
}

$resolvedInputPath = [System.IO.Path]::GetFullPath($InputPath)
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$resolvedJsonOutputPath = [System.IO.Path]::GetFullPath($JsonOutputPath)

$captions = New-Object System.Collections.Generic.List[object]
$previousSnapshot = @()

Get-Content -LiteralPath $resolvedInputPath | ForEach-Object {
  if ([string]::IsNullOrWhiteSpace($_)) {
    return
  }

  $record = $_ | ConvertFrom-Json
  if ($record.automationId -ne "RootWebArea") {
    return
  }
  if ($record.name -notmatch "Teams|Microsoft Teams|Meeting|Reuni") {
    return
  }
  if ($record.patternText -notmatch "Closed captions|live captions|Live Captions") {
    return
  }

  $currentSnapshot = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in Get-CaptionCandidates $record.patternText) {
    $caption = ConvertTo-Caption $candidate
    if (-not $caption -or [string]::IsNullOrWhiteSpace($caption.text)) {
      continue
    }

    $currentSnapshot.Add([ordered]@{
      elapsedSeconds = $record.elapsedSeconds
      speaker = $caption.speaker
      text = $caption.text
    })
  }

  if ($currentSnapshot.Count -gt 0) {
    $currentItems = @($currentSnapshot.ToArray())
    foreach ($caption in Get-NewSnapshotItems -Previous $previousSnapshot -Current $currentItems) {
      $captions.Add($caption)
    }
    $previousSnapshot = $currentItems
  }
}

$textLines = $captions | ForEach-Object {
  $stamp = [TimeSpan]::FromSeconds([double]$_.elapsedSeconds).ToString("hh\:mm\:ss")
  if ($_.speaker) {
    "[$stamp] $($_.speaker): $($_.text)"
  } else {
    "[$stamp] $($_.text)"
  }
}

Set-Content -LiteralPath $resolvedOutputPath -Value $textLines -Encoding UTF8
$captions | ForEach-Object { $_ | ConvertTo-Json -Compress } |
  Set-Content -LiteralPath $resolvedJsonOutputPath -Encoding UTF8

Write-Host "Extracted $($captions.Count) caption lines."
Write-Host "Transcript: $resolvedOutputPath"
Write-Host "JSONL: $resolvedJsonOutputPath"
