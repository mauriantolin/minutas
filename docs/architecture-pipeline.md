# Architecture: Phase-Gated Transcription & Summarization Pipeline

**Project:** teams-agent-core — self-hosted (AWS) meeting transcription, summaries, and Q&A for Microsoft Teams (browser extension, bot-free).
**Status:** Final design, synthesized from three judged proposals (spine: *phased-balanced*, winner 2-of-3 judges; grafts from *fidelity-first* and *cost-first* as itemized in §9), revised after adversarial review (idempotency, cache-prefix discipline, Gate-B audio race, task-token delivery, P4 invariant audit, rate-based Gate E, meeting-lifecycle API).

---

## 1. Overview & Design Principles

The current MVP does a single synchronous Bedrock call inside the ingest Lambda: one Haiku shot, no verification, fragile JSON parsing where a parse failure marks the meeting permanently `failed`, a meeting-global speaker-correlation heuristic with six documented misattribution modes, and three total-data-loss paths (offscreen document crash, stop-POST failure, parse failure). This design replaces that with an **asynchronous, phase-gated pipeline** where every phase emits a machine-readable quality score and expensive work dispatches only when a gate demands it.

**Design principles (normative — every future change is measured against these):**

1. **Gates are code, not model judgment.** Every escalation decision is a Step Functions `Choice` state reading a numeric score computed programmatically (fuzzy quote matching, vote margins, confidence averages). The model never decides its own budget — and never certifies its own output quality: model self-reports may only *escalate* a gate, never satisfy it.
2. **Cheap pass always, expensive pass only when proven necessary.** The draft summary is Haiku even though the goal is max fidelity — fidelity is guaranteed by the verification phase plus the escalation ladder, not by the draft model's size. Sonnet/Opus run only when a gate fires. Conversely: spend that buys zero fidelity (e.g., transcribing mic silence) is eliminated as early as possible, not parked behind telemetry it doesn't need.
3. **Free signals before paid signals.** Programmatic checks ($0) run before any token is spent: quote existence checks, correlation margins, caption↔ASR agreement, ASR confidence stats, invariant diffs (numbers/names/negations) on any LLM rewrite.
4. **Every artifact durable before the next phase runs.** Any failure leaves a resumable meeting, never lost work. Capture-side, the same rule applies twice: transcript segments checkpoint locally (IndexedDB) *and* stream to the backend incrementally, so a crashed offscreen document loses seconds, not the meeting.
5. **Unverified is a valid, visible result.** A summary that fails verification publishes as `needs_review`, never silently as truth and never as terminal `failed`.
6. **Boring AWS primitives.** Step Functions Standard + Lambda + S3 + DynamoDB. The state machine *is* the queue, the retry policy, and the audit log — no SQS/SNS/EventBridge in v1 (one EventBridge rule arrives with the batch re-ASR milestone, M5). Every write path is idempotent: client-minted capture ids, conditional puts, and SFN execution names derived from `meetingId` (deduped by AWS for 90 days), so retries can never duplicate a meeting or double-bill a pipeline run.
7. **All inference in-account.** Bedrock (Claude family) + Amazon Transcribe only. No third-party SaaS ASR/LLM ever — it breaks the white-label, self-hosted pitch.
8. **Telemetry before optimization — where telemetry is actually the missing input.** The captions-primary lever depends on caption reliability, so it ships as a **feature flag activated only after `signalHealth` telemetry proves caption uptime on real meetings** (Gate 0, §2.0, §9-D1). Levers that depend on nothing external (VAD mic-gating is a local energy check) ship immediately (M1).
9. **White-label everywhere.** No client or product names in code, prompts, comments, or config. Prompts are code.

---

## 2. Pipeline Phases

The spine is one **Step Functions Standard state machine (`MeetingPipeline`)**, started by the finalize Lambda after the transcript is durably persisted. All Bedrock calls go through **one worker Lambda** that receives `{tenantId, meetingId, phase, modelTier}` — a single choke point for retries, prompt caching, structured output, and the model-tier router (env vars `MODEL_HAIKU`, `MODEL_SONNET`, `MODEL_OPUS`).

### P0 — Capture (extension, live)

- **Dispatch:** user starts capture (popup). Capture start now also **registers the meeting server-side** (P1 start call): the meeting exists — with `status:"capturing"` — and is watchable live from second zero. (Auto-start on meeting detection is deliberately deferred; see M4.)
- **Services/signals:**
  1. **Transcribe Streaming** exactly as today (tab stream with diarization + mic stream = hard local-user identity; es-US, 16 kHz PCM, partial-results stabilization high). **New:** persist per-item Transcribe confidence into segments — currently discarded, and P3's gate needs it. **New (M1): VAD mic-gating** — a local energy-threshold/VAD check in the offscreen document pauses the mic stream during silence and resumes with a hard-labeled boundary. The mic stream otherwise bills $1.44/hr to transcribe mostly silence (~48% of the typical meeting bill) for zero fidelity gain; gating it requires no Teams-DOM signal and no telemetry.
  2. **Teams live-captions scrape (new, free):** `MutationObserver` adapter in the quarantined `teams-dom-adapter.ts` module capturing `{t, speakerName, text, final}` per utterance when captions are on. Native per-utterance speaker names — strictly better than the active-speaker ring, plus a free cross-check transcript. Captions must be captured **on-mutation** (Teams virtualizes and prunes old caption nodes). The popup **prompts the user to enable live captions** at capture start — caption coverage is the cheapest fidelity signal regardless of ASR mode.
  3. **Active-speaker timeline** (400 ms poll, edge-triggered) retained as fallback signal when captions are off.
  4. **Opt-in local audio buffer:** tee the raw `MediaStream` (48 kHz, *before* the AudioContext resample to 16 k) into `MediaRecorder` Opus (~0.24 MB/min/source) → OPFS in the offscreen document. Local by default; upload governed by the consent ladder (§7).
- **Capture-robustness fixes (all ~$0, all mandatory — losing a whole meeting is the worst WER possible):**
  - **Incremental local checkpointing** of `segments[]` and `captionTimeline[]` every N finalized results — into **IndexedDB (or OPFS) inside the offscreen document**. `chrome.storage.*` is **not** available to MV3 offscreen documents; any service-worker-side mirror is a secondary copy shipped via `chrome.runtime` messages (the SW may be suspended), never the primary sink.
  - **Incremental server checkpointing:** batched finalized segments POSTed to `POST /meetings/{id}/segments` (P1) — a second, off-machine copy that also powers the live view.
  - **Cognito credential refresh at ~50 min** — today the idToken captured at START expires at 60 min and meetings >1 h die mid-stream and fail the stop-POST.
  - **Finalize-POST retry with backoff + local payload persistence** — retries are safe because finalize is idempotent by `meetingId` (P1).
