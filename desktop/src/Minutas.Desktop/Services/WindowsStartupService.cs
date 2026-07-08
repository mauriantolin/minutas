using Microsoft.Win32;

namespace Minutas.Desktop.Services;

public sealed class WindowsStartupService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Minutix Desktop";
    private const string MinimizedArgument = "--minimized";

    public bool IsEnabledForCurrentExecutable()
    {
        var value = ReadValue();
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var executable = CurrentExecutablePath();
        var configuredExecutable = ExtractExecutablePath(value);
        return string.Equals(configuredExecutable, executable, StringComparison.OrdinalIgnoreCase);
    }

    public void EnableForCurrentExecutable()
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new InvalidOperationException("Could not open the Windows startup registry key.");
        key.SetValue(ValueName, BuildStartupCommand(CurrentExecutablePath()), RegistryValueKind.String);
    }

    public void Disable()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    private static string? ReadValue()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(ValueName) as string;
    }

    private static string CurrentExecutablePath()
    {
        return Environment.ProcessPath
            ?? throw new InvalidOperationException("Could not determine the current executable path.");
    }

    private static string BuildStartupCommand(string executable)
    {
        return $"\"{executable}\" {MinimizedArgument}";
    }

    private static string? ExtractExecutablePath(string command)
    {
        var trimmed = command.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        if (trimmed[0] == '"')
        {
            var endQuote = trimmed.IndexOf('"', 1);
            return endQuote > 1 ? trimmed[1..endQuote] : null;
        }

        var firstSpace = trimmed.IndexOf(' ');
        return firstSpace > 0 ? trimmed[..firstSpace] : trimmed;
    }
}
