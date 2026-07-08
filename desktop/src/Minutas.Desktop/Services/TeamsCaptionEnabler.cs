using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace Minutas.Desktop.Services;

public sealed class TeamsCaptionEnabler
{
    private static readonly Condition InteractiveControls = new OrCondition(
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox));

    private static readonly string[] MoreNames = { "more options", "more actions", "más opciones", "mas opciones" };
    private static readonly string[] MoreIds = { "showmore", "more-button", "morebtn", "moreoptions" };
    private static readonly string[] LanguageNames = { "language and speech", "language & speech", "idioma y voz", "idioma y habla" };
    private static readonly string[] LanguageIds = { "languagespeech", "language-speech" };
    private static readonly string[] TurnOnNames = { "turn on live captions", "turn on captions", "activar subtítulos en vivo", "activar subtitulos en vivo", "activar subtítulos", "activar subtitulos", "show live captions" };
    private static readonly string[] TurnOffNames = { "turn off live captions", "turn off captions", "desactivar subtítulos en vivo", "desactivar subtitulos en vivo", "desactivar subtítulos", "desactivar subtitulos", "hide live captions" };
    private static readonly string[] CaptionIds = { "closed-captions-button", "closed-captions", "live-captions" };

    private const byte VkEscape = 0x1B;
    private const uint KeyEventKeyUp = 0x0002;

    private readonly TeamsCaptionWatcher _windows;

    public TeamsCaptionEnabler(TeamsCaptionWatcher windows)
    {
        _windows = windows;
    }

    public event EventHandler<string>? StatusChanged;

    public async Task<bool> EnsureCaptionsEnabledAsync(CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return false;
            }

            if (_windows.AreCaptionsVisible())
            {
                return true;
            }

            if (await TryEnableOnceAsync(cancellationToken).ConfigureAwait(false))
            {
                return true;
            }

            if (!await DelayAsync(1500, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
        }

        if (_windows.AreCaptionsVisible())
        {
            return true;
        }

        StatusChanged?.Invoke(this, "No se pudieron activar los subtítulos de Teams. Activalos manualmente (Más opciones → Idioma y voz) y seguiremos leyendo.");
        return false;
    }

    private async Task<bool> TryEnableOnceAsync(CancellationToken cancellationToken)
    {
        try
        {
            var more = FindControl(MoreNames, MoreIds);
            if (more is null || !TryInvoke(more))
            {
                return false;
            }

            if (!await DelayAsync(600, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }

            var language = FindControl(LanguageNames, LanguageIds);
            if (language is null || !TryInvoke(language))
            {
                return false;
            }

            if (!await DelayAsync(600, cancellationToken).ConfigureAwait(false))
            {
                return false;
            }

            // Captions already on: the submenu offers "turn off", never "turn on" — so we
            // never re-click and accidentally toggle them back off.
            if (FindControl(TurnOffNames, null) is not null)
            {
                return true;
            }

            var turnOn = FindControl(TurnOnNames, CaptionIds);
            if (turnOn is null || !TryInvoke(turnOn))
            {
                return false;
            }

            await DelayAsync(1500, cancellationToken).ConfigureAwait(false);
            return true;
        }
        finally
        {
            CloseMenus();
        }
    }

    private AutomationElement? FindControl(string[] names, string[]? ids)
    {
        foreach (var window in _windows.GetActiveTeamsWindows())
        {
            var controls = Safe(
                () => window.FindAll(TreeScope.Descendants, InteractiveControls).Cast<AutomationElement>().ToArray(),
                Array.Empty<AutomationElement>());

            foreach (var control in controls)
            {
                var name = Safe(() => control.Current.Name, "");
                if (NameContainsAny(name, names))
                {
                    return control;
                }

                if (ids is not null)
                {
                    var autoId = Safe(() => control.Current.AutomationId, "");
                    if (NameContainsAny(autoId, ids))
                    {
                        return control;
                    }
                }
            }
        }

        return null;
    }

    private static bool TryInvoke(AutomationElement element)
    {
        if (Safe(() => element.GetCurrentPattern(InvokePattern.Pattern), null) is InvokePattern invoke)
        {
            try
            {
                invoke.Invoke();
                return true;
            }
            catch
            {
            }
        }

        if (Safe(() => element.GetCurrentPattern(ExpandCollapsePattern.Pattern), null) is ExpandCollapsePattern expand)
        {
            try
            {
                expand.Expand();
                return true;
            }
            catch
            {
            }
        }

        // SelectionItemPattern covers toggle/menu-check items that expose neither Invoke nor
        // ExpandCollapse (some Teams menu entries render as selectable list items).
        if (Safe(() => element.GetCurrentPattern(SelectionItemPattern.Pattern), null) is SelectionItemPattern selection)
        {
            try
            {
                selection.Select();
                return true;
            }
            catch
            {
            }
        }

        return false;
    }

    private void CloseMenus()
    {
        try
        {
            var foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero)
            {
                return;
            }

            GetWindowThreadProcessId(foreground, out var processId);

            // Only inject Escape when Teams itself owns the foreground, so we never leak a
            // keystroke into another app the user switched to mid-attempt.
            if (!IsTeamsProcess((int)processId))
            {
                return;
            }

            keybd_event(VkEscape, 0, 0, UIntPtr.Zero);
            keybd_event(VkEscape, 0, KeyEventKeyUp, UIntPtr.Zero);
        }
        catch
        {
        }
    }

    private static bool IsTeamsProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return Regex.IsMatch(process.ProcessName, "teams", RegexOptions.IgnoreCase);
        }
        catch
        {
            return false;
        }
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

    private static async Task<bool> DelayAsync(int milliseconds, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(milliseconds, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
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

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