- **Gate signal produced:** `signalHealth {captionsSeen, speakerRingSeen, domReadCount, captionHeartbeatLastT}` in the payload — converts today's silent DOM-selector death into a measured signal.
- **Gate 0 (captions-primary ASR mode — feature-flagged, per-tenant, default OFF):** when enabled *and* the caption observer confirms finalized mutations flowing, Transcribe Streaming may be skipped (ASR = $0). Hard requirements for this mode, non-negotiable:
  - a **caption-heartbeat watchdog**: if caption mutations stop for N seconds mid-meeting, **re-arm Transcribe Streaming immediately** — Gate 0 is *reversible*, never a one-way door;
  - **the capture graph stays alive-but-idle**: in captions-primary mode the tab `MediaStream` + audio worklet keep running with a **rolling in-memory PCM ring buffer** (tens of seconds, RAM only, never persisted, independent of the audio-consent ladder). On watchdog re-arm, the ring is **flushed into the new Transcribe stream first** (streaming accepts faster-than-realtime backfill), so the caption-silence detection window is recovered, not lost. Without this, re-arm latency (getMediaStreamId → offscreen wiring → new WS) is an unrecoverable speech hole under the default Tier-0 consent;
  - the **cross-check tab stream forced ON** for a configurable fraction of meetings — and it stays **mandatory** until the replacement quality signals defined in P3 (captions mode) are validated against it. Meetings captured captions-only with no cross-check are flagged in `pipeline.scores` and default Gate C to the conservative tier;
  - activation only after `signalHealth` data across real meetings shows caption uptime above threshold.
  Until then, everything below runs with streaming as primary and captions as a correlation/cross-check signal. Note the structural losses in captions mode: no per-item ASR confidence, no word timestamps (`[T##]` anchors bind to caption utterance times), no batch-merge alignment.
- **Cost:** streaming $2.88/hr worst case (tab $1.44 + mic ≤$1.44 VAD-gated); captions/DOM $0; audio buffer $0 (local).

### P1 — Meeting Lifecycle API (start / segments / finalize; Lambda, synchronous)

Replaces the single-shot stop-POST. Three routes, all idempotent:

