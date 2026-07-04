// Deployed values for the ATOS sandbox (TeamsAgentCore stack, us-east-1).
// White-label: no client-specific identifiers here.
export const CONFIG = {
  region: "us-east-1",
  apiUrl: "https://rv3wzr5llg.execute-api.us-east-1.amazonaws.com",
  userPoolId: "us-east-1_8iPeU4V78",
  userPoolClientId: "18m3lcii9uq8qd3k3f59kplgns",
  identityPoolId: "us-east-1:846a80da-00b1-4db1-8ba5-206249505f29",
  transcribeLanguage: "es-US",
  sampleRate: 16000,
  // Gate 0 (M6) — CaptionsPrimaryConfig; OFF until telemetry proves caption uptime.
  captionsPrimaryEnabled: false,
  // Forced cross-check stream fraction; 1.0 until captions-mode P3 signals are validated.
  crossCheckFraction: 1.0,
  captionHeartbeatTimeoutSec: 20,
  pcmRingSeconds: 60,
  // M5 opt-in audio buffer (§7).
  audioTimesliceMs: 10_000,
  // Local OPFS retention for audio that was never uploaded/purged (tier-2 upload
  // failures, orphaned captures); mirrors the server-side 7-day hard cap.
  audioRetentionDays: 7,
} as const;
