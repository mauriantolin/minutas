using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Minutas.Desktop.Models;
using Minutas.Desktop.Services;
using Forms = System.Windows.Forms;

namespace Minutas.Desktop.UI;

public sealed partial class MainWindow : Window
{
    private readonly AppSettings _settings;
    private readonly CognitoAuthClient _auth;
    private readonly MeetingsApiClient _api;
    private readonly CaptureSessionService _recorder;
    private readonly TeamsCaptionEnabler _captionEnabler;
    private readonly MeetingPresenceWatcher _presence;
    private readonly ObservableCollection<ActivityRow> _activityRows = new();
    private readonly DispatcherTimer _elapsedTimer = new();
    private readonly Forms.NotifyIcon _tray;

    private DateTimeOffset? _captureStartedAt;
    private string? _signedEmail;
    private bool _reallyClose;
    private bool _autoCaptureEnabled;
    private bool _autoStartedCapture;

    public MainWindow(
        AppSettings settings,
        CognitoAuthClient auth,
        MeetingsApiClient api,
        CaptureSessionService recorder,
        TeamsCaptionEnabler captionEnabler,
        MeetingPresenceWatcher presence)
    {
        _settings = settings;
        _auth = auth;
        _api = api;
        _recorder = recorder;
        _captionEnabler = captionEnabler;
        _presence = presence;

        InitializeComponent();

        ActivityList.ItemsSource = _activityRows;
        EmailBox.Text = "";
        _autoCaptureEnabled = _settings.AutoCapture;
        AutoCaptureCheck.IsChecked = _settings.AutoCapture;
        SetStatus("Listo.");
        SetCaptureUi(false);

        _tray = BuildTray();
        _elapsedTimer.Interval = TimeSpan.FromSeconds(1);
        _elapsedTimer.Tick += (_, _) => RefreshElapsed();

        WireEvents();
        RefreshPlaceholders();
    }

