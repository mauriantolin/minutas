using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Minutas.Desktop.Models;

namespace Minutas.Desktop.Services;

public sealed class CaptureSessionService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const string DefaultMeetingTitle = "Meeting with Microsoft Teams";
    private static readonly TimeSpan TitleDetectionWindow = TimeSpan.FromMinutes(10);

    private readonly AppSettings _settings;
    private readonly AppPaths _paths;
    private readonly MeetingsApiClient _api;
    private readonly TeamsCaptionWatcher _captions;

    private CaptureState? _state;

    public CaptureSessionService(
        AppSettings settings,
        AppPaths paths,
        MeetingsApiClient api,
        TeamsCaptionWatcher captions)
    {
        _settings = settings;
        _paths = paths;
        _api = api;
        _captions = captions;
        _captions.CaptionFinal += OnCaptionFinal;
        _captions.StatusChanged += (_, message) => StatusChanged?.Invoke(this, message);
    }

    public event EventHandler<string>? StatusChanged;
    public event EventHandler<CaptionEvent>? CaptionCaptured;
    public event EventHandler<CaptureStateChangedEventArgs>? CaptureStateChanged;

    public bool IsCapturing => _state is not null;
    public string? CurrentMeetingId => _state?.MeetingId;
    public string? DetectCurrentMeetingTitle() => _captions.GetCurrentMeetingTitle();

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_state is not null)
        {
            throw new InvalidOperationException("Capture already in progress.");
        }

        var captureId = Guid.NewGuid().ToString();
        var startedAt = DateTimeOffset.UtcNow;
        var detectedTitle = _captions.GetCurrentMeetingTitle();
        var title = IsUsefulMeetingTitle(detectedTitle) ? detectedTitle! : DefaultMeetingTitle;
        var directory = Path.Combine(_paths.Captures, $"{startedAt:yyyyMMdd-HHmmss}-{captureId}");
        Directory.CreateDirectory(directory);

        var meetingId = IsGenericMeetingTitle(title)
            ? null
            : await _api.RegisterMeetingAsync(
                new MeetingRegistrationRequest(captureId, title, startedAt.ToString("O")),
                cancellationToken).ConfigureAwait(false);

        _state = new CaptureState(
            CaptureId: captureId,
            MeetingId: meetingId,
            Title: title,
            StartedAt: startedAt,
            ConsentGrantedAt: startedAt,
            Directory: directory,
            TranscriptPath: Path.Combine(directory, "captions.txt"),
            JsonlPath: Path.Combine(directory, "captions.jsonl"),
            Cancellation: new CancellationTokenSource());

        StatusChanged?.Invoke(this, meetingId is null
            ? "Capturando. Esperando reunión de Teams..."
            : $"Capturando. MeetingId: {meetingId}");
        CaptureStateChanged?.Invoke(this, new CaptureStateChangedEventArgs(true, meetingId));

        _ = Task.Run(() => RunTitleDetectionLoopAsync(_state, _state.Cancellation.Token), CancellationToken.None);
        _ = Task.Run(() => RunCaptureAsync(_state, _state.Cancellation.Token), CancellationToken.None);
        _ = Task.Run(() => RunFlushLoopAsync(_state, _state.Cancellation.Token), CancellationToken.None);
    }

    public async Task<FinalizeResponse?> StopAsync(CancellationToken cancellationToken = default)
    {
        var state = _state;
        if (state is null)
        {
            return null;
        }

        _state = null;
        await state.Cancellation.CancelAsync().ConfigureAwait(false);
        RefreshMeetingTitleFromTeams(state);
        await EnsureMeetingRegisteredAsync(state, cancellationToken).ConfigureAwait(false);
        await FlushAsync(state, force: true, cancellationToken).ConfigureAwait(false);

        FinalizeResponse? result = null;
        if (!string.IsNullOrWhiteSpace(state.MeetingId))
        {
            var endedAt = DateTimeOffset.UtcNow;
            result = await _api.FinalizeMeetingAsync(
                state.MeetingId,
                new FinalizeRequest(
                    state.CaptureId,
                    state.Title,
                    state.StartedAt.ToString("O"),
                    endedAt.ToString("O"),
                    "Yo",
                    state.AllSegments,
                    Array.Empty<object>(),
                    state.AllCaptionEvents,
                    state.Participants.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray(),
                    BuildSignalHealth(state),
                    new AudioConsent(0, state.ConsentGrantedAt.ToString("O"))),
                cancellationToken).ConfigureAwait(false);
        }

        state.Cancellation.Dispose();
        CaptureStateChanged?.Invoke(this, new CaptureStateChangedEventArgs(false, state.MeetingId));
        StatusChanged?.Invoke(this, result?.Error is null ? "Captura finalizada." : result.Error);
        return result;
    }

    public async Task CancelAsync()
    {
        var state = _state;
        if (state is null)
        {
            return;
        }

        _state = null;
        await state.Cancellation.CancelAsync().ConfigureAwait(false);
        state.Cancellation.Dispose();
        CaptureStateChanged?.Invoke(this, new CaptureStateChangedEventArgs(false, state.MeetingId));
        StatusChanged?.Invoke(this, "Captura cancelada. El archivo local queda guardado.");
    }

    public string? LiveUrl() => _state?.MeetingId is { Length: > 0 } id ? _api.LiveUrl(id) : null;

    private async Task RunTitleDetectionLoopAsync(CaptureState state, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TitleDetectionWindow;

        while (!cancellationToken.IsCancellationRequested && DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                RefreshMeetingTitleFromTeams(state);
                await EnsureMeetingRegisteredAsync(state, cancellationToken).ConfigureAwait(false);

                if (!string.IsNullOrWhiteSpace(state.MeetingId) && !IsGenericMeetingTitle(state.Title))
                {
                    return;
                }

                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                StatusChanged?.Invoke(this, $"No se pudo detectar la reunión: {ex.Message}");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    private async Task RunCaptureAsync(CaptureState state, CancellationToken cancellationToken)
    {
        try
        {
            await _captions.WatchAsync(state.StartedAt, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            StatusChanged?.Invoke(this, $"Error leyendo Teams: {ex.Message}");
        }
    }

    private async Task RunFlushLoopAsync(CaptureState state, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_settings.SegmentFlushInterval, cancellationToken).ConfigureAwait(false);
                RefreshMeetingTitleFromTeams(state);
                await FlushAsync(state, force: false, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                StatusChanged?.Invoke(this, $"No se pudo sincronizar: {ex.Message}");
            }
        }
    }

    private void OnCaptionFinal(object? sender, CaptionObservation observation)
    {
        var state = _state;
        if (state is null)
        {
            return;
        }

        TryUpdateMeetingTitle(state, observation.WindowName, notify: true);

        var caption = new CaptionEvent(observation.ElapsedSeconds, observation.Speaker, observation.Text, true);
        CaptionSegment? previousSegment = null;
        lock (state.Sync)
        {
            state.DomReadCount++;
            state.Participants.Add(observation.Speaker);
            state.AllCaptionEvents.Add(caption);
            state.PendingCaptionEvents.Add(caption);

            if (state.PendingCaptionForSegment is not null)
            {
                previousSegment = BuildSegment(state.PendingCaptionForSegment, caption.T);
                state.AllSegments.Add(previousSegment);
                state.PendingSegments.Add(previousSegment);
            }

            state.PendingCaptionForSegment = caption;
            AppendLocal(state, caption);
        }

        CaptionCaptured?.Invoke(this, caption);
    }

    private async Task FlushAsync(CaptureState state, bool force, CancellationToken cancellationToken)
    {
        await EnsureMeetingRegisteredAsync(state, cancellationToken).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(state.MeetingId))
        {
            return;
        }

        List<CaptionSegment> segments;
        List<CaptionEvent> captions;
        int seq;
        SignalHealth health;

        lock (state.Sync)
        {
            if (force && state.PendingCaptionForSegment is not null)
            {
                var final = BuildSegment(state.PendingCaptionForSegment, EstimateEndTime(state.PendingCaptionForSegment));
                state.AllSegments.Add(final);
                state.PendingSegments.Add(final);
                state.PendingCaptionForSegment = null;
            }

            if (!force && state.PendingSegments.Count < _settings.SegmentFlushMax && state.PendingCaptionEvents.Count == 0)
            {
                return;
            }

            if (state.PendingSegments.Count == 0 && state.PendingCaptionEvents.Count == 0)
            {
                return;
            }

            segments = state.PendingSegments.ToList();
            captions = state.PendingCaptionEvents.ToList();
            seq = state.NextSeq;
            health = BuildSignalHealth(state);
        }

        var ok = await _api.SendSegmentsAsync(
            state.MeetingId,
            new SegmentsRequest(seq, segments, captions.Count > 0 ? captions : null, health),
            cancellationToken).ConfigureAwait(false);

        if (!ok)
        {
            StatusChanged?.Invoke(this, "Backend no acepto el lote; se reintentara.");
            return;
        }

        lock (state.Sync)
        {
            state.NextSeq++;
            RemovePrefix(state.PendingSegments, segments.Count);
            RemovePrefix(state.PendingCaptionEvents, captions.Count);
        }

        StatusChanged?.Invoke(this, "Sincronizado.");
    }

    private void RefreshMeetingTitleFromTeams(CaptureState state)
    {
        var detectedTitle = _captions.GetCurrentMeetingTitle();
        TryUpdateMeetingTitle(state, detectedTitle, notify: true);
    }

    private bool TryUpdateMeetingTitle(CaptureState state, string? title, bool notify)
    {
        var normalizedTitle = NormalizeDetectedMeetingTitle(title);
        if (!IsUsefulMeetingTitle(normalizedTitle))
        {
            return false;
        }

        var nextTitle = normalizedTitle!;
        var updated = false;
        lock (state.Sync)
        {
            if (ShouldReplaceMeetingTitle(state.Title, nextTitle))
            {
                state.Title = nextTitle;
                updated = true;
            }
        }

        if (updated && notify)
        {
            StatusChanged?.Invoke(this, $"Reunión detectada: {nextTitle}");
        }

        return updated;
    }

    private async Task EnsureMeetingRegisteredAsync(CaptureState state, CancellationToken cancellationToken)
    {
        await state.RegistrationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        var lockTaken = true;
        try
        {
            string title;
            bool hasCaptions;
            lock (state.Sync)
            {
                if (!string.IsNullOrWhiteSpace(state.MeetingId))
                {
                    return;
                }

                title = state.Title;
                hasCaptions = state.AllCaptionEvents.Count > 0;
            }

            if (IsGenericMeetingTitle(title) && !hasCaptions)
            {
                return;
            }

            var meetingId = await _api.RegisterMeetingAsync(
                new MeetingRegistrationRequest(state.CaptureId, title, state.StartedAt.ToString("O")),
                cancellationToken).ConfigureAwait(false);

            if (string.IsNullOrWhiteSpace(meetingId))
            {
                return;
            }

            lock (state.Sync)
            {
                if (!string.IsNullOrWhiteSpace(state.MeetingId))
                {
                    return;
                }

                state.MeetingId = meetingId;
            }

            CaptureStateChanged?.Invoke(this, new CaptureStateChangedEventArgs(true, meetingId));
            StatusChanged?.Invoke(this, $"Capturando. MeetingId: {meetingId}");
        }
        finally
        {
            if (lockTaken)
            {
                state.RegistrationLock.Release();
            }
        }
    }

    private static void RemovePrefix<T>(List<T> list, int count)
    {
        if (count <= 0)
        {
            return;
        }

        list.RemoveRange(0, Math.Min(count, list.Count));
    }

    private static CaptionSegment BuildSegment(CaptionEvent caption, double endTime)
    {
        return new CaptionSegment("caption", caption.SpeakerName, caption.T, Math.Max(endTime, caption.T + 0.2), caption.Text);
    }

    private static double EstimateEndTime(CaptionEvent caption)
    {
        var words = caption.Text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        return caption.T + Math.Max(1.5, 0.35 * words);
    }

    private static SignalHealth BuildSignalHealth(CaptureState state)
    {
        return new SignalHealth(
            CaptionsSeen: state.AllCaptionEvents.Count > 0,
            SpeakerRingSeen: false,
            DomReadCount: state.DomReadCount,
            AsrMode: "teams-desktop-uia");
    }

    private static void AppendLocal(CaptureState state, CaptionEvent caption)
    {
        var stamp = TimeSpan.FromSeconds(caption.T).ToString(@"hh\:mm\:ss");
        File.AppendAllText(state.TranscriptPath, $"[{stamp}] {caption.SpeakerName}: {caption.Text}{Environment.NewLine}");
        File.AppendAllText(state.JsonlPath, JsonSerializer.Serialize(caption, JsonOptions) + Environment.NewLine);
    }

    private static bool IsUsefulMeetingTitle(string? title)
    {
        return !string.IsNullOrWhiteSpace(title) &&
            !title.Equals("Microsoft Teams", StringComparison.OrdinalIgnoreCase) &&
            !title.Equals("Calendar", StringComparison.OrdinalIgnoreCase) &&
            !title.Equals("Chat", StringComparison.OrdinalIgnoreCase);
    }

    private static string? NormalizeDetectedMeetingTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        if (Regex.IsMatch(
                Regex.Replace(title.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase),
                @"^Chat\s*\|",
                RegexOptions.IgnoreCase))
        {
            return null;
        }

        var value = Regex.Replace(title.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^Chat\s*\|\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"\s*\|\s*Microsoft Teams$", "", RegexOptions.IgnoreCase);
        return value.Trim();
    }

    private static bool IsGenericMeetingTitle(string? title)
    {
        return string.IsNullOrWhiteSpace(title) ||
            title.Equals(DefaultMeetingTitle, StringComparison.OrdinalIgnoreCase);
    }

    private static bool ShouldReplaceMeetingTitle(string current, string next)
    {
        if (string.Equals(current, next, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (IsGenericMeetingTitle(current))
        {
            return true;
        }

        if (current.StartsWith("Meeting with ", StringComparison.OrdinalIgnoreCase) &&
            !next.StartsWith("Meeting with ", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    public sealed record CaptureStateChangedEventArgs(bool Capturing, string? MeetingId);

    private sealed class CaptureState
    {
        public CaptureState(
            string CaptureId,
            string? MeetingId,
            string Title,
            DateTimeOffset StartedAt,
            DateTimeOffset ConsentGrantedAt,
            string Directory,
            string TranscriptPath,
            string JsonlPath,
            CancellationTokenSource Cancellation)
        {
            this.CaptureId = CaptureId;
            this.MeetingId = MeetingId;
            this.Title = Title;
            this.StartedAt = StartedAt;
            this.ConsentGrantedAt = ConsentGrantedAt;
            this.Directory = Directory;
            this.TranscriptPath = TranscriptPath;
            this.JsonlPath = JsonlPath;
            this.Cancellation = Cancellation;
        }

        public string CaptureId { get; }
        public string? MeetingId { get; set; }
        public string Title { get; set; }
        public DateTimeOffset StartedAt { get; }
        public DateTimeOffset ConsentGrantedAt { get; }
        public string Directory { get; }
        public string TranscriptPath { get; }
        public string JsonlPath { get; }
        public CancellationTokenSource Cancellation { get; }
        public SemaphoreSlim RegistrationLock { get; } = new(1, 1);
        public object Sync { get; } = new();
        public int NextSeq { get; set; } = 1;
        public int DomReadCount { get; set; }
        public CaptionEvent? PendingCaptionForSegment { get; set; }
        public List<CaptionEvent> AllCaptionEvents { get; } = [];
        public List<CaptionEvent> PendingCaptionEvents { get; } = [];
        public List<CaptionSegment> AllSegments { get; } = [];
        public List<CaptionSegment> PendingSegments { get; } = [];
        public HashSet<string> Participants { get; } = new(StringComparer.OrdinalIgnoreCase);
    }
}
