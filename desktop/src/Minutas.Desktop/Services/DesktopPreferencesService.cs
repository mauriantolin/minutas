using System.Text.Json;

namespace Minutas.Desktop.Services;

public sealed class DesktopPreferencesService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _filePath;

    public DesktopPreferencesService(AppPaths paths)
    {
        _filePath = Path.Combine(paths.Root, "preferences.json");
    }

    public async Task<DesktopPreferences> ReadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_filePath))
        {
            return DesktopPreferences.Default;
        }

        try
        {
            var json = await File.ReadAllTextAsync(_filePath, cancellationToken).ConfigureAwait(false);
            return JsonSerializer.Deserialize<DesktopPreferences>(json, JsonOptions)
                ?? DesktopPreferences.Default;
        }
        catch
        {
            return DesktopPreferences.Default;
        }
    }

    public async Task SetAutoCaptureMeetingsAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        var current = await ReadAsync(cancellationToken).ConfigureAwait(false);
        await SaveAsync(current with { AutoCaptureMeetings = enabled }, cancellationToken).ConfigureAwait(false);
    }

    public async Task SetAutoHighFidelityAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        var current = await ReadAsync(cancellationToken).ConfigureAwait(false);
        await SaveAsync(current with { AutoHighFidelity = enabled }, cancellationToken).ConfigureAwait(false);
    }

    private async Task SaveAsync(DesktopPreferences preferences, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        var json = JsonSerializer.Serialize(preferences, JsonOptions);
        await File.WriteAllTextAsync(_filePath, json, cancellationToken).ConfigureAwait(false);
    }
}

public sealed record DesktopPreferences(bool AutoCaptureMeetings, bool AutoHighFidelity = true)
{
    public static DesktopPreferences Default { get; } = new(AutoCaptureMeetings: true, AutoHighFidelity: true);
}
