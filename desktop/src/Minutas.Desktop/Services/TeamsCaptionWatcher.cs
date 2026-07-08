using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using Minutas.Desktop.Models;

namespace Minutas.Desktop.Services;

public sealed class TeamsCaptionWatcher
{
    private static readonly Regex SpeakerLine = new(@"^(?<name>[^,;:!?()]{2,90})\s+\((?<org>[^)]+)\)$", RegexOptions.Compiled);

    private readonly AppSettings _settings;
    private readonly Regex _windowTitleRegex;

    public TeamsCaptionWatcher(AppSettings settings)
    {
        _settings = settings;
        _windowTitleRegex = new Regex(settings.WindowTitlePattern, RegexOptions.IgnoreCase | RegexOptions.Compiled);
    }

    public event EventHandler<CaptionObservation>? CaptionFinal;
    public event EventHandler<string>? StatusChanged;

    internal IReadOnlyList<AutomationElement> GetActiveTeamsWindows()
    {
        return GetTopLevelTeamsWindows(GetTeamsProcessIds()).ToArray();
    }

    internal bool AreCaptionsVisible()
    {
        return GetActiveCaptionRoots(GetTeamsProcessIds()).Count > 0;
    }

    public string? GetCurrentMeetingTitle()
    {
        var teamsProcessIds = GetTeamsProcessIds();
        var nativeCallTitle = GetCurrentMeetingTitleFromNativeWindow(teamsProcessIds, exactCallOnly: true);
        if (!string.IsNullOrWhiteSpace(nativeCallTitle))
        {
            return nativeCallTitle;
        }

        foreach (var root in GetActiveCaptionRoots(teamsProcessIds))
        {
            foreach (var title in new[] { root.RootName, root.WindowName })
            {
                var cleanTitle = CleanMeetingTitle(title);
                if (!string.IsNullOrWhiteSpace(cleanTitle))
                {
                    return cleanTitle;
                }
            }
        }

        return GetCurrentMeetingTitleFromNativeWindow(teamsProcessIds, exactCallOnly: false);
    }

    public async Task WatchAsync(DateTimeOffset startedAt, CancellationToken cancellationToken)
    {
        CaptionObservation? pending = null;
        DateTimeOffset? pendingChangedAt = null;
        var previousSnapshot = Array.Empty<CaptionObservation>();
        var initialSnapshotSeeded = false;
        var lastStatusAt = DateTimeOffset.MinValue;

        while (!cancellationToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var elapsed = (now - startedAt).TotalSeconds;
            var snapshot = ReadSnapshot(elapsed).ToArray();

            if (snapshot.Length > 0)
            {
                if (!initialSnapshotSeeded)
                {
                    previousSnapshot = snapshot;
                    initialSnapshotSeeded = true;
                }
                else
                {
                    foreach (var item in GetNewSnapshotItems(previousSnapshot, snapshot))
                    {
                        SubmitObservation(item, now, ref pending, ref pendingChangedAt);
                    }

                    previousSnapshot = snapshot;
                }
            }
            else if (now - lastStatusAt >= TimeSpan.FromSeconds(10))
            {
                StatusChanged?.Invoke(this, "Esperando subtitulos de Teams...");
                lastStatusAt = now;
            }

            PublishIfStable(now, ref pending, ref pendingChangedAt);
            await Task.Delay(_settings.CaptionPollInterval, cancellationToken).ConfigureAwait(false);
        }

        PublishPending(ref pending, ref pendingChangedAt);
    }

    private IEnumerable<CaptionObservation> ReadSnapshot(double elapsedSeconds)
    {
        var teamsProcessIds = GetTeamsProcessIds();
        foreach (var root in GetActiveCaptionRoots(teamsProcessIds))
        {
            foreach (var caption in ConvertCandidatesToCaptions(GetCaptionCandidates(root.PatternText)))
            {
                yield return new CaptionObservation(
                    Math.Round(elapsedSeconds, 3),
                    caption.Speaker,
                    caption.Text,
                    root.IsOffscreen,
                    root.RootName);
            }
        }
    }

