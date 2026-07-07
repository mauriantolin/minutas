namespace Minutas.Desktop.Services;

public sealed record AppPaths(string Root, string Captures)
{
    public static AppPaths Create()
    {
        var root = Path.Combine(GetWritableBasePath(), "Minutix", "Desktop");
        var captures = Path.Combine(root, "captures");

        Directory.CreateDirectory(root);
        Directory.CreateDirectory(captures);

        return new AppPaths(root, captures);
    }

    private static string GetWritableBasePath()
    {
        foreach (var candidate in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Path.GetTempPath()
        })
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }

            try
            {
                var probe = Path.Combine(candidate, "Minutix", ".write-test");
                Directory.CreateDirectory(Path.GetDirectoryName(probe)!);
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return candidate;
            }
            catch
            {
            }
        }

        throw new UnauthorizedAccessException("No writable local storage path was found.");
    }
}
