using Minutas.Desktop.Services;
using Minutas.Desktop.UI;

namespace Minutas.Desktop;

internal static class Program
{
    private const string MinimizedArgument = "--minimized";

    [STAThread]
    private static void Main(string[] args)
    {
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
}
