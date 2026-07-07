using System.Text.Json.Serialization;

namespace Minutas.Desktop.Models;

public sealed record CaptionEvent(
    [property: JsonPropertyName("t")] double T,
    [property: JsonPropertyName("speakerName")] string SpeakerName,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("final")] bool Final = true);

public sealed record CaptionSegment(
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("speakerLabel")] string SpeakerLabel,
    [property: JsonPropertyName("startTime")] double StartTime,
    [property: JsonPropertyName("endTime")] double EndTime,
    [property: JsonPropertyName("text")] string Text);

public sealed record SignalHealth(
    [property: JsonPropertyName("captionsSeen")] bool CaptionsSeen,
    [property: JsonPropertyName("speakerRingSeen")] bool SpeakerRingSeen,
    [property: JsonPropertyName("domReadCount")] int DomReadCount,
    [property: JsonPropertyName("asrMode")] string AsrMode,
    [property: JsonPropertyName("crossCheckActive")] bool CrossCheckActive = false);

public sealed record MeetingRegistrationRequest(
    [property: JsonPropertyName("captureId")] string CaptureId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("startedAt")] string StartedAt);

public sealed record MeetingRegistrationResponse(
    [property: JsonPropertyName("meetingId")] string? MeetingId);

public sealed record MeetingsListResponse(
    [property: JsonPropertyName("meetings")] IReadOnlyList<MeetingSummary> Meetings);

public sealed record MeetingSummary(
    [property: JsonPropertyName("meetingId")] string MeetingId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("startedAt")] string StartedAt);

public sealed record SegmentsRequest(
    [property: JsonPropertyName("seq")] int Seq,
    [property: JsonPropertyName("segments")] IReadOnlyList<CaptionSegment> Segments,
    [property: JsonPropertyName("captionTimeline")] IReadOnlyList<CaptionEvent>? CaptionTimeline,
    [property: JsonPropertyName("signalHealth")] SignalHealth? SignalHealth);

public sealed record FinalizeRequest(
    [property: JsonPropertyName("captureId")] string CaptureId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("startedAt")] string StartedAt,
    [property: JsonPropertyName("endedAt")] string EndedAt,
    [property: JsonPropertyName("localUserName")] string LocalUserName,
    [property: JsonPropertyName("segments")] IReadOnlyList<CaptionSegment> Segments,
    [property: JsonPropertyName("speakerTimeline")] IReadOnlyList<object> SpeakerTimeline,
    [property: JsonPropertyName("captionTimeline")] IReadOnlyList<CaptionEvent> CaptionTimeline,
    [property: JsonPropertyName("participantNames")] IReadOnlyList<string> ParticipantNames,
    [property: JsonPropertyName("signalHealth")] SignalHealth SignalHealth,
    [property: JsonPropertyName("audioConsent")] AudioConsent AudioConsent);

public sealed record AudioConsent(
    [property: JsonPropertyName("tier")] int Tier,
    [property: JsonPropertyName("grantedAt")] string GrantedAt);

public sealed record FinalizeResponse(
    [property: JsonPropertyName("meetingId")] string? MeetingId,
    [property: JsonPropertyName("error")] string? Error);

public sealed record CaptionObservation(
    double ElapsedSeconds,
    string Speaker,
    string Text,
    bool? IsOffscreen,
    string WindowName);
