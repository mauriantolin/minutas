using System.Diagnostics;
using System.IO;

namespace Minutas.Desktop.Services;

/// <summary>
/// Relanza Teams con el AXMode completo del renderer, para que los subtitulos aparezcan como
/// nodos UIA discretos (autor + texto) en vez de colapsados en un blob de texto plano.
///
/// El flag viaja por WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, que un proceso hijo hereda del padre.
/// Se setea SOLO en el entorno del proceso que lanzamos: no se persiste la variable de usuario, asi
/// que ninguna otra app WebView2 de la maquina (Widgets, Outlook, Office) se ve afectada.
/// Medido en Windows: sin variable persistida, los nodos de subtitulo aparecen igual.
///
/// Contrapartida: solo la instancia de Teams que abrimos nosotros tiene el flag. Si el usuario abre
/// Teams desde la bandeja o el arranque de Windows, el lector estructural no encuentra nodos y
/// TeamsCaptionWatcher cae al parser plano.
/// </summary>
public sealed class TeamsHighFidelityService
{
    private const string FlagVariable = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    private const string Flag = "--force-renderer-accessibility=complete";

    private static readonly string[] TeamsProcessNames = { "ms-teams", "msteams", "Teams" };

    public static bool IsTeamsRunning()
    {
        return TeamsProcessNames.Any(name => Process.GetProcessesByName(name).Length > 0);
    }

    /// <summary>Ruta del ejecutable de Teams, o null si no se encuentra.</summary>
    public static string? ResolveTeamsExecutable()
    {
        return ResolveFromAppxPackage() ?? ResolveClassicInstall();
    }

    /// <summary>Cierra Teams y lo vuelve a abrir con el flag. Devuelve el error, o null si salio bien.</summary>
    public async Task<string?> RelaunchAsync(CancellationToken cancellationToken = default)
    {
        var executable = ResolveTeamsExecutable();
        if (executable is null)
        {
            return "No se encontro el ejecutable de Teams.";
        }

        foreach (var name in TeamsProcessNames)
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
                catch
                {
                    // Ya murio, o es de otro usuario: seguimos con el resto.
                }
            }
        }

        await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);

        var startInfo = new ProcessStartInfo(executable)
        {
            // ShellExecute no permite pasar variables de entorno propias al hijo.
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable) ?? "",
        };
        startInfo.Environment[FlagVariable] = Flag;

        try
        {
            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            return $"No se pudo abrir Teams: {ex.Message}";
        }

        return null;
    }

    private static string? ResolveFromAppxPackage()
    {
        // WindowsApps no se puede enumerar sin permisos, pero Get-AppxPackage si resuelve la ruta.
        var startInfo = new ProcessStartInfo("powershell.exe")
        {
            Arguments = "-NoProfile -NonInteractive -Command \"(Get-AppxPackage -Name MSTeams).InstallLocation\"",
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        try
        {
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return null;
            }

            var directory = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit(10000);
            if (directory.Length == 0)
            {
                return null;
            }

            var executable = Path.Combine(directory, "ms-teams.exe");
            return File.Exists(executable) ? executable : null;
        }
        catch
        {
            return null;
        }
    }

    private static string? ResolveClassicInstall()
    {
        var executable = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "Teams", "current", "Teams.exe");
        return File.Exists(executable) ? executable : null;
    }
}