    private IReadOnlyList<CaptionRootSnapshot> GetActiveCaptionRoots(HashSet<int> teamsProcessIds)
    {
        var roots = new List<CaptionRootSnapshot>();

        foreach (var window in GetTopLevelTeamsWindows(teamsProcessIds))
        {
            var windowName = Safe(() => window.Current.Name, "");
            foreach (var rootWebArea in GetRootWebAreas(window))
            {
                var rootName = Safe(() => rootWebArea.Current.Name, "");
                if (IsTeamsChatSurfaceTitle(windowName) || IsTeamsChatSurfaceTitle(rootName))
                {
                    continue;
                }

                var isOffscreen = Safe<bool?>(() => rootWebArea.Current.IsOffscreen, null);
                var patternText = GetTextFromElement(rootWebArea);

                if (!IsCaptionLikeText(patternText))
                {
                    continue;
                }

                var score = GetCaptionRootScore(rootName, windowName, patternText, isOffscreen);
                roots.Add(new CaptionRootSnapshot(rootWebArea, patternText, rootName, windowName, isOffscreen, score));
            }
        }

        if (roots.Count == 0)
        {
            return roots;
        }

        var bestScore = roots.Min(root => root.Score);
        return roots.Where(root => root.Score == bestScore).ToArray();
    }

