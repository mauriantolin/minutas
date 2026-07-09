using Minutas.Desktop.Services;
using Minutas.Desktop.UI;
using Velopack;

namespace Minutas.Desktop;

internal static class Program
{
    private const string MinimizedArgument = "--minimized";

    // Velopack update feed, served from the dashboard bucket/CloudFront under /desktop.
    private const string UpdateFeedUrl = "https://d50200vgx8fgw.cloudfront.net/desktop";

    [STAThread]
    private static void Main(string[] args)
    {
        // Must run before anything else: handles install/update/uninstall hooks.
        VelopackApp.Build().Run();

        StartUpdateCheck();

        var settings = AppSettings.Default;
        var appData = AppPaths.Create();
        var tokenStore = new TokenStore(appData);
        using var httpClient = new HttpClient();
        var auth = new CognitoAuthClient(settings, tokenStore, httpClient);
        var api = new MeetingsApiClient(settings, auth, httpClient);
        var captions = new TeamsCaptionWatcher(settings);
        var recorder = new CaptureSessionService(settings, appData, api, captions);
        var startup = new WindowsStartupService();
        var preferences = new DesktopPreferencesService(appData);
        var presence = new MeetingPresenceWatcher(captions);
        var startMinimized = args.Any(arg => string.Equals(arg, MinimizedArgument, StringComparison.OrdinalIgnoreCase));

        var app = new System.Windows.Application
        {
            ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown
        };

        var window = new MainWindow(settings, auth, api, recorder, startup, preferences, presence);
        app.MainWindow = window;
        app.Startup += async (_, _) => await window.InitializeAsync();
        if (!startMinimized)
        {
            window.Show();
        }

        app.Run();
    }

    // Downloads updates in the background and applies them on exit, so an update
    // never interrupts a live meeting. Network failures are swallowed so a bad
    // feed can never block startup.
    private static void StartUpdateCheck()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var mgr = new UpdateManager(UpdateFeedUrl);
                if (!mgr.IsInstalled)
                {
                    return;
                }

                var updates = await mgr.CheckForUpdatesAsync();
                if (updates is null)
                {
                    return;
                }

                await mgr.DownloadUpdatesAsync(updates);
                mgr.WaitExitThenApplyUpdates(updates);
            }
            catch
            {
                // Ignore: updates are best-effort and must not affect the running app.
            }
        });
    }
}
