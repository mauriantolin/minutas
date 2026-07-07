using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Minutas.Desktop.Services;

public sealed class TokenStore
{
    private readonly string _path;

    public TokenStore(AppPaths paths)
    {
        _path = Path.Combine(paths.Root, "auth.dat");
    }

    public async Task SaveAsync(AuthTokens tokens, CancellationToken cancellationToken = default)
    {
        var json = JsonSerializer.Serialize(tokens);
        var bytes = Encoding.UTF8.GetBytes(json);
        var protectedBytes = Dpapi.Protect(bytes);
        await File.WriteAllBytesAsync(_path, protectedBytes, cancellationToken);
    }

    public async Task<AuthTokens?> ReadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        try
        {
            var protectedBytes = await File.ReadAllBytesAsync(_path, cancellationToken);
            var bytes = Dpapi.Unprotect(protectedBytes);
            return JsonSerializer.Deserialize<AuthTokens>(Encoding.UTF8.GetString(bytes));
        }
        catch
        {
            return null;
        }
    }

    public void Clear()
    {
        if (File.Exists(_path))
        {
            File.Delete(_path);
        }
    }
}

public sealed record AuthTokens(string IdToken, string RefreshToken);

internal static class Dpapi
{
    private const int CryptProtectUiForbidden = 0x1;

    public static byte[] Protect(byte[] data)
    {
        return Transform(data, protect: true);
    }

    public static byte[] Unprotect(byte[] data)
    {
        return Transform(data, protect: false);
    }

    private static byte[] Transform(byte[] data, bool protect)
    {
        var input = ToBlob(data);
        var output = new DataBlob();

        try
        {
            var ok = protect
                ? CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, ref output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, ref output);

            if (!ok)
            {
                throw new InvalidOperationException($"DPAPI failed with Win32 error {Marshal.GetLastWin32Error()}.");
            }

            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        }
        finally
        {
            if (input.pbData != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(input.pbData);
            }

            if (output.pbData != IntPtr.Zero)
            {
                LocalFree(output.pbData);
            }
        }
    }

    private static DataBlob ToBlob(byte[] data)
    {
        var blob = new DataBlob
        {
            cbData = data.Length,
            pbData = Marshal.AllocHGlobal(data.Length)
        };
        Marshal.Copy(data, 0, blob.pbData, data.Length);
        return blob;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(
        ref DataBlob pDataIn,
        string? szDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        int dwFlags,
        ref DataBlob pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(
        ref DataBlob pDataIn,
        IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        int dwFlags,
        ref DataBlob pDataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);
}
