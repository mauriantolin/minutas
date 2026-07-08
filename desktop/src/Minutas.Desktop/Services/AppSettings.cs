namespace Minutas.Desktop.Services;

public sealed record AppSettings
{
    public static AppSettings Default { get; } = new();

    public string Region { get; init; } = "us-east-1";
    public string ApiBaseUrl { get; init; } = "https://rv3wzr5llg.execute-api.us-east-1.amazonaws.com";
    public string DashboardUrl { get; init; } = "https://d50200vgx8fgw.cloudfront.net";
    public string UserPoolId { get; init; } = "us-east-1_8iPeU4V78";
    public string UserPoolClientId { get; init; } = "18m3lcii9uq8qd3k3f59kplgns";
    public TimeSpan CaptionStableDelay { get; init; } = TimeSpan.FromSeconds(2);
    public TimeSpan CaptionPollInterval { get; init; } = TimeSpan.FromMilliseconds(750);
    public TimeSpan SegmentFlushInterval { get; init; } = TimeSpan.FromSeconds(5);
    public int SegmentFlushMax { get; init; } = 20;
    public bool AutoCapture { get; init; } = true;
    public string WindowTitlePattern { get; init; } = @"(\| Microsoft Teams$|^Microsoft Teams$|Teams$)";
}
