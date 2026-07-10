using System.Reflection;
using Velopack;

namespace Minutas.Desktop.Services;

public enum UpdateOutcome
{
    UpToDate,
    Downloaded,
    NotInstalled,
    Failed,
}

public sealed record UpdateCheckResult(UpdateOutcome Outcome, string? Version = null, string? Message = null);

/// <summary>
/// Version actual y actualizacion manual sobre el mismo feed Velopack que usa el chequeo
/// automatico de <see cref="Program"/>. Fuera de una instalacion Velopack (correr desde bin/)
/// no hay nada que actualizar y se reporta NotInstalled.
/// </summary>
public sealed class DesktopUpdateService
{
    private const string UpdateFeedUrl = "https://d50200vgx8fgw.cloudfront.net/desktop";

    private readonly UpdateManager _manager = new(UpdateFeedUrl);

    /// <summary>Version instalada (Velopack) o, en dev, la del ensamblado.</summary>
    public string CurrentVersion
    {
        get
        {
            var velopack = _manager.IsInstalled ? _manager.CurrentVersion?.ToString() : null;
            if (!string.IsNullOrWhiteSpace(velopack))
            {
                return velopack;
            }

            var assembly = Assembly.GetExecutingAssembly().GetName().Version;
            return assembly is null ? "desconocida" : $"{assembly.Major}.{assembly.Minor}.{assembly.Build}";
        }
    }

    public bool IsInstalled => _manager.IsInstalled;

    /// <summary>Busca y descarga una actualizacion. No reinicia; eso lo decide el usuario.</summary>
    public async Task<UpdateCheckResult> CheckAndDownloadAsync()
    {
        if (!_manager.IsInstalled)
        {
            return new UpdateCheckResult(UpdateOutcome.NotInstalled);
        }

        try
        {
            var updates = await _manager.CheckForUpdatesAsync().ConfigureAwait(false);
            if (updates is null)
            {
                return new UpdateCheckResult(UpdateOutcome.UpToDate, CurrentVersion);
            }

            await _manager.DownloadUpdatesAsync(updates).ConfigureAwait(false);
            _pending = updates;
            return new UpdateCheckResult(UpdateOutcome.Downloaded, updates.TargetFullRelease.Version.ToString());
        }
        catch (Exception ex)
        {
            return new UpdateCheckResult(UpdateOutcome.Failed, Message: ex.Message);
        }
    }

    private UpdateInfo? _pending;

    /// <summary>Aplica la actualizacion ya descargada y reinicia la app.</summary>
    public void ApplyAndRestart()
    {
        if (_pending is not null)
        {
            _manager.ApplyUpdatesAndRestart(_pending);
        }
    }
}
