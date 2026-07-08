using System.Windows.Automation;

namespace Minutas.Desktop.Services;

public sealed class MeetingPresenceWatcher : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    // Debounce mirrors the extension: pre-join lobbies flash the Leave button and Teams
    // re-renders the call stage on layout changes, so only sustained presence is a real
    // join and only sustained absence (8 s) is a real leave.
    private static readonly TimeSpan JoinDebounce = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan LeaveDebounce = TimeSpan.FromSeconds(8);

    private static readonly Condition ButtonCondition =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);

    // Teams v2 (ES) renders the short label "Salir" on the leave button — a Contains match
    // against the old long forms never fired, so presence was never detected. Match the
    // real short labels exactly (trim, case-insensitive) plus the long-form prefixes.
    private static readonly string[] LeaveExactNames =
    {
        "salir", "colgar", "leave", "hang up", "finalizar llamada", "end call"
    };

    private static readonly string[] LeaveContainsNames = { "salir de la ", "leave call", "hang up" };

    private static readonly string[] LeaveIds = { "hangup", "leave-button", "hangup-leave", "end-meeting" };

    private readonly TeamsCaptionWatcher _windows;
    private readonly object _sync = new();

    private CancellationTokenSource? _cts;

    public MeetingPresenceWatcher(TeamsCaptionWatcher windows)
    {
        _windows = windows;
    }

    public event EventHandler? MeetingJoined;
    public event EventHandler? MeetingLeft;

    public void Start()
    {
        lock (_sync)
        {
            if (_cts is not null)
            {
                return;
            }

            _cts = new CancellationTokenSource();
            _ = Task.Run(() => RunAsync(_cts.Token));
        }
    }

    public void Stop()
    {
        CancellationTokenSource? cts;
        lock (_sync)
        {
            cts = _cts;
            _cts = null;
        }

        cts?.Cancel();
        cts?.Dispose();
    }

    public void Dispose() => Stop();

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var inMeeting = false;
        DateTimeOffset? presentSince = null;
        DateTimeOffset? absentSince = null;

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var present = IsMeetingActive();
                var now = DateTimeOffset.UtcNow;

                if (present)
                {
                    absentSince = null;
                    if (!inMeeting)
                    {
                        presentSince ??= now;
                        if (now - presentSince >= JoinDebounce)
                        {
                            inMeeting = true;
                            presentSince = null;
                            MeetingJoined?.Invoke(this, EventArgs.Empty);
                        }
                    }
                }
                else
                {
                    presentSince = null;
                    if (inMeeting)
                    {
                        absentSince ??= now;
                        if (now - absentSince >= LeaveDebounce)
                        {
                            inMeeting = false;
                            absentSince = null;
                            MeetingLeft?.Invoke(this, EventArgs.Empty);
                        }
                    }
                }

                await Task.Delay(PollInterval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                try
                {
                    await Task.Delay(PollInterval, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    private bool IsMeetingActive()
    {
        foreach (var window in _windows.GetActiveTeamsWindows())
        {
            var buttons = Safe(
                () => window.FindAll(TreeScope.Descendants, ButtonCondition).Cast<AutomationElement>().ToArray(),
                Array.Empty<AutomationElement>());

            foreach (var button in buttons)
            {
                var name = Safe(() => button.Current.Name, "");
                if (IsLeaveName(name))
                {
                    return true;
                }

                var autoId = Safe(() => button.Current.AutomationId, "");
                if (NameContainsAny(autoId, LeaveIds))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsLeaveName(string value)
    {
        var trimmed = value.Trim();
        foreach (var exact in LeaveExactNames)
        {
            if (string.Equals(trimmed, exact, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return NameContainsAny(trimmed, LeaveContainsNames);
    }

    private static bool NameContainsAny(string value, string[] needles)
    {
        foreach (var needle in needles)
        {
            if (value.Contains(needle, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
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
}