    protected override async void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);
        await RefreshAuthUiAsync();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_reallyClose)
        {
            e.Cancel = true;
            Hide();
            _tray.Visible = true;
            _tray.ShowBalloonTip(1500, "Minutix", "La app queda activa en la bandeja.", Forms.ToolTipIcon.Info);
            return;
        }

        _presence.Dispose();
        _tray.Dispose();
        base.OnClosing(e);
    }

    private Forms.NotifyIcon BuildTray()
    {
        var open = new Forms.ToolStripMenuItem("Abrir", null, (_, _) => ShowWindow());
        var start = new Forms.ToolStripMenuItem("Iniciar captura", null, async (_, _) => await StartCaptureAsync());
        var stop = new Forms.ToolStripMenuItem("Detener y resumir", null, async (_, _) => await StopCaptureAsync());
        var exit = new Forms.ToolStripMenuItem("Salir", null, async (_, _) => await ExitAsync());

        return new Forms.NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "Minutix Desktop",
            Visible = true,
            ContextMenuStrip = new Forms.ContextMenuStrip
            {
                Items = { open, start, stop, exit }
            }
        };
    }

    private static System.Drawing.Icon LoadTrayIcon()
    {
        try
        {
            var executable = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(executable))
            {
                return System.Drawing.Icon.ExtractAssociatedIcon(executable)
                    ?? System.Drawing.SystemIcons.Application;
            }
        }
        catch
        {
        }

        return System.Drawing.SystemIcons.Application;
    }

    private void WireEvents()
    {
        SignInButton.Click += async (_, _) => await SignInAsync();
        SignOutButton.Click += async (_, _) => await SignOutAsync();
        StartButton.Click += async (_, _) => await StartCaptureAsync();
        StopButton.Click += async (_, _) => await StopCaptureAsync();
        CancelButton.Click += async (_, _) => await CancelCaptureAsync();
        OpenLiveButton.Click += (_, _) => OpenLive();
        OpenPanelButton.Click += (_, _) => OpenUrl(_settings.DashboardUrl);
        _tray.DoubleClick += (_, _) => ShowWindow();

        _recorder.StatusChanged += (_, message) => Dispatch(() => SetStatus(message));
        _recorder.CaptureStateChanged += (_, args) => Dispatch(() => SetCaptureUi(args.Capturing));
        _recorder.CaptionCaptured += (_, caption) => Dispatch(() => AddCaptionRow(caption));

        _captionEnabler.StatusChanged += (_, message) => Dispatch(() => SetStatus(message));
        _presence.MeetingJoined += OnMeetingJoined;
        _presence.MeetingLeft += OnMeetingLeft;

        AutoCaptureCheck.Checked += (_, _) => _autoCaptureEnabled = true;
        AutoCaptureCheck.Unchecked += (_, _) => _autoCaptureEnabled = false;

        PasswordBox.KeyDown += async (_, e) =>
        {
            if (e.Key == Key.Enter)
            {
                await SignInAsync();
            }
        };

        EmailBox.TextChanged += (_, _) => RefreshPlaceholders();
        EmailBox.GotKeyboardFocus += (_, _) => RefreshPlaceholders();
        EmailBox.LostKeyboardFocus += (_, _) => RefreshPlaceholders();
        PasswordBox.PasswordChanged += (_, _) => RefreshPlaceholders();
        PasswordBox.GotKeyboardFocus += (_, _) => RefreshPlaceholders();
        PasswordBox.LostKeyboardFocus += (_, _) => RefreshPlaceholders();
    }

    private async Task RefreshAuthUiAsync()
    {
        try
        {
            var hasSession = await _auth.HasSessionAsync().ConfigureAwait(false);
            _signedEmail = hasSession ? await _auth.GetSessionEmailAsync().ConfigureAwait(false) : null;

            Dispatch(() =>
            {
                ToggleAuthPanels(hasSession);
                if (hasSession)
                {
                    SetAccount(_signedEmail);
                }
            });

            if (hasSession)
            {
                _presence.Start();
                await LoadRecentMeetingsAsync().ConfigureAwait(false);
            }
            else
            {
                _presence.Stop();
                Dispatch(() =>
                {
                    _activityRows.Clear();
                    ActivityTitle.Text = "Últimas reuniones";
                    _activityRows.Add(new ActivityRow("Iniciá sesión para ver tus reuniones", "", null));
                });
            }
        }
        catch (Exception ex)
        {
            Dispatch(() => SetStatus($"No se pudo validar la sesión: {ex.Message}"));
        }
    }

    private async Task SignInAsync()
    {
        var email = EmailBox.Text.Trim();
        var password = PasswordBox.Password;
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            SetStatus("Ingresá email y contraseña.");
            return;
        }

        try
        {
            SignInButton.IsEnabled = false;
            SetStatus("Iniciando sesión...");
            await _auth.SignInAsync(email, password).ConfigureAwait(false);
            _signedEmail = email;
            Dispatch(() =>
            {
                PasswordBox.Clear();
                RefreshPlaceholders();
                SetAccount(email);
                ToggleAuthPanels(true);
            });
            _presence.Start();
            await LoadRecentMeetingsAsync().ConfigureAwait(false);
            Dispatch(() => SetStatus("Listo."));
        }
        catch (Exception ex)
        {
            Dispatch(() => SetStatus($"No se pudo iniciar sesión: {ex.Message}"));
        }
        finally
        {
            Dispatch(() => SignInButton.IsEnabled = true);
        }
    }

    private async Task SignOutAsync()
    {
        if (_recorder.IsCapturing)
        {
            await StopCaptureAsync().ConfigureAwait(false);
        }

        _presence.Stop();
        _autoStartedCapture = false;
        _auth.SignOut();
        _signedEmail = null;
        Dispatch(() =>
        {
            ToggleAuthPanels(false);
            _activityRows.Clear();
            ActivityTitle.Text = "Últimas reuniones";
            _activityRows.Add(new ActivityRow("Iniciá sesión para ver tus reuniones", "", null));
            SetStatus("Sesión cerrada.");
        });
    }

    private async Task LoadRecentMeetingsAsync()
    {
        try
        {
            Dispatch(() =>
            {
                ActivityTitle.Text = "Últimas reuniones";
                _activityRows.Clear();
                _activityRows.Add(new ActivityRow("Cargando reuniones...", "", null));
            });

            var meetings = await _api.GetRecentMeetingsAsync(CancellationToken.None).ConfigureAwait(false);

            Dispatch(() =>
            {
                _activityRows.Clear();
                foreach (var meeting in meetings.Take(8))
                {
                    _activityRows.Add(new ActivityRow(
                        string.IsNullOrWhiteSpace(meeting.Title) ? "Reunión sin título" : meeting.Title,
                        FormatMeetingTime(meeting.StartedAt),
                        _api.MeetingUrl(meeting.MeetingId)));
                }

                if (_activityRows.Count == 0)
                {
                    _activityRows.Add(new ActivityRow("Todavía no hay reuniones", "", null));
                }
            });
        }
        catch (Exception ex)
        {
            Dispatch(() =>
            {
                _activityRows.Clear();
                _activityRows.Add(new ActivityRow("No se pudieron cargar las reuniones", "", null));
                SetStatus($"Error cargando reuniones: {ex.Message}");
            });
        }
    }

    private async Task StartCaptureAsync(bool autoStarted = false)
    {
        if (_recorder.IsCapturing)
        {
            return;
        }

        try
        {
            _autoStartedCapture = autoStarted;
            StartButton.IsEnabled = false;
            SetStatus("Preparando captura...");
            _captureStartedAt = DateTimeOffset.Now;
            ActivityTitle.Text = "Subtítulos capturados";
            _activityRows.Clear();
            _activityRows.Add(new ActivityRow("Esperando subtítulos de Teams...", "", null));
            SetCaptureUi(true);
            await _recorder.StartAsync().ConfigureAwait(false);
            _ = _captionEnabler.EnsureCaptionsEnabledAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _autoStartedCapture = false;
            Dispatch(() =>
            {
                _captureStartedAt = null;
                SetCaptureUi(false);
                SetStatus($"No se pudo iniciar: {ex.Message}");
            });
        }
        finally
        {
            Dispatch(() => StartButton.IsEnabled = true);
        }
    }

    private async Task StopCaptureAsync()
    {
        if (!_recorder.IsCapturing)
        {
            return;
        }

        _autoStartedCapture = false;

        try
        {
            StopButton.IsEnabled = false;
            CancelButton.IsEnabled = false;
            SetStatus("Finalizando y generando resumen...");
            await _recorder.StopAsync().ConfigureAwait(false);
            Dispatch(() => SetCaptureUi(false));
            await LoadRecentMeetingsAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Dispatch(() => SetStatus($"No se pudo finalizar: {ex.Message}"));
        }
        finally
        {
            Dispatch(() =>
            {
                StopButton.IsEnabled = true;
                CancelButton.IsEnabled = true;
            });
        }
    }

    private async Task CancelCaptureAsync()
    {
        if (!_recorder.IsCapturing)
        {
            return;
        }

        _autoStartedCapture = false;

        try
        {
            SetStatus("Descartando captura...");
            await _recorder.CancelAsync().ConfigureAwait(false);
            Dispatch(() => SetCaptureUi(false));
            await LoadRecentMeetingsAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Dispatch(() => SetStatus($"No se pudo descartar: {ex.Message}"));
        }
    }

    private void OnMeetingJoined(object? sender, EventArgs e)
    {
        _ = HandleMeetingJoinedAsync();
    }

    private async Task HandleMeetingJoinedAsync()
    {
        if (!_autoCaptureEnabled || _recorder.IsCapturing)
        {
            return;
        }

        bool hasSession;
        try
        {
            hasSession = await _auth.HasSessionAsync().ConfigureAwait(false);
        }
        catch
        {
            return;
        }

        if (!hasSession)
        {
            Dispatch(() => _tray.ShowBalloonTip(
                4000,
                "Minutix",
                "Se detectó una reunión de Teams. Iniciá sesión en Minutix para transcribir automáticamente.",
                Forms.ToolTipIcon.Info));
            return;
        }

        await DispatchAsync(async () =>
        {
            if (!_recorder.IsCapturing)
            {
                await StartCaptureAsync(autoStarted: true);
            }
        }).ConfigureAwait(false);
    }

    private void OnMeetingLeft(object? sender, EventArgs e)
    {
        _ = HandleMeetingLeftAsync();
    }

    private async Task HandleMeetingLeftAsync()
    {
        if (!_autoStartedCapture || !_recorder.IsCapturing)
        {
            return;
        }

        await DispatchAsync(async () =>
        {
            if (_autoStartedCapture && _recorder.IsCapturing)
            {
                await StopCaptureAsync();
            }
        }).ConfigureAwait(false);
    }

    private async Task ExitAsync()
    {
        if (_recorder.IsCapturing)
        {
            await StopCaptureAsync().ConfigureAwait(false);
        }

        Dispatch(() =>
        {
            _reallyClose = true;
            System.Windows.Application.Current.Shutdown();
        });
    }

    private void ToggleAuthPanels(bool signedIn)
    {
        LoginPanel.Visibility = signedIn ? Visibility.Collapsed : Visibility.Visible;
        AccountPanel.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        StartButton.IsEnabled = signedIn && !_recorder.IsCapturing;
    }

    private void SetAccount(string? email)
    {
        var display = string.IsNullOrWhiteSpace(email) ? "Sesión iniciada" : email;
        AccountEmailText.Text = display;
        AvatarText.Text = Initials(display);
    }

    private void SetCaptureUi(bool capturing)
    {
        StartButton.Visibility = capturing ? Visibility.Collapsed : Visibility.Visible;
        CapturingPanel.Visibility = capturing ? Visibility.Visible : Visibility.Collapsed;
        OpenLiveButton.IsEnabled = !string.IsNullOrWhiteSpace(_recorder.LiveUrl());
        StartButton.IsEnabled = !capturing && !string.IsNullOrWhiteSpace(_signedEmail);

        HeaderStatusDot.Fill = capturing
            ? (System.Windows.Media.Brush)FindResource("OkBrush")
            : (System.Windows.Media.Brush)FindResource("SubtleBrush");

        if (capturing)
        {
            _captureStartedAt ??= DateTimeOffset.Now;
            _elapsedTimer.Start();
            RefreshElapsed();
        }
        else
        {
            _elapsedTimer.Stop();
            _captureStartedAt = null;
            ElapsedText.Text = "00:00";
        }
    }

    private void AddCaptionRow(CaptionEvent caption)
    {
        if (_activityRows.Count == 1 && _activityRows[0].Url is null && _activityRows[0].Title.StartsWith("Esperando", StringComparison.OrdinalIgnoreCase))
        {
            _activityRows.Clear();
        }

        var speaker = string.IsNullOrWhiteSpace(caption.SpeakerName) ? "Teams" : caption.SpeakerName;
        _activityRows.Insert(0, new ActivityRow($"{speaker}: {caption.Text}", FormatElapsed(caption.T), null));
        while (_activityRows.Count > 80)
        {
            _activityRows.RemoveAt(_activityRows.Count - 1);
        }
    }

    private void RefreshElapsed()
    {
        if (_captureStartedAt is null)
        {
            ElapsedText.Text = "00:00";
            return;
        }

        var elapsed = DateTimeOffset.Now - _captureStartedAt.Value;
        ElapsedText.Text = elapsed.TotalHours >= 1
            ? elapsed.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture)
            : elapsed.ToString(@"mm\:ss", CultureInfo.InvariantCulture);
    }

    private void OpenLive()
    {
        var url = _recorder.LiveUrl();
        if (!string.IsNullOrWhiteSpace(url))
        {
            OpenUrl(url);
        }
    }

    private void ActivityList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (ActivityList.SelectedItem is ActivityRow { Url.Length: > 0 } row)
        {
            OpenUrl(row.Url);
        }
    }

    private static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // The UI status already keeps the main workflow visible; browser failures are non-fatal.
        }
    }

    private void ShowWindow()
    {
        Dispatch(() =>
        {
            Show();
            WindowState = WindowState.Normal;
            Activate();
        });
    }

    private void SetStatus(string message)
    {
        StatusText.Text = string.IsNullOrWhiteSpace(message) ? "Listo." : message;
    }

    private void RefreshPlaceholders()
    {
        EmailPlaceholder.Visibility = string.IsNullOrWhiteSpace(EmailBox.Text) && !EmailBox.IsKeyboardFocusWithin
            ? Visibility.Visible
            : Visibility.Collapsed;
        PasswordPlaceholder.Visibility = string.IsNullOrEmpty(PasswordBox.Password) && !PasswordBox.IsKeyboardFocusWithin
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void Dispatch(Action action)
    {
        if (Dispatcher.CheckAccess())
        {
            action();
            return;
        }

        Dispatcher.Invoke(action);
    }

    private Task DispatchAsync(Func<Task> action)
    {
        if (Dispatcher.CheckAccess())
        {
            return action();
        }

        return Dispatcher.InvokeAsync(action).Task.Unwrap();
    }

    private static string Initials(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "--";
        }

        var name = value.Split('@')[0];
        var parts = name.Split(new[] { '.', '_', '-', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2)
        {
            return string.Concat(parts[0][0], parts[1][0]).ToUpperInvariant();
        }

        return name.Length >= 2
            ? name[..2].ToUpperInvariant()
            : name[..1].ToUpperInvariant();
    }

    private static string FormatMeetingTime(string value)
    {
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
        {
            return "";
        }

        return parsed.ToLocalTime().ToString("d MMM, HH:mm", CultureInfo.CurrentCulture);
    }

    private static string FormatElapsed(double seconds)
    {
        if (seconds < 0)
        {
            return "";
        }

        var elapsed = TimeSpan.FromSeconds(seconds);
        return elapsed.TotalHours >= 1
            ? elapsed.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture)
            : elapsed.ToString(@"mm\:ss", CultureInfo.InvariantCulture);
    }

    public sealed record ActivityRow(string Title, string Meta, string? Url);
}