- **`POST /meetings` (start, at capture start):** the extension sends a client-minted **`captureId`** (UUID). Conditional put on `captureId` dedupes retries; the server mints `meetingId`, writes the meeting item with `status:"capturing"`, returns `{meetingId}`. The web live view polls `GET /meetings/{id}` while `capturing` (the UI's "live" state *is* `capturing` — no separate enum value exists).
- **`POST /meetings/{id}/segments`:** batched finalized segments every N finals — free server-side checkpointing and live-transcript serving. (Roadmap, not v1: this also unlocks live in-meeting Q&A/summary from the widget.)
- **`POST /meetings/{id}/finalize`:** idempotent by `meetingId`. Persists `raw-payload.json` (pre-correlation, enables re-correlation forever) + `transcript.json` to S3; flips `status:"processing"`. If consent Tier 2 is granted, the payload declares **`audioPending: true` + the expected audio keys**, and the **202 response carries presigned PUT URLs** for those keys — the backend signs, the extension uploads. (This is what makes the upload IAM-clean: the Cognito identity-pool AuthRole has no policy variable that can express `{tenantId}/{meetingId}/audio/*`, so extension-direct `s3:PutObject` is not scoped; presigned URLs sidestep principal-tag ABAC entirely.) Then `states:StartExecution` on `MeetingPipeline` with **execution `name` = `meetingId`** — SFN dedupes execution names for 90 days, so a retried finalize after a 5xx (or a network timeout whose first POST actually landed) can never create a duplicate meeting, duplicate S3 prefix, or double-billed execution. Return **202 immediately**. If the start call never landed (offline start), finalize upserts by `captureId`.
- No inline summarization ever again; the API Gateway 29 s timeout stops being a correctness concern. A failed `StartExecution` returns 5xx and the extension's retry path re-POSTs finalize — safe by idempotency, no SQS DLQ needed. Timeout drops 120 s → 15 s. **Cost:** ~$0.

### P2 — Speaker Correlation + Scoring (SFN Task → Lambda, programmatic)

- **Model/service:** none — `correlateSpeakers` v2, pure TypeScript in `packages/shared` (still runnable by extension and backend).
- **Logic:**
  1. **Stable segment ids:** P2 assigns each segment a stable `segId`, carried through every downstream rewrite (P4 clean turns record `sourceIds[]`; batch merge preserves ids by time alignment). All turn anchors `[T##]`, user edits, tags, and highlights key by id — never by array index, which every merge/reprocess renumbers.
  2. **Caption anchors first:** fuzzy text+time match caption entries ↔ Transcribe segments → hard per-segment name assignment with certainty (native names beat any heuristic).
  3. For unanchored segments: vote-tally as today, but **windowed per time-interval instead of meeting-global argmax** — a label is resolved per window, killing the label-recycling misattribution mode that caption anchors don't cover when captions are off.
  4. Emit **numeric confidence** replacing the lossy boolean `resolved`: per-label winner-vs-runner-up margin, per-segment overlap ratio, caption agreement %.
- **Output:** `transcript.labeled.json` + `scores.correlation = {labelMarginMin, unresolvedPct, captionAgreementPct}`.
- **Gate A (dispatches speaker repair in P4):** `unresolvedPct > 15%` OR `labelMarginMin < 0.3` OR (captions available AND agreement < 80%). Expected closed for ~80% of meetings. *Thresholds are initial guesses — calibrated per §8 risk 2.*
- **Cost:** $0. P2 is pure and free — which is why the batch-merge path in P3 loops back through it.

### P3 — ASR Quality Scoring (same Lambda invocation, programmatic)

- **Logic (streaming mode):** mean/p10 of per-item Transcribe confidence; garbled-token heuristics; if captions exist, rough WER between caption text and Transcribe text (free second opinion on ASR quality). Output: `scores.asr` — the **programmatic** input that drives Gate C.
- **Logic (captions-primary mode, `asrSource:"captions"`):** per-item confidence and word timestamps don't exist, so P3's signals are redefined explicitly rather than silently no-oping: caption-heartbeat continuity (gap histogram vs meeting duration), per-utterance length distribution vs corpus baseline (truncation/rewrite detector), and agreement stats against the forced-on cross-check stream when present. The cross-check stream remains mandatory (Gate 0) until these replacement signals are validated against it; captions-only meetings without a cross-check are flagged and Gate C defaults conservative.
- **Gate B (dispatches batch re-ASR):** requires consent Tier 2 (§7) AND (`asrScore` below threshold OR meeting flagged important). Because the audio upload races the pipeline (P2/P3 run in seconds; a 1-hour Opus upload from a browser uplink takes minutes), Gate B **never checks S3 opportunistically**: if finalize declared `audioPending`, the state machine enters a bounded **Wait/HeadObject poll loop** (e.g., 30 s interval, 20 min timeout) on the declared keys before evaluating Gate B. On timeout, the pipeline proceeds on streaming text and records `pipeline.audioTimeout` — never a silent skip of a consented re-ASR.
- **Batch job:** `StartTranscriptionJob` (Transcribe **Batch** — same engine and same $0.024/min, but full-context decoding = better WER and better diarization; batch is the *quality* pass at equal price), **on the tab source only**. Mic text from streaming is already speaker-known and high-confidence, and diarization on a mic-only file is pointless; batch-transcribing both sources would double the line to $2.88/hr for nothing.
- **Job wait (task-token callback, done right):** the Gate-B state is invoked with `.waitForTaskToken`. The Transcribe job-state EventBridge event carries **only the job name and status — no metadata channel exists for the token** — so before starting the job the worker persists `{batchJobName → taskToken}` on the meeting item (job name derived from `{tenantId}--{meetingId}--{attempt}`); the callback Lambda (EventBridge rule `TranscribeJobStateChange` → Lambda) looks the token up by job name and calls `SendTaskSuccess`/`SendTaskFailure`. The state carries `HeartbeatSeconds`/`TimeoutSeconds` (~2 h) so a lost event fails into retry/fallback instead of hanging the execution forever.
- **Merge + re-correlation:** merged transcript prefers batch text, aligned by time — then the merged transcript is **looped back through P2** before P4. Batch diarization emits its own segmentation and its own `spk_N` numbering; without re-anchoring against captions/timeline, the quality pass would *regress* speaker attribution. P2 is pure and $0, and `raw-payload.json` is durable, so this is just a state-machine edge.
- **Roadmap replacement (same phase interface):** self-hosted faster-whisper large-v3 on SageMaker Async / spot GPU (~$0.05–0.15/audio-hr, WER ~7–10% vs Transcribe's ~12–18%) once volume justifies the container. Never a 24/7 GPU; never third-party SaaS.
- **Expected trigger rate:** <10% of meetings, 0% until audio opt-in exists.
- **Cost:** $0 (scoring); +$1.44/hr (tab source) only when Gate B fires.

### P4 — Transcript Refinement (Bedrock **Haiku 4.5**, always runs)

- **Dispatch:** SFN Task → worker Lambda (`modelTier: haiku`).
- **Prompt contract:** "clean, don't paraphrase" — remove disfluencies, punctuate, merge consecutive same-speaker turns (clean turns carry stable ids + `sourceIds[]` back to P2 segments), insert chapter markers `## [mm:ss] Topic`; **preserve verbatim numbers, names, dates, amounts, and negations**.
- **If Gate A fired:** the same call also performs **speaker repair** — relabel only the low-margin segments using caption anchors and conversational cues; high-confidence segments are explicitly off-limits. (Keep the cleanup contract and the repair instructions in separate prompt sections so repair never licenses paraphrase.)
- **Invariant gate (programmatic, $0 — audits the rewrite the rest of the pipeline stands on):** P4 is a full LLM rewrite, and P7's fidelity guarantee is only as good as the text it verifies against — a flipped negation in P4 would be extracted with a quote that fuzzy-matches the *clean* transcript and certified SUPPORTED. So P4's output is diffed programmatically against the raw transcript: regex-extract numbers, dates, amounts, proper nouns, and negation tokens from raw vs clean; any loss/flip → one P4 re-run; a second mismatch → **P5–P7 ground against `transcript.labeled.json` (raw) instead of the clean text**, and the mismatch is recorded in `pipeline.scores`. Independently, Gate D and P7 quote-matching always fall back to the raw transcript on a clean-transcript miss.
- **Output:** `transcript.clean.json` — the **canonical artifact `GET /meetings/{id}` serves** and the **byte-stable cached prefix** for P5–P8 and Q&A. Self-reported `{qualityScore, garbledPct}` is emitted but is *not* a gate input on its own (see Gate C).
- **Cache-prefix discipline (mandatory — Bedrock's cache key hashes the entire prefix, tools → system → messages, byte-exact, up to the `cachePoint`):**
  - **One identical tool configuration across P5–P8 and Q&A** (the union of all phase tools/schemas; per-phase selection expressed in the post-breakpoint user block — `tool_choice` participates in the prefix too, so it must also be identical, hence selection lives in the prompt text, not the config).
  - **One identical (or empty) `system` block across all phases.** Per-phase instructions must **never** live in `system` — that makes every phase a full-price cache miss and silently triples P6/P7 input cost.
  - The transcript block + `cachePoint` come **first in the user turn**; all phase-specific instructions strictly **after** the breakpoint.
  - Hygiene: no timestamps/request IDs before the breakpoint; deterministic JSON serialization; Haiku's 4096-token minimum cacheable prefix (short meetings silently don't cache).
  - **Tests assert `usage.cache_read_input_tokens > 0` per phase** (P6, P7, repair loop) on meetings above the minimum — the cost model depends on it.
  (5-min TTL suffices for back-to-back phases; `cachePoint` block via Converse, or `cache_control` via the Bedrock SDK.)
- **Gate C (synthesis tier — programmatic, per principle 1):** driven by **`scores.asr` from P3** (mean/p10 confidence, caption-WER proxy; captions-mode signals in captions-primary meetings). The Haiku self-report `{qualityScore, garbledPct}` acts only as an additional **OR-trigger to escalate** (`synthTier = sonnet`), never as the sole pass condition — a small model confidently self-scoring garbled input as fine is exactly the uncalibrated signal this design bans.
- **Cost:** ~$0.057 (10.6k in / 9.2k out). *Deferred lever (§9-D2): edit-list variant cuts this to ~$0.02 but is not in v1.*

### P5 — Extraction (Haiku 4.5, structured output, always runs)

- **Dispatch:** SFN Task → worker Lambda. Strict json_schema (Bedrock structured output, or tool-forcing under Converse): `decisions[]`, `actionItems[{text, owner, dueDate|null, verbatimQuote, turnRef, inferred}]`, `openQuestions[]`, `keyNumbers[]`, `participants[]`. **Every item carries a verbatim quote + turn reference (stable segment id).** Owner/date only if explicit; inferred values flagged `inferred: true`. This kills the current `parseSummary` first-`{`-to-last-`}` fragility.
- **Gate D (programmatic, $0):** Lambda fuzzy-matches each `verbatimQuote` against the clean transcript, **falling back to the raw transcript on a miss** (so a P4 rewrite can't launder a quote); items whose quote exists in neither are dropped/flagged. Catches the dominant extraction-hallucination class without spending a token.
- **Cost:** ~$0.018 (9k cache-write ×1.25 + 0.8k in / 1.2k out).

### P6 — Synthesis (Haiku 4.5 by default; Sonnet if Gate C said so)

- **Dispatch:** SFN Task → worker Lambda. Inputs: cached clean transcript (0.1× read — asserted, see P4 discipline) + validated extraction JSON + chapters.
- **Output:** `summary-draft` where **every substantive claim carries a turn anchor `[T14]`** (stable ids) — cheap to generate, makes verification mechanical, and powers clickable "sources" in the dashboard (the web parses `[Tn]` into links; raw anchors never render as literal text).
- **Cost:** ~$0.008 (cache read / 1.0k out).

### P7 — Verification (Haiku 4.5, always runs — this is the fidelity guarantee)

- **Dispatch:** SFN Task → worker Lambda. Decompose the summary into atomic claims; per claim `SUPPORTED | PARTIAL | UNSUPPORTED` + supporting quote + turn ref. Quotes re-validated programmatically first (free, with raw-transcript fallback per P4/Gate D); the LLM judges only entailment — local classification, where Haiku is reliable. If the P4 invariant gate demoted grounding to raw, P7 verifies against raw.
- **Gate E (escalation ladder — all SFN `Choice` states, rate-based):** an absolute count is uncorrelated with quality across summary lengths (2 unsupported of 6 claims is garbage; 3 of 40 is excellent), so the gate reads `unsupportedRate = unsupported / claims` **plus an absolute floor on critical fields**:
  - **0 unsupported** → publish.
  - **`unsupportedRate ≤ 10%` AND no UNSUPPORTED on a critical field** (`keyNumbers`, `actionItems`, `decisions`) → **targeted repair**: Haiku mini-call regenerates only the flagged sentences with verifier feedback (~$0.006 on cache) → re-verify once.
  - **`unsupportedRate > 10%` OR any critical-field UNSUPPORTED OR 2nd failure** → **re-synthesize on Sonnet** (own cold cache) → re-verify.
  - **Persistent failure (rare)** → **Opus** final tier (~$0.09/pass at $5/$25 in+out per Mtok) → re-verify → if still failing, **publish with `needs_review`** — never silently terminal, never unverified-as-verified.
  - Both raw counts and the rate persist in `pipeline.scores.verification` for calibration (§8 risk 2).
- Per-state `Retry` with backoff covers Bedrock throttling; a top-level `Catch` → `SetFailed` Lambda writes `lastError` + `executionArn` to the meeting item.
- **Cost:** ~$0.011 typical (cache read / 1.5k out).

### P8 — Publish + Q&A Serving

- **Dispatch:** final SFN Task. Writes `summary.json`, `extraction.json`, `verification.json` to S3, **and writes the summary payload onto the DDB meeting item (`summary` attribute)** — the dashboard reads the summary from the meeting item today, and keeping that write (smallest diff) means `getMeeting` and the web API types are unchanged; S3 holds the full artifacts. Also updates: `status: ready` (or `needs_review`), `pipeline.phase: PUBLISHED`, tier used, all gate scores — the complete fidelity audit trail per meeting.
- **Q&A (`POST /meetings/{id}/ask`), restructured:**
  1. **Summary-first routing:** if the question is answerable from `extraction.json` + summary (cheap Haiku call over ~2k tokens, or direct field lookup), answer without ever shipping the transcript (~$0.003).
  2. Otherwise: `[clean transcript — cachePoint, ttl 1h on first question] + [question]`, under the same prefix discipline as P5–P8. First question ≈ **$0.02** (a 1 h-TTL cache write bills 2× input: 9k tok × 2 × $1/M ≈ $0.018, plus question/answer tokens); each subsequent ≈ **$0.001** (0.1× reads). Break-even at ~3 questions/hour.
  3. Answers must cite turn refs/timestamps (inherits the grounding contract; the web renders `[Tn]` as links).
  4. Roadmap (unlocked by the P1 segments route, not v1): live in-meeting Q&A over the partial transcript.
- **New route `POST /meetings/{id}/reprocess`:** restarts the state machine from any phase — every artifact is durable and every anchor is id-keyed, so retry is trivial and user edits survive. This closes the "parse failure = permanently failed meeting" hole.

---

## 3. Architecture Diagram

```
 BROWSER (extension)                                   AWS (in-account, us-east-1)
┌──────────────────────────────────┐
│ Teams tab                        │
│  ├─ tabCapture ──┐               │  PCM 16k (tab WS + VAD-gated mic WS)
│  ├─ mic (VAD) ───┼─ offscreen    ├─────────────────────► ┌──────────────────────┐
│  │               │  doc          │◄──────────────────────│ Transcribe Streaming │
│  │ [Gate 0 flag: captions-primary│  diarized segments    │ (Cognito Id-Pool)    │
│  │  graph alive-idle + RAM PCM   │                       └──────────────────────┘
│  │  ring buffer; heartbeat       │
│  │  watchdog → re-arm + backfill]│
│  ├─ captions CC ─ MutationObs    │──► captionTimeline (names!)
│  ├─ speaker ring ─ 400ms poll    │──► speakerTimeline
│  ├─ MediaRecorder Opus→OPFS      │    (opt-in audio, local)
│  └─ checkpoints: IndexedDB (offs)│    creds refresh @50min
└──────────────┬───────────────────┘
   POST /meetings  (start: captureId → meetingId, "capturing")
   POST /meetings/{id}/segments   (batched finals = server checkpoint + live view)
   POST /meetings/{id}/finalize   (idempotent; audioPending + keys)
               ▼                              opt-in audio: presigned PUT → tab.webm (SSE-KMS)
      ┌─────────────────┐  raw-payload + transcript   ┌────┐
      │ IngestFn (15s)  │────────────────────────────►│ S3 │◄────────────────────┐
      │ 202 + presigned │                             └────┘                     │
      └───────┬─────────┘                                                        │
              │ states:StartExecution (name = meetingId → 90-day dedupe)         │
              ▼                                                                  │
┌───────────────────────────── MeetingPipeline (SFN Standard) ─────────────────┐ │
│                                                                              │ │
│ P2 correlate + stable segIds ($0) ──► P3 ASR score ($0)                      │ │
│      │ Gate A (repair?)                │ Gate B: audioPending? Wait/HeadObj  │ │
│      │                                 │  poll (timeout→streaming text)      │ │
│      │                                 ├──► Transcribe Batch (tab only)      │ │
│      │                                 │    {jobName→taskToken} in DDB;      │ │
│      │                                 │    EventBridge job-state → cb λ     │ │
│      ▼                                 ▼    → lookup token → SendTaskSuccess │ │
│ P4 cleanup [Haiku] ◄─── merge ──► re-run P2 on merged ($0)                   │ │
│      │ invariant check ($0: numbers/names/negations raw↔clean)               │ │
│      │ Gate C (tier ← programmatic scores.asr; self-report = OR-escalate)    │ │
│ P5 extract [Haiku+schema] ── Gate D: quote fuzzy-check ($0, raw fallback)    │ │
│ P6 synthesize [Haiku|Sonnet]   (shared prefix: identical system+tools,       │ │
│ P7 verify [Haiku]               phase instructions after cachePoint)         │ │
│      │ Gate E: unsupportedRate ≤10% ∧ no critical-field miss                 │ │
│      │   0 → publish | repair → re-verify | Sonnet → Opus → needs_review     │ │
│ P8 publish ──► DDB (status, summary, pipeline.scores, tier) + S3 artifacts   │ │
│ Catch* ──► SetFailed (lastError, executionArn)                               │ │
└──────────────────────────────────────────────────────────────────────────────┘ │
              ▲                                                                  │
              │ POST /meetings/{id}/reprocess                                    │
   ┌──────────┴──────────┐  GET /meetings, /{id} (poll; live view while         │
   │ Web dashboard        │      "capturing"; segments carry segId + endTime)   │
   │ (Next.js static, CF) │  POST /{id}/ask ── summary-first → cached transcript┘
   └──────────────────────┘            [Bedrock: Haiku / Sonnet / Opus]
```

---

## 4. Data Model & Status Machine

### S3 — additive keys under the existing prefix `{tenantId}/{meetingId}/`

```
raw-payload.json        # pre-correlation MeetingIngestPayload (enables re-correlation forever)
transcript.json         # v1 labeled segments (back-compat, unchanged)
transcript.labeled.json # P2 output: stable segIds + endTime + caption anchors + windowed votes + numeric confidence
transcript.clean.json   # P4 output — CANONICAL artifact served by GET /meetings/{id};
                        #   clean turns carry stable ids + sourceIds[] back to P2 segments
extraction.json         # P5 validated structured extraction (quotes + segId turn refs)
summary.json            # published summary (turn-anchored by stable id)
verification.json       # claims + verdicts + quotes — fidelity audit trail
audio/tab.webm          # opt-in only (Tier 2), presigned PUT, SSE-KMS, lifecycle-deleted (§7)
audio/mic.webm          # optional; never batch-transcribed (Gate B uses tab only)
```

**Anchor/edit stability:** every segment/turn id assigned at P2 survives P4 merges, batch merges, and `/reprocess`. User edits, tags, highlights, and `[T##]` anchors key by id — index-keyed references are forbidden because every rewrite renumbers indices. Segments expose `endTime` (already stored) through `GET /meetings/{id}`, so talk-time is computed as Σ(endTime − startTime) per speaker, not from inter-segment deltas (which interleave two stream clocks and attribute silence to the previous speaker).

`deleteMeeting` switches to **prefix delete** (ListObjectsV2 + batch delete).

### DynamoDB — same single table, same MEETING item, new attributes (no GSI)

```
captureId: string            # client-minted idempotency key (start-call dedupe)
summary: {...}               # written by P8 — the dashboard reads it from the item (unchanged contract)
audioPending?: bool          # declared at finalize (Tier 2)
pipeline: {
  phase:    "INGESTED"|"CORRELATED"|"ASR_SCORED"|"CLEANED"|"EXTRACTED"|"DRAFTED"|"VERIFIED"|"PUBLISHED",
  tier:     "haiku"|"sonnet"|"opus",
  attempts: n,
  batch?:   { jobName, taskToken, startedAt },   # Gate B task-token lookup (event carries only jobName)
  audioTimeout?: bool,                            # audio never arrived; proceeded on streaming text
  scores: {
    correlation:  { labelMarginMin, unresolvedPct, captionAgreementPct },
    asr:          { meanConfidence, p10Confidence, captionWerProxy },     # captions mode: heartbeat
                                                                          #  continuity, utterance-length
                                                                          #  dist, cross-check agreement
    invariants:   { numberMismatches, negationMismatches, groundedOn },   # P4 invariant gate
    verification: { claims, supported, partial, unsupported, unsupportedRate }
  },
  signalHealth: { captionsSeen, speakerRingSeen, domReadCount },
  asrSource:    "streaming"|"captions"|"both"|"batch-merged",
  lastError?:   string,
  executionArn: string
}
audioConsent?: { tier: 0|1|2, grantedAt }        # consent record (§7)
```

Optional later: `SK = MEETING#{id}#QA#{ts}` rows for Q&A logging (eval corpus) — free in single-table.

### Status machine

**User-facing `status` stays coarse for UI compatibility:**

```
capturing → processing → ready | needs_review | failed
```

- `capturing` is now a **real server-side state** (created by the start call, live-pollable) — not a client-only fiction. The dashboard's "live" label maps to it.
- `needs_review` = published with unresolved verification flags — a first-class, honest terminal state, rendered as a badge in the dashboard.
- `failed` always carries `lastError` and is always retryable via `POST /meetings/{id}/reprocess`. No more silent terminal failures. A sweep over stale `capturing`/`processing` rows (no segments/finalize within a window) reconciles orphans through the same reprocess path.
- Fine-grained progress lives in `pipeline.phase` (internal; the web renders it as a progress badge while polling).

---

## 5. Changes vs Current MVP — Ordered Implementation Milestones

Each milestone is independently shippable and leaves the system strictly better than before it.

**M1 — Capture robustness + capture-cost fix (extension-only; kills all total-loss modes)**
- `offscreen.ts`: incremental checkpointing of `segments[]` to **IndexedDB in the offscreen document** (`chrome.storage.*` is unavailable there; optional SW mirror via `chrome.runtime` messages only) every N finals; persist per-item Transcribe confidence into `DiarizedSegment`.
- `offscreen.ts`: **VAD mic-gating** — local energy-threshold/VAD pauses the mic stream during silence, hard-labeled resume. Extension-local, no Teams-DOM dependency, no telemetry precondition — it halves the dominant cost line from day one (principle 2).
- `offscreen-creds.ts`/`auth.ts`: Cognito credential + idToken refresh at ~50 min (meetings >1 h currently die).
- `background.ts`: stop/finalize-POST retry with backoff + local payload persistence; mint `captureId` per capture.
- `types.ts`: segment confidence field.

**M2 — Async pipeline skeleton + meeting lifecycle API (infra + backend; removes inline summarization)**
- CDK: `MeetingPipeline` SFN Standard; worker Lambda (`handlers/pipeline.ts`, Node 20, 512 MB, 300 s) with `{phase, modelTier}` dispatch; per-state `Retry`, top-level `Catch` → `lastError`; env `MODEL_HAIKU`/`MODEL_SONNET`/`MODEL_OPUS`; `states:StartExecution` grant on IngestFn; IngestFn timeout 120 s → 15 s.
- API: `POST /meetings` (start; conditional put on `captureId`), `POST /meetings/{id}/segments` (batched append), `POST /meetings/{id}/finalize` (idempotent; persists `raw-payload.json`, starts execution with `name = meetingId`, returns 202); delete the inline `summarizeMeeting` call; `POST /meetings/{id}/reprocess`.
- `store.ts`: generalized UpdateExpression for `pipeline` attribute + arbitrary phase payloads.
- Web: live view polling `GET /meetings/{id}` while `status === "capturing"` (60 s) and while `processing`; `pipeline.phase` progress badge; `needs_review` badge + filter; Reprocess button; segments expose `segId` + `endTime` (talk-time = Σ(endTime − startTime)).

**M3 — LLM quality pipeline (P4–P8; the fidelity core)**
- `lib/agent.ts` → tiered `converse(tier, blocks)` with `cachePoint`, structured output (json_schema / tool-forcing), retry on parse failure; per-phase prompts (Spanish output, white-label) under the **prefix discipline of §2-P4**: identical system + identical tool config across P5–P8/Q&A, phase instructions after the breakpoint; CI asserts `cache_read_input_tokens > 0` per phase.
- Phases P4 cleanup + **programmatic invariant gate** (numbers/names/negations raw↔clean, raw-grounding fallback), P5 extraction + quote check with raw fallback, P6 synthesis with id-keyed turn anchors, P7 verification + **rate-based Gate E** ladder, P8 publish **including the DDB `summary` attribute write**.
- Q&A rewrite: summary-first routing + 1 h-TTL transcript cache (same prefix discipline) + citation contract.
- Web: render verification report as "sources"; **`[Tn]` parser** linking anchors to transcript segments in summary and Q&A answers (never render raw anchor text).

**M4 — Caption capture + correlation v2 (the biggest speaker-fidelity win)**
- `teams-dom-adapter.ts`: caption-pane MutationObserver adapter (quarantined fragile module); popup prompt "enable live captions".
- `content.ts`: accumulate `captionTimeline` (checkpointed), return it + `signalHealth` on finalize.
- `correlation.ts` v2: stable segIds + caption anchors + **windowed voting** + numeric margins; Gate A wiring; P4 speaker-repair branch.
- Begin collecting the **golden set** (~20 real meetings) and gate-score telemetry for threshold calibration.
- *Deferred within this adapter:* meeting-start detection for auto-start capture (prompt or auto-start per user setting, incl. mic-permission pre-grant). Not v1 — capture start stays manual, and no auto-start toggle ships until this mechanism is specified.

**M5 — Opt-in audio + gated batch re-ASR**
- `offscreen.ts`: MediaRecorder Opus tee → OPFS; on consent Tier 2, upload via the **presigned PUT URLs returned by finalize** (backend-signed — the Cognito AuthRole cannot be IAM-scoped to `{tenantId}/{meetingId}/audio/*`, so no extension-direct `s3:PutObject` grant exists).
- CDK: SSE-KMS on the bucket; lifecycle delete on `*/audio/` (7 days hard cap; delete on verified transcript); `transcribe:StartTranscriptionJob` on the worker; **EventBridge rule `TranscribeJobStateChange` → callback Lambda → token lookup by jobName in DDB → `SendTaskSuccess`**; heartbeat/timeout on the waiting state.
- P3: `audioPending` Wait/HeadObject poll loop with timeout; Gate B on the **tab source only**; batch/streaming merge (align by time, prefer batch text) **followed by a P2 re-correlation pass**. Consent UI in popup; consent recorded on the meeting item.
- Roadmap unlocks within this phase interface: (a) faster-whisper large-v3 container (SageMaker Async / spot) replacing Transcribe Batch when volume justifies it; (b) **user-uploaded recordings** — presigned multipart upload → existing batch phase → normal P4–P8 pipeline (diarization-only speaker labels, since uploaded media has no speaker timeline). Post-M5 this is a thin UI over existing infra, not a separate workstream.

**M6 — Cost endgame (only after M4 telemetry justifies it)**
- **Gate 0 captions-primary mode** (per-tenant feature flag): skip Transcribe when captions flow; caption-heartbeat watchdog re-arms Transcribe mid-meeting; **capture graph alive-but-idle + in-RAM PCM ring buffer flushed on re-arm** (hard requirement, §2-P0); cross-check tab stream forced ON and mandatory until the captions-mode P3 signals are validated. Activation criterion: measured caption uptime/agreement above threshold on the golden set + production telemetry.
- Escalation-rate + `needs_review`-rate alarms (CloudWatch) on the calibrated thresholds.
- (VAD mic-gating shipped in **M1** — it has no telemetry dependency and was mis-sequenced here in an earlier draft.)

---

## 6. Cost per 1-Hour Meeting (~10k transcript tokens)

**Typical case (~80–90% of meetings: gates stay closed, all Haiku, caching active):**

| Item | Cost |
|---|---|
| Transcribe Streaming, tab stream (60 min × $0.024) | $1.44 |
| Transcribe Streaming, mic stream (VAD-gated from M1 — bills speech-time only) | ≤ $1.44 |
| Captions + speaker-ring DOM signals | $0.00 |
| P2/P3 correlation + ASR scoring + P4 invariant check (programmatic) | $0.00 |
| P4 cleanup (Haiku, 10.6k in / 9.2k out) | $0.057 |
| P5 extraction (Haiku, 9k cache-write + 0.8k / 1.2k out) | $0.018 |
| P6 synthesis (Haiku, cache-read / 1.0k out) | $0.008 |
| P7 verification (Haiku, cache-read / 1.5k out) | $0.011 |
| SFN transitions + Lambda + DDB/S3 | ~$0.001 |
| **Total typical** | **≤ ≈ $2.97** (LLM subtotal ≈ $0.094) |

**Worst case (all gates fire):** typical $2.97 + targeted repair + re-verify ($0.017) + Sonnet re-synthesis ($0.054) + re-verify on expired cache ($0.019) + Opus final pass ($0.09) + Transcribe Batch re-ASR, **tab source only** ($1.44 — batch-transcribing both recorded sources would double this to $2.88 for nothing: mic text from streaming is already speaker-known and high-confidence, and diarization on a mic file is pointless) → **≈ $4.60**. With the future Whisper-on-spot batch pass instead of Transcribe Batch: worst ≈ $3.35.

**Q&A:** first question ≈ **$0.02** (1 h-TTL cache write bills 2× input: 9k × 2 × $1/M ≈ $0.018, plus question/answer); subsequent ≈ **$0.001** (0.1× cache reads); summary-first-routed questions ≈ **$0.003** (~2k-token Haiku call + output). Break-even at ~3 questions/hour.

**M6 endgame curve (captions-primary mode) — honest adoption math, not a headline:** streaming is ~97% of the typical meeting cost, and captions are opt-in per user per meeting (and tenant-blockable). The per-meeting floor in captions-primary mode is the LLM subtotal, **≈ $0.10** — *not* $0.06, which is only reachable via the edit-list cleanup variant explicitly deferred out of v1 (§9-D2); fallback ≈ $2.97 (≈ today). Blended monthly at 100 meetings: **100% caption adoption ≈ $10/mo; 95% ≈ $24/mo; 80% ≈ $67/mo; 0% ≈ $297/mo** — **plus the Gate 0 forced cross-check term while it runs**: `crossCheckFraction × $1.44/meeting-hr` (e.g., a 20% forced fraction at 100% adoption adds ≈ $29/mo → ≈ $39/mo until agreement telemetry retires the cross-check). Budget on the measured adoption rate from `signalHealth` telemetry, never on the best case.

**Fidelity gain vs MVP (what the money buys):**
- **Summary:** from one unverified Haiku shot (parse failure = permanently failed meeting) to claim-level verified output — every bullet backed by an in-transcript quote (validated against raw, not just the rewrite), targeted repair, tiered escalation, zero terminal parse failures. Hallucination goes from *undetected* to *measured and gated*, including the P4-rewrite class the verifier alone can't see.
- **Speakers:** caption anchors + windowed voting + per-segment numeric confidence replace the meeting-global argmax; batch re-ASR output is re-correlated, never trusted raw; `spk_N` leakage into summaries effectively eliminated when captions are on; label recycling covered when they're off; silent DOM death detected via `signalHealth`.
- **ASR text:** unchanged in the typical case; gated batch re-pass upgrades flagged meetings (streaming < batch on the same engine; later Whisper large-v3 ≈ 7–10% WER vs ~12–18%).
- **Ops fidelity:** local + server-side checkpointing, credential refresh, idempotent finalize retry, durable artifacts, and the reprocess endpoint eliminate every currently-known path to unrecoverable meeting loss — and idempotency keys/execution-name dedupe eliminate the duplicate-meeting failure mode of naive retries.

---

## 7. Privacy Model

**Default invariant, unchanged: audio never leaves the browser.** The always-on pipeline (streaming ASR direct browser→Transcribe via Cognito Identity Pool creds, captions, LLM passes over text) stores no audio anywhere. The backend only ever sees text. In captions-primary mode (M6) the posture *strengthens*: audio doesn't even reach Transcribe — only text exists (the Gate 0 PCM ring buffer is seconds of RAM, never persisted, and independent of this ladder).

**Opt-in consent ladder (per meeting, recorded on the meeting item):**

| Tier | Behavior |
|---|---|
| **0 (default)** | No recording anywhere. Gate B can never fire; batch re-ASR simply unavailable. |
| **1 (local buffer)** | Opus in OPFS on the user's machine only; auto-purged after N days / on successful ingest. Enables user-initiated re-pass later. |
| **2 (upload)** | Explicit per-meeting consent; finalize declares `audioPending` + keys and the extension uploads **via backend-issued presigned PUT URLs** to the tenant/meeting-scoped S3 prefix (SSE-KMS); processed **exclusively in-account** (Transcribe Batch on the tab source / self-hosted Whisper — never third-party SaaS); lifecycle-deleted on verified transcript, hard cap 7 days. |

Additional properties: enabled Teams captions are visible to all participants — an inherent consent signal. White-label pitch preserved verbatim: *"your audio never leaves your AWS account, and by default is never stored at all."*

---

## 8. Risks & Mitigations

1. **Teams DOM fragility (captions + speaker ring) — the load-bearing free signals.** Both fidelity upgrades depend on undocumented selectors that break silently on Teams UI updates; captions are also opt-in per user and tenant-blockable. *Mitigations:* adapters quarantined in one module with a self-test at capture start; `signalHealth` in every payload (dashboard surfaces "caption signal lost"; DDB telemetry measures real adoption/breakage rates); caption-heartbeat watchdog re-arms Transcribe mid-meeting in captions-primary mode **with ring-buffer backfill so re-arm latency costs no speech**; every layer degrades gracefully to today's exact behavior (streaming + ring only). Gate 0 stays feature-flagged until telemetry proves it, and captions-primary meetings carry their own defined quality signals (P3) rather than blind gates.
2. **Gate miscalibration.** Thresholds (`labelMarginMin < 0.3`, `unresolvedPct > 15%`, `unsupportedRate > 10%`, cache minimums) are guesses until measured. Too loose → false confidence — the worst outcome being an unfaithful summary marked verified (Haiku verifier false-SUPPORTED, or a P4 rewrite error laundered past verification — hence the programmatic invariant gate and raw-transcript quote fallback). Too tight → everything escalates and the cost model collapses toward always-Sonnet. *Mitigations:* all scores + tier decisions (counts *and* rates) persisted in `pipeline.scores` from day one; a **golden set of ~20 real meetings** as a regression harness for threshold changes; CloudWatch alarms on escalation rate and `needs_review` rate; thresholds as per-tenant env vars; `needs_review` as the honest fallback — the verifier's uncertainty is surfaced, never hidden. Silent cache pitfalls (Haiku 4096-token minimum prefix, non-deterministic JSON, per-phase system/tool drift breaking the shared prefix) checked via per-phase `usage.cache_read_input_tokens` assertions in CI.
3. **Async/state complexity on a one-person codebase.** SFN + tiered prompts + caching + reprocess is ~5× the moving parts of the current inline call; failure modes shift from "visible 500" to "execution stuck in a state". *Mitigations:* Standard workflows retain full execution history (the audit log is built in); a **single worker Lambda** (one deployable) instead of per-phase functions; `lastError` + `executionArn` on the meeting item; heartbeats/timeouts on every callback wait so nothing hangs forever; a stale-row sweep reconciles orphaned `capturing`/`processing` meetings via reprocess; web polling keeps the UI truthful; milestones M1–M6 are each independently shippable, so complexity arrives incrementally and every intermediate state is a working product. The M1 capture fixes (checkpointing, VAD gating, credential refresh, retry) ship *first* precisely because no pipeline sophistication matters if the meeting never survives capture.

---

## 9. Synthesis Notes — Judge Disagreements Resolved

- **Winner (2–1 split).** Judges 1 and 3 chose *phased-balanced*; judge 2 chose *cost-first*. Resolution: *phased-balanced* is the spine — majority, plus both other judges independently identified the same disqualifying hole in cost-first's flagship path (Gate 0's irreversible 10 s ASR decision: a caption observer dying mid-meeting leaves an unrecoverable transcript hole, and in captions-only mode the design cannot even detect its own degradation — no confidence signal exists). Judge 2's substantive point — that cost-first is the only proposal attacking the $2.88/hr that is ~97% of every bill — is honored structurally: cost-first's endgame is adopted **whole** as milestone M6, made reversible via judge 2's own graft (heartbeat watchdog + mid-meeting Transcribe re-arm, hardened post-review with the alive-but-idle capture graph + RAM ring-buffer backfill so re-arm loses no speech) and gated on judge 3's condition (activate only after `signalHealth` telemetry proves caption reliability). The cost thesis survives; the one-way door does not.
- **D1 — Captions-primary mode:** all three judges converged independently (J1: per-tenant flag + forced cross-check + cold-start fallback; J2: reversible watchdog; J3: feature-flagged v2 after telemetry). Adopted with all three conditions (§2.0, M6), plus post-review hardening: explicitly defined captions-mode quality signals in P3 (heartbeat continuity, utterance-length distribution, cross-check agreement) so the quality gates never go blind, and the cross-check stream mandatory until those signals are validated. The caption-enable popup prompt (J1, J3) ships now, in M4.
- **D2 — Edit-list cleanup variant:** J1 said graft it behind a programmatic diff-check verifying preserved numbers/names/negations; J3 said do not graft (saves ~$0.037/meeting for real apply-in-code fragility). Resolution: **not in v1** — while streaming ASR dominates the bill at $2.88, a $0.037 saving is noise and the fragility is real (J3). Documented as a deferred lever for after M6, when LLM cost becomes the dominant share. **Post-review amendment:** J1's raw↔clean invariant diff-check turned out to be necessary *regardless* of the edit-list variant — the shipped full-rewrite P4 is otherwise an unaudited transformation that the verifier grounds against — so it ships in v1 as P4's programmatic invariant gate; the edit-list variant itself stays deferred.
- **D3 — Gate B audio upload flow:** J3 flagged phased-balanced's deferred mid-pipeline upload as its one infeasible flow (an SFN task token waiting on the extension/user has no push channel and can hang indefinitely). Resolution, revised post-review to close the remaining race and IAM gap: the finalize payload declares **`audioPending` + expected keys**; the 202 response returns **backend-issued presigned PUT URLs** (extension-direct `s3:PutObject` cannot be IAM-scoped to the `{tenantId}/{meetingId}` layout from the identity-pool role); the state machine, when Gate B's score conditions hold, waits for the object with a **bounded Wait/HeadObject poll loop** (timeout → proceed on streaming text, recorded in `pipeline.audioTimeout`) — Gate B never races a browser uplink. The EventBridge task-token callback is used only for the Transcribe *job* wait, where AWS provides the push channel — with `{jobName → taskToken}` persisted on the meeting item (the job-state event carries only the job name, no metadata) and a state-level heartbeat/timeout so a lost event can never hang the execution.
- **D4 — SQS DLQ:** fidelity-first proposed it; J3 called it over-engineered (a failed `StartExecution` in a synchronous handler can just 5xx, and the client retry covers it). Resolution: no SQS in v1 — with the post-review proviso that the retry path is made **idempotent** (client `captureId`, conditional puts, execution `name` = `meetingId`), since a bare re-POST of a server-minted-id endpoint would duplicate meetings.
- **Consensus grafts applied without conflict:** capture-robustness trio (all judges), windowed correlation voting (J1, J3), golden set + escalation alarms (J1, J2), summary-first Q&A routing (J1, J3), per-item Transcribe confidence persistence (J3), `needs_review` first-class (J2, J3; already in spine), IngestFn timeout to 15 s (J3), honest caption-adoption cost curve replacing headline numbers (J2; recomputed post-review on the correct $0.10 LLM floor + cross-check term), VAD mic-gating (J2; **resequenced from M6 to M1** post-review — it is extension-local with no telemetry dependency, and parking it behind M4 telemetry violated principle 2), signalHealth + single worker Lambda + coarse user-facing status (spine, endorsed by all).
- **Post-synthesis corrections (adversarial review):** meeting lifecycle API (start/segments/finalize) making `capturing` a real server-side state and enabling the live view; stable segment ids from P2 so anchors/edits survive rewrites; P2 re-correlation of the batch-merged transcript; Gate C driven by programmatic `scores.asr` (self-report demoted to OR-escalation); rate-based Gate E with a critical-field floor; cache-prefix discipline (identical system + tools across phases, instructions after the breakpoint) with per-phase cache-hit assertions; tab-only batch re-ASR; P8 DDB `summary` write kept; offscreen checkpointing pinned to IndexedDB/OPFS; Q&A and M6 cost figures corrected; upload-recordings re-scoped as an M5-dependent roadmap unlock; auto-start explicitly deferred pending a specified detection mechanism (M4).