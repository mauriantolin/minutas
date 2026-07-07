using Minutas.Desktop.Services;
using Minutas.Desktop.UI;

namespace Minutas.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        var settings = AppSettings.Default;
        var appData = AppPaths.Create();
        var tokenStore = new TokenStore(appData);
        using var httpClient = new HttpClient();
        var auth = new CognitoAuthClient(settings, tokenStore, httpClient);
        var api = new MeetingsApiClient(settings, auth, httpClient);
        var captions = new TeamsCaptionWatcher(settings);
        var recorder = new CaptureSessionService(settings, appData, api, captions);

        var app = new System.Windows.Application
        {
            ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown
        };

        app.Run(new MainWindow(settings, auth, api, recorder));
    }
}
