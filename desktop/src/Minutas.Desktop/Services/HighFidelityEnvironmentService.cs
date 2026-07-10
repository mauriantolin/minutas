namespace Minutas.Desktop.Services;

/// <summary>
/// Persiste el flag de accesibilidad del renderer como variable de entorno de USUARIO
/// (HKCU\Environment). Asi CUALQUIER arranque posterior de Teams — incluido el autostart de Windows —
/// la hereda y expone los subtitulos como nodos UIA discretos, sin que el usuario tenga que reiniciar
/// Teams a mano. Es la respuesta a la objecion del modelo anterior: la calidad de captura ya no
/// depende de una precondicion manual que el usuario no va a mantener ni a notar cuando falle.
///
/// Contrapartida: la variable es de usuario, asi que la heredan TODAS las apps WebView2 (Teams v2,
/// nuevo Outlook, Widgets, complementos de Office — no Electron). Solo fuerza el arbol de
/// accesibilidad; no rompe funcionalidad. Reversible: <see cref="Disable"/> la quita. .NET envia
/// WM_SETTINGCHANGE al escribir con target User, asi que los procesos NUEVOS la ven sin reiniciar la
/// sesion (Teams necesita reabrirse una vez para tomarla).
/// </summary>
public sealed class HighFidelityEnvironmentService
{
    private const string Variable = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    private const string Flag = "--force-renderer-accessibility=complete";

    public bool IsEnabled() => Read().Contains(Flag, StringComparison.OrdinalIgnoreCase);

    public void Enable()
    {
        var current = Read();
        if (current.Contains(Flag, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var next = string.IsNullOrWhiteSpace(current) ? Flag : $"{current.Trim()} {Flag}";
        Environment.SetEnvironmentVariable(Variable, next, EnvironmentVariableTarget.User);
    }

    public void Disable()
    {
        var current = Read();
        if (!current.Contains(Flag, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        // Quita SOLO nuestro flag; respeta cualquier otro argumento que el usuario ya tuviera puesto.
        var remaining = string.Join(
            ' ',
            current.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(part => !part.Equals(Flag, StringComparison.OrdinalIgnoreCase)));

        Environment.SetEnvironmentVariable(
            Variable,
            remaining.Length == 0 ? null : remaining,
            EnvironmentVariableTarget.User);
    }

    private static string Read()
    {
        try
        {
            return Environment.GetEnvironmentVariable(Variable, EnvironmentVariableTarget.User) ?? "";
        }
        catch
        {
            return "";
        }
    }
}
