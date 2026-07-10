using System.Windows;
using Microsoft.Win32;

namespace Minutas.Desktop.Services;

// Adaptive light/dark theming: reads the Windows "apps" theme preference and swaps the merged
// resource dictionary at runtime. Theming must never crash the app, so everything is guarded.
public static class ThemeManager
{
    private const string DarkThemeUri = "pack://application:,,,/UI/Theme.Dark.xaml";
    private const string LightThemeUri = "pack://application:,,,/UI/Theme.Light.xaml";
    private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    private static System.Windows.Application? _app;

    public static void Apply(System.Windows.Application app)
    {
        _app = app;
        ApplyCurrent();

        try
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
            SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        }
        catch
        {
            // If we cannot subscribe to system events, the initial theme still applies.
        }
    }

    private static bool? _appliedLight;

    private static void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category != UserPreferenceCategory.General)
        {
            return;
        }

        try
        {
            // Async + no-op guard: a "General" broadcast also fires for unrelated changes
            // (e.g. setting a user env var when toggling high fidelity). Rebuilding the
            // whole resource dictionary there froze the UI, so only touch it when the OS
            // theme actually flipped, and never block the toggling thread.
            _app?.Dispatcher.BeginInvoke(new Action(ApplyCurrent));
        }
        catch
        {
        }
    }

    private static void ApplyCurrent()
    {
        var app = _app;
        if (app is null)
        {
            return;
        }

        try
        {
            var light = IsLightTheme();
            if (_appliedLight == light)
            {
                return;
            }

            var uri = new Uri(light ? LightThemeUri : DarkThemeUri, UriKind.Absolute);
            var dictionary = new ResourceDictionary { Source = uri };
            app.Resources.MergedDictionaries.Clear();
            app.Resources.MergedDictionaries.Add(dictionary);
            _appliedLight = light;
        }
        catch
        {
        }
    }

    private static bool IsLightTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey, writable: false);
            return key?.GetValue("AppsUseLightTheme") is int value && value == 1;
        }
        catch
        {
            return false;
        }
    }
}
