using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Minutas.Desktop.Models;

namespace Minutas.Desktop.Services;

public sealed class MeetingsApiClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private readonly AppSettings _settings;
    private readonly CognitoAuthClient _auth;
    private readonly HttpClient _http;

    public MeetingsApiClient(AppSettings settings, CognitoAuthClient auth, HttpClient http)
    {
        _settings = settings;
        _auth = auth;
        _http = http;
    }

    public async Task<string?> RegisterMeetingAsync(MeetingRegistrationRequest body, CancellationToken cancellationToken)
    {
        var response = await PostAsync("/meetings", body, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var parsed = await response.Content.ReadFromJsonAsync<MeetingRegistrationResponse>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return parsed?.MeetingId;
    }

    public async Task<IReadOnlyList<MeetingSummary>> GetRecentMeetingsAsync(CancellationToken cancellationToken)
    {
        var token = await _auth.GetIdTokenAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Not signed in.");

        using var request = new HttpRequestMessage(HttpMethod.Get, $"{_settings.ApiBaseUrl}/meetings");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return Array.Empty<MeetingSummary>();
        }

        var parsed = await response.Content.ReadFromJsonAsync<MeetingsListResponse>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return parsed?.Meetings ?? Array.Empty<MeetingSummary>();
    }

    public async Task<bool> SendSegmentsAsync(string meetingId, SegmentsRequest body, CancellationToken cancellationToken)
    {
        var response = await PostAsync($"/meetings/{Uri.EscapeDataString(meetingId)}/segments", body, cancellationToken).ConfigureAwait(false);
        return response.IsSuccessStatusCode;
    }

    public async Task<FinalizeResponse> FinalizeMeetingAsync(string meetingId, FinalizeRequest body, CancellationToken cancellationToken)
    {
        var response = await PostAsync($"/meetings/{Uri.EscapeDataString(meetingId)}/finalize", body, cancellationToken).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            return new FinalizeResponse(meetingId, $"Finalize failed ({(int)response.StatusCode}): {text}");
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            return new FinalizeResponse(meetingId, null);
        }

        return JsonSerializer.Deserialize<FinalizeResponse>(text, JsonOptions) ?? new FinalizeResponse(meetingId, null);
    }

    public string LiveUrl(string meetingId) => $"{_settings.DashboardUrl}/live?id={Uri.EscapeDataString(meetingId)}";

    public string MeetingUrl(string meetingId) => $"{_settings.DashboardUrl}/meeting?id={Uri.EscapeDataString(meetingId)}";

    private async Task<HttpResponseMessage> PostAsync<T>(string path, T body, CancellationToken cancellationToken)
    {
        var token = await _auth.GetIdTokenAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Not signed in.");

        var request = new HttpRequestMessage(HttpMethod.Post, $"{_settings.ApiBaseUrl}{path}")
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        return await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
