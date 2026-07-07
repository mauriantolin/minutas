using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Minutas.Desktop.Services;

public sealed class CognitoAuthClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly AppSettings _settings;
    private readonly TokenStore _tokenStore;
    private readonly HttpClient _http;

    public CognitoAuthClient(AppSettings settings, TokenStore tokenStore, HttpClient http)
    {
        _settings = settings;
        _tokenStore = tokenStore;
        _http = http;
    }

    public async Task<bool> HasSessionAsync(CancellationToken cancellationToken = default)
    {
        var token = await GetIdTokenAsync(cancellationToken).ConfigureAwait(false);
        return !string.IsNullOrWhiteSpace(token);
    }

    public async Task<string?> GetSessionEmailAsync(CancellationToken cancellationToken = default)
    {
        var token = await GetIdTokenAsync(cancellationToken).ConfigureAwait(false);
        return TryReadClaim(token, "email");
    }

    public async Task<AuthTokens> SignInAsync(string email, string password, CancellationToken cancellationToken = default)
    {
        var response = await InitiateAuthAsync(
            "USER_PASSWORD_AUTH",
            new Dictionary<string, string>
            {
                ["USERNAME"] = email,
                ["PASSWORD"] = password
            },
            cancellationToken).ConfigureAwait(false);

        var result = response.AuthenticationResult
            ?? throw new InvalidOperationException("Cognito did not return tokens.");

        if (string.IsNullOrWhiteSpace(result.IdToken) || string.IsNullOrWhiteSpace(result.RefreshToken))
        {
            throw new InvalidOperationException("Cognito response is missing tokens.");
        }

        var tokens = new AuthTokens(result.IdToken, result.RefreshToken);
        await _tokenStore.SaveAsync(tokens, cancellationToken).ConfigureAwait(false);
        return tokens;
    }

    public async Task<string?> GetIdTokenAsync(CancellationToken cancellationToken = default)
    {
        var tokens = await _tokenStore.ReadAsync(cancellationToken).ConfigureAwait(false);
        if (tokens is null)
        {
            return null;
        }

        if (TokenUsable(tokens.IdToken))
        {
            return tokens.IdToken;
        }

        if (string.IsNullOrWhiteSpace(tokens.RefreshToken))
        {
            return null;
        }

        var refreshed = await RefreshAsync(tokens.RefreshToken, cancellationToken).ConfigureAwait(false);
        return refreshed?.IdToken;
    }

    public void SignOut() => _tokenStore.Clear();

    private async Task<AuthTokens?> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        var response = await InitiateAuthAsync(
            "REFRESH_TOKEN_AUTH",
            new Dictionary<string, string>
            {
                ["REFRESH_TOKEN"] = refreshToken
            },
            cancellationToken).ConfigureAwait(false);

        var idToken = response.AuthenticationResult?.IdToken;
        if (string.IsNullOrWhiteSpace(idToken))
        {
            return null;
        }

        var tokens = new AuthTokens(idToken, refreshToken);
        await _tokenStore.SaveAsync(tokens, cancellationToken).ConfigureAwait(false);
        return tokens;
    }

    private async Task<CognitoAuthResponse> InitiateAuthAsync(
        string authFlow,
        Dictionary<string, string> authParameters,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"https://cognito-idp.{_settings.Region}.amazonaws.com/");
        request.Headers.TryAddWithoutValidation("x-amz-target", "AWSCognitoIdentityProviderService.InitiateAuth");
        request.Content = JsonContent.Create(
            new CognitoAuthRequest(authFlow, _settings.UserPoolClientId, authParameters),
            options: JsonOptions);
        request.Content.Headers.ContentType!.MediaType = "application/x-amz-json-1.1";

        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Cognito auth failed ({(int)response.StatusCode}): {body}");
        }

        return JsonSerializer.Deserialize<CognitoAuthResponse>(body, JsonOptions)
            ?? throw new InvalidOperationException("Could not parse Cognito auth response.");
    }

    private static bool TokenUsable(string? jwt)
    {
        if (string.IsNullOrWhiteSpace(jwt))
        {
            return false;
        }

        try
        {
            var parts = jwt.Split('.');
            if (parts.Length < 2)
            {
                return false;
            }

            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            var json = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(payload));
            var exp = json.GetProperty("exp").GetInt64();
            var expiresAt = DateTimeOffset.FromUnixTimeSeconds(exp);
            return expiresAt - TimeSpan.FromMinutes(1) > DateTimeOffset.UtcNow;
        }
        catch
        {
            return false;
        }
    }

    private static string? TryReadClaim(string? jwt, string claim)
    {
        if (string.IsNullOrWhiteSpace(jwt))
        {
            return null;
        }

        try
        {
            var json = ReadJwtPayload(jwt);
            return json.TryGetProperty(claim, out var value) ? value.GetString() : null;
        }
        catch
        {
            return null;
        }
    }

    private static JsonElement ReadJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2)
        {
            throw new InvalidOperationException("Invalid JWT.");
        }

        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
        return JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(payload));
    }

    private sealed record CognitoAuthRequest(
        [property: JsonPropertyName("AuthFlow")] string AuthFlow,
        [property: JsonPropertyName("ClientId")] string ClientId,
        [property: JsonPropertyName("AuthParameters")] Dictionary<string, string> AuthParameters);

    private sealed record CognitoAuthResponse(
        [property: JsonPropertyName("AuthenticationResult")] CognitoAuthResult? AuthenticationResult);

    private sealed record CognitoAuthResult(
        [property: JsonPropertyName("IdToken")] string? IdToken,
        [property: JsonPropertyName("RefreshToken")] string? RefreshToken);
}