    private static IEnumerable<CaptionDraft> ConvertCandidatesToCaptions(IEnumerable<string> candidates)
    {
        var currentSpeaker = "";

        foreach (var candidate in candidates)
        {
            if (IsCaptionUiLine(candidate))
            {
                continue;
            }

            var speakerMatch = SpeakerLine.Match(candidate);
            if (IsSpeakerLine(speakerMatch))
            {
                currentSpeaker = candidate.Trim();
                continue;
            }

            var parsed = ConvertToCaption(candidate);
            if (string.IsNullOrWhiteSpace(parsed.Text))
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(parsed.Speaker) && !string.IsNullOrWhiteSpace(currentSpeaker))
            {
                parsed = parsed with { Speaker = currentSpeaker };
            }

            yield return parsed;
        }
    }

    private static IEnumerable<string> GetCaptionCandidates(string patternText)
    {
        var lines = NormalizeText(patternText)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

        var start = -1;
        var fallbackStart = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (Regex.IsMatch(lines[i], "^(Invite people to join you|Live Captions)$"))
            {
                start = i;
            }

            if (fallbackStart < 0 && IsSpeakerLine(SpeakerLine.Match(lines[i])))
            {
                fallbackStart = i;
            }
        }

        if (start < 0)
        {
            if (fallbackStart < 0)
            {
                yield break;
            }

            start = fallbackStart - 1;
        }

        var end = lines.Length;
        for (var i = start + 1; i < lines.Length; i++)
        {
            if (Regex.IsMatch(lines[i], "Closed captions overflow menu|Hide live captions|More options|Calling controls", RegexOptions.IgnoreCase) ||
                IsTeamsChromeLine(lines[i]))
            {
                end = i;
                break;
            }
        }

        if (end <= start + 1)
        {
            yield break;
        }

        for (var i = start + 1; i < end; i++)
        {
            var line = lines[i];
            if (IsTeamsChromeLine(line))
            {
                continue;
            }

            if (Regex.IsMatch(line, "^(Settings and more|Calling indicators|Encryption status|Elapsed time|Meeting controls|Chat|People|Raise your hand|React|View|More|Turn camera|Open video|Open audio|Mute mic|Share content|Leave|Shared content view|Invite people to join you|Live Captions)$", RegexOptions.IgnoreCase))
            {
                continue;
            }

            if (Regex.IsMatch(line, @"^\d{1,2}:\d{2}$"))
            {
                continue;
            }

            yield return line;
        }
    }

    private static CaptionDraft ConvertToCaption(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return new CaptionDraft("", "");
        }

        var match = Regex.Match(line, @"^(?<speaker>.+?\([^)]+\))\s+(?<text>.+)$");
        return match.Success
            ? new CaptionDraft(match.Groups["speaker"].Value.Trim(), match.Groups["text"].Value.Trim())
            : new CaptionDraft("", line.Trim());
    }

    private static bool IsSpeakerLine(Match match)
    {
        if (!match.Success)
        {
            return false;
        }

        var line = match.Value.Trim();
        if (IsTeamsChromeLine(line))
        {
            return false;
        }

        var name = match.Groups["name"].Value.Trim();
        var org = match.Groups["org"].Value.Trim();
        if (!name.Contains(' ', StringComparison.Ordinal) ||
            Regex.IsMatch(org, @"Ctrl|Alt|Shift|\+|You|more tabs|participants?", RegexOptions.IgnoreCase) ||
            Regex.IsMatch(name, @"^(Meeting with|Chat|Chats|New message|Teams|General|All Company|Shared|Join|See more|Type a message)", RegexOptions.IgnoreCase))
        {
            return false;
        }

        return true;
    }

    private static bool IsTeamsChromeLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        return Regex.IsMatch(
                line,
                @"^(New message|Chats? \(|More filters|Copilot|Quick views|Mentions|Discover|Drafts|Favorites|Teams and channels|Chat participants|Shared$|[0-9]+ more tabs\.|Add a tab|Join$|View and add participants|Find in chat|Open chat details|More chat options|Type a message|See more|See all your teams|Communities|Join communities|Resize left panel|Meeting ended|Meeting started)",
                RegexOptions.IgnoreCase) ||
            Regex.IsMatch(
                line,
                @"^.+:\s*(joined the conversation\.|named the meeting|Chat has been turned on|Meeting ended:|[0-9]{1,2}:[0-9]{2}\s*(AM|PM).*(Meeting ended|Meeting started))",
                RegexOptions.IgnoreCase);
    }

    private static bool IsCaptionLikeText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return ConvertCandidatesToCaptions(GetCaptionCandidates(text))
            .Any(caption => !string.IsNullOrWhiteSpace(caption.Speaker) && !string.IsNullOrWhiteSpace(caption.Text));
    }

    private static bool IsCaptionUiLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return true;
        }

        return Regex.IsMatch(
            line,
            "^(Captions will be shown|Live Caption,|Closed captions|Hide live captions|Caption Settings|Open captions|Live captions language|Speaker attribution|Turn off live captions|Show captions|Subtitles|More options)",
            RegexOptions.IgnoreCase);
    }

    private void SubmitObservation(
        CaptionObservation caption,
        DateTimeOffset observedAt,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        if (string.IsNullOrWhiteSpace(caption.Text))
        {
            return;
        }

        if (pending is null)
        {
            SetPending(caption, observedAt, ref pending, ref pendingChangedAt);
            return;
        }

        var sameSpeaker = string.Equals(pending.Speaker, caption.Speaker, StringComparison.Ordinal);
        if (sameSpeaker && IsRevision(pending.Text, caption.Text))
        {
            if (ComparableText(caption.Text).Length > ComparableText(pending.Text).Length)
            {
                pending = pending with
                {
                    Text = caption.Text,
                    IsOffscreen = caption.IsOffscreen,
                    WindowName = caption.WindowName
                };
                pendingChangedAt = observedAt;
            }
            return;
        }

        if (sameSpeaker && IsRevision(caption.Text, pending.Text))
        {
            return;
        }

        PublishPending(ref pending, ref pendingChangedAt);
        SetPending(caption, observedAt, ref pending, ref pendingChangedAt);
    }

    private void PublishIfStable(
        DateTimeOffset now,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        if (pending is null || pendingChangedAt is null)
        {
            return;
        }

        if (now - pendingChangedAt >= _settings.CaptionStableDelay)
        {
            PublishPending(ref pending, ref pendingChangedAt);
        }
    }

    private void PublishPending(ref CaptionObservation? pending, ref DateTimeOffset? pendingChangedAt)
    {
        if (pending is null)
        {
            return;
        }

        CaptionFinal?.Invoke(this, pending);
        pending = null;
        pendingChangedAt = null;
    }

    private static void SetPending(
        CaptionObservation caption,
        DateTimeOffset observedAt,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        pending = caption;
        pendingChangedAt = observedAt;
    }

    private static IEnumerable<CaptionObservation> GetNewSnapshotItems(
        IReadOnlyList<CaptionObservation> previous,
        IReadOnlyList<CaptionObservation> current)
    {
        if (previous.Count == 0)
        {
            return current;
        }

        var previousKeys = previous
            .Select(item => $"{item.Speaker}|{item.Text}")
            .ToHashSet(StringComparer.Ordinal);
        var newItems = new List<CaptionObservation>();

        foreach (var item in current)
        {
            var key = $"{item.Speaker}|{item.Text}";
            if (!previousKeys.Contains(key))
            {
                newItems.Add(item);
            }
        }

        return newItems;
    }

    private static bool IsRevision(string previousText, string currentText)
    {
        var previous = ComparableText(previousText);
        var current = ComparableText(currentText);
        return previous.Length > 0 &&
            current.Length >= previous.Length &&
            current.StartsWith(previous, StringComparison.OrdinalIgnoreCase);
    }

    private static string ComparableText(string text)
    {
        var value = Regex.Replace(text.Trim(), @"\s+", " ");
        return value.TrimEnd('.', ',', ';', ':', '?', '!', ' ');
    }

    private static string NormalizeText(string text)
    {
        return text
            .Replace('\ufffc', '\n')
            .Replace('\r', '\n')
            .Replace("|", "\n")
            .Replace("\t", " ");
    }

    private static string GetTextFromElement(AutomationElement element)
    {
        var texts = new List<string>();

        var valuePattern = Safe(() => element.GetCurrentPattern(ValuePattern.Pattern), null);
        if (valuePattern is ValuePattern value && !string.IsNullOrWhiteSpace(value.Current.Value))
        {
            texts.Add(value.Current.Value.Trim());
        }

        var textPattern = Safe(() => element.GetCurrentPattern(TextPattern.Pattern), null);
        if (textPattern is TextPattern text)
        {
            var documentText = Safe(() => text.DocumentRange.GetText(20000), "");
            if (!string.IsNullOrWhiteSpace(documentText))
            {
                texts.Add(documentText.Replace('\uffff', ' ').Trim());
            }
        }

        return string.Join(" | ", texts.Distinct());
    }

    private IEnumerable<AutomationElement> GetTopLevelTeamsWindows(HashSet<int> teamsProcessIds)
    {
        var root = AutomationElement.RootElement;
        var windows = Safe(
            () => root.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());

        var candidates = new List<(AutomationElement Element, int Priority)>();
        var seenHandles = new HashSet<int>();
        foreach (var window in windows)
        {
            var processId = Safe(() => window.Current.ProcessId, 0);
            var name = Safe(() => window.Current.Name, "");
            var className = Safe(() => window.Current.ClassName, "");
            var automationId = Safe(() => window.Current.AutomationId, "");
            var handle = Safe(() => window.Current.NativeWindowHandle, 0);

            if (IsTeamsAppSurfaceTitle(name) || IsTeamsChatSurfaceTitle(name))
            {
                continue;
            }

            var titlePriority = GetTeamsWindowPriority(name);
            var priority = titlePriority >= 0
                ? titlePriority
                : teamsProcessIds.Contains(processId) ||
                    _windowTitleRegex.IsMatch(name) ||
                    (Regex.IsMatch(className, "Teams|MSTeams", RegexOptions.IgnoreCase) && !string.IsNullOrWhiteSpace(name)) ||
                    automationId.Contains("Teams", StringComparison.OrdinalIgnoreCase)
                        ? 1
                        : -1;

            if (priority >= 0)
            {
                if (handle != 0)
                {
                    seenHandles.Add(handle);
                }

                candidates.Add((window, priority));
            }
        }

        foreach (var handle in GetVisibleTeamsWindowHandles(teamsProcessIds))
        {
            if (!seenHandles.Add(handle.ToInt32()))
            {
                continue;
            }

            var element = Safe(() => AutomationElement.FromHandle(handle), null);
            if (element is not null)
            {
                var title = GetWindowText(handle);
                var titlePriority = GetTeamsWindowPriority(title);
                candidates.Add((element, titlePriority >= 0 ? titlePriority : 1));
            }
        }

        if (candidates.Count == 0)
        {
            yield break;
        }

        var bestPriority = candidates.Min(candidate => candidate.Priority);
        foreach (var candidate in candidates.Where(candidate => candidate.Priority == bestPriority))
        {
            yield return candidate.Element;
        }
    }

    private static bool IsMeetingWindowName(string name)
    {
        return GetTeamsWindowPriority(name) >= 0;
    }

    private static int GetTeamsWindowPriority(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return -1;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return -1;
        }

        if (IsWebViewCallWindowTitle(name))
        {
            return 0;
        }

        if (IsTeamsAppSurfaceTitle(name))
        {
            return -1;
        }

        if (Regex.IsMatch(name, @"^(?!Chat \|).+\|\s*Microsoft Teams$", RegexOptions.IgnoreCase))
        {
            return 0;
        }

        if (Regex.IsMatch(name, @"Microsoft Teams Meeting|Reuni[oó]n|Llamada|Call", RegexOptions.IgnoreCase))
        {
            return 1;
        }

        if (Regex.IsMatch(name, @"^Chat \| .+\|\s*Microsoft Teams$|Meeting with", RegexOptions.IgnoreCase))
        {
            return 2;
        }

        return -1;
    }

    private static string? CleanMeetingTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return null;
        }

        var value = NormalizeTeamsTitle(name);

        if (string.IsNullOrWhiteSpace(value) ||
            value.Equals("Microsoft Teams", StringComparison.OrdinalIgnoreCase) ||
            IsTeamsAppSurfaceTitle(value))
        {
            return null;
        }

        return value;
    }

    private static int GetCaptionRootScore(string rootName, string windowName, string patternText, bool? isOffscreen)
    {
        var score = 0;

        if (ContainsActiveMeetingChrome(patternText))
        {
            score -= 50;
        }

        if (ContainsCaptionChrome(patternText))
        {
            score -= 20;
        }

        if (GetTeamsWindowPriority(rootName) == 0 || GetTeamsWindowPriority(windowName) == 0)
        {
            score -= 10;
        }

        if (IsTeamsChatSurfaceTitle(rootName) || IsTeamsChatSurfaceTitle(windowName))
        {
            score += 1000;
        }

        if (IsTeamsAppSurfaceTitle(rootName) || IsTeamsAppSurfaceTitle(windowName))
        {
            score += 100;
        }

        if (isOffscreen == false)
        {
            score -= 2;
        }

        return score;
    }

    private static bool ContainsActiveMeetingChrome(string text)
    {
        return Regex.IsMatch(
            text,
            @"\b(Share content|Leave|Raise your hand|Open audio options|Open video options|Turn camera on|Mute mic|People|React|Rooms|Apps)\b",
            RegexOptions.IgnoreCase);
    }

    private static bool ContainsCaptionChrome(string text)
    {
        return Regex.IsMatch(
            text,
            @"\b(Live Captions|Closed captions|Hide live captions|Caption Settings|Open captions in new window|Turn off live captions)\b",
            RegexOptions.IgnoreCase);
    }

    private static bool IsTeamsAppSurfaceTitle(string name)
    {
        var value = NormalizeTeamsTitle(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        return Regex.IsMatch(
            value,
            @"^(Activity|Calendar|Chat|Chats|Teams|Calls|Files|OneDrive|Apps|Copilot|People|Meet|Search|Settings|Help|Assignments|Viva Engage|Runtime Broker|Microsoft Teams)$",
            RegexOptions.IgnoreCase);
    }

    private static bool IsTeamsChatSurfaceTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var value = Regex.Replace(name.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        return Regex.IsMatch(value, @"^Chat\s*\|", RegexOptions.IgnoreCase);
    }

    private static bool IsWebViewCallWindowTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return false;
        }

        if (!Regex.IsMatch(name, @"^WebView2:\s*.+\|\s*Microsoft Teams$", RegexOptions.IgnoreCase))
        {
            return false;
        }

        var value = NormalizeTeamsTitle(name);
        return !IsTeamsAppSurfaceTitle(value) &&
            !Regex.IsMatch(value, @"^(Subframe|Utility|Manager|GPU Process|Crashpad)\b", RegexOptions.IgnoreCase);
    }

    private static string NormalizeTeamsTitle(string name)
    {
        var value = Regex.Replace(name.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^Chat\s*\|\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"\s*\|\s*Microsoft Teams$", "", RegexOptions.IgnoreCase);
        return value.Trim();
    }

    private string? GetCurrentMeetingTitleFromNativeWindow(HashSet<int> teamsProcessIds, bool exactCallOnly)
    {
        return GetVisibleTeamsWindowHandles(teamsProcessIds)
            .Select(handle => GetWindowText(handle))
            .Select(title => new { Title = title, Priority = GetTeamsWindowPriority(title) })
            .Where(candidate => candidate.Priority >= 0 && (!exactCallOnly || candidate.Priority == 0))
            .OrderBy(candidate => candidate.Priority)
            .Select(candidate => CleanMeetingTitle(candidate.Title))
            .FirstOrDefault(title => !string.IsNullOrWhiteSpace(title));
    }

    private IEnumerable<AutomationElement> GetRootWebAreas(AutomationElement window)
    {
        var condition = new PropertyCondition(AutomationElement.AutomationIdProperty, "RootWebArea");
        var areas = Safe(
            () => window.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());
        return areas;
    }

    private HashSet<int> GetTeamsProcessIds()
    {
        var ids = new HashSet<int>();

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (Regex.IsMatch(process.ProcessName, "^(ms-teams|msteams|teams)$", RegexOptions.IgnoreCase) ||
                    process.MainWindowTitle.Contains("Teams", StringComparison.OrdinalIgnoreCase))
                {
                    ids.Add(process.Id);
                }
            }
            catch
            {
            }
        }

        return ids;
    }

    private IEnumerable<IntPtr> GetVisibleTeamsWindowHandles(HashSet<int> teamsProcessIds)
    {
        var handles = new List<IntPtr>();

        EnumWindows((hWnd, lParam) =>
        {
            GetWindowThreadProcessId(hWnd, out var windowProcessId);
            var title = GetWindowText(hWnd);
            var className = GetClassName(hWnd);
            var visible = IsWindowVisible(hWnd);

            if (IsTeamsAppSurfaceTitle(title) || IsTeamsChatSurfaceTitle(title))
            {
                return true;
            }

            if (!visible && !IsWebViewCallWindowTitle(title))
            {
                return true;
            }

            if (teamsProcessIds.Contains((int)windowProcessId) ||
                IsMeetingWindowName(title) ||
                _windowTitleRegex.IsMatch(title) ||
                (Regex.IsMatch(className, "Teams|MSTeams", RegexOptions.IgnoreCase) && !string.IsNullOrWhiteSpace(title)))
            {
                handles.Add(hWnd);
            }

            return true;
        }, IntPtr.Zero);

        return handles;
    }

    private static string GetWindowText(IntPtr hWnd)
    {
        var length = GetWindowTextLength(hWnd);
        if (length <= 0)
        {
            return "";
        }

        var builder = new StringBuilder(length + 1);
        _ = GetWindowText(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string GetClassName(IntPtr hWnd)
    {
        var builder = new StringBuilder(256);
        _ = GetClassName(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static T Safe<T>(Func<T> fn, T fallback)
    {
        try
        {
            return fn();
        }
        catch
        {
            return fallback;
        }
    }

    private sealed record CaptionDraft(string Speaker, string Text);

    private sealed record CaptionRootSnapshot(
        AutomationElement Element,
        string PatternText,
        string RootName,
        string WindowName,
        bool? IsOffscreen,
        int Score);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
