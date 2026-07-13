# Second Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account-level "second brain" chat over all tenant meetings + personal notes (typed/dictated), grounded with deep-link citations, per spec `docs/superpowers/specs/2026-07-11-second-brain-design.md`.

**Architecture:** S3 Vectors (one index per tenant, Titan V2 1024/cosine), structural chunking of existing pipeline artifacts, `IndexMeeting` SFN state post-Publish, `POST /brain/ask` with single-shot Haiku planner + answerer, notes stored raw+clean in DDB, browser dictation via Transcribe Streaming with the existing Identity Pool grant, new web routes `/brain` and `/notes`.

**Tech Stack:** TypeScript ESM, AWS CDK (aws-cdk-lib 2.261.0 already locked — has `aws_s3vectors` L1), `@aws-sdk/client-s3vectors`, Bedrock Converse (existing `agent.ts` conventions), Next.js 15 static export, node:test.

## Global Constraints

- Code/identifiers/commits in **English**; UI copy and LLM output in **Spanish** (voseo). White-label — no client/brand references beyond existing `APP_NAME`.
- Git author `Mauricio Antolin <suscripciones@mauricioantolin.com>`; **no Claude attribution anywhere** (no Co-Authored-By, no generated footer).
- No comments explaining *what*; no defensive error handling in internal code.
- `agent.ts` cache discipline: ONE `SHARED_SYSTEM`, ONE union `TOOL_CONFIG` with `toolChoice {any}`; task selection in post-breakpoint instruction text only. Adding tools = accepted one-time cache-schema change.
- Tests: node:test, colocated `*.test.ts`, run compiled from dist (`tsc -b && node --test dist/**/*.test.js`).
- Backend Lambdas bundled by CDK NodejsFunction from `backend/src/handlers/*.ts` (esbuild, ESM, node20). Relative imports use `.js` extension.
- Web: static export (`output: "export"`), query-param routing, hand-rolled markdown, shadcn new-york, Tailwind v4 CSS-first.
- Stack name `TeamsAgentCore`, account 471446759294, us-east-1. Deploy via push to `main` (`.github/workflows/deploy.yml`).

## Resolved open items (spec §10 — decisions taken 2026-07-13)

1. **CFN/CDK S3 Vectors: supported.** `AWS::S3Vectors::VectorBucket` (CFN since 2025-10-31); CDK L1 `aws_s3vectors.CfnVectorBucket` since aws-cdk-lib 2.223.0 (repo locks 2.261.0). Vector bucket in CDK; per-tenant **indexes created lazily via SDK** (`@aws-sdk/client-s3vectors`) as designed.
2. **Native filter grammar: full `$or`/`$and`/`$eq`/`$ne`/`$in`/`$gte`/`$lte`/`$exists`.** Notes-privacy is one native filter: `{"$or":[{"type":{"$ne":"note"}},{"$and":[{"type":{"$eq":"note"}},{"ownerSub":{"$eq":sub}}]}]}`. No fallback needed. IAM caveat: `QueryVectors` with `filter`/`returnMetadata` **also requires `s3vectors:GetVectors`**.
3. **Embeddings: Titan V2 1024/cosine adopted now** (`amazon.titan-embed-text-v2:0`, on-demand us-east-1, one text per call, max 8192 tok / 50k chars, body `{inputText, dimensions:1024, normalize:true}` → `{embedding[]}`). Eval harness ships ready to run when golden corpus exists; index versioning covers migration.

Key limits: PutVectors/DeleteVectors ≤500 vectors/call; filterable metadata ≤2 KB/vector; ≤10 non-filterable keys per index (declared at CreateIndex, immutable); index name 3–63 chars `[a-z0-9.-]`; topK ≤页 100/page.

---

### Task 1: Shared types

**Files:** Modify: `packages/shared/src/types.ts`

**Produces (exact types consumed by all later tasks):**

```ts
// --- Second Brain (account-level chat + notes) ---
export type NoteSource = "typed" | "voice";

export interface Note {
  tenantId: string;
  noteId: string;          // ULID — chronological sort in SK
  ownerSub: string;        // Cognito sub; notes are private to their owner
  title: string;
  rawText: string;
  cleanText: string;
  source: NoteSource;
  createdAt: string;
  updatedAt: string;
  indexVersion?: number;
}

export interface NoteCreateRequest { rawText: string; source: NoteSource; }
export interface NoteUpdateRequest {
  title?: string;
  rawText?: string;
  cleanText?: string;
  /** re-run LLM cleanup on rawText and re-derive title/cleanText */
  reclean?: boolean;
}

export interface BrainCitation {
  ref: string;             // "M:{meetingId}:T{n}" | "N:{noteId}"
  kind: "meeting" | "note";
  id: string;
  turnId?: string;
  title: string;
  date?: string;           // ISO
  url: string;             // /meeting?id=X&turn=Tn | /notes?id=N
}

export interface BrainMessage {
  role: "user" | "assistant";
  text: string;            // markdown for assistant
  citations?: BrainCitation[];
  at: string;              // ISO
}

export interface BrainThread {
  threadId: string;        // ULID
  title: string;
  messages: BrainMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface BrainAskRequest { threadId?: string; message: string; }
export interface BrainAskResponse {
  threadId: string;
  answer: string;          // markdown with [M:id:Tn]/[N:id] markers
  citations: BrainCitation[];
}

export type BrainIndexStatus = "indexed" | "failed";
```

Also extend `Meeting` with optional fields: `indexStatus?: BrainIndexStatus; indexVersion?: number; indexedAt?: string;`

**Steps:**
- [ ] Add types above to `types.ts` (keep style of file), extend `Meeting`.
- [ ] `npm run build -w @teams-agent-core/shared` passes.
- [ ] Commit `feat(shared): add second-brain note/thread/citation types`.

### Task 2: `backend/src/lib/brain/ids.ts` — ULID + index-name derivation (TDD)

**Files:** Create `backend/src/lib/brain/ids.ts`, `backend/src/lib/brain/ids.test.ts`. Also add backend test script (Task 2 owns it): in `backend/package.json` scripts: `"test": "tsc -b && node --test dist/**/*.test.js"` — mirrors shared.

**Produces:**
```ts
export const INDEX_VERSION = 1;
export function ulid(now?: number): string;                 // 26-char Crockford base32, monotonic within ms not required
export function indexNameForTenant(tenantId: string, version?: number): string;
```

Rules for `indexNameForTenant` (tests first):
- Input is ONLY the JWT-derived tenantId (never client input) — enforced by callers.
- `norm = tenantId.toLowerCase().replace(/[^a-z0-9.-]/g, "-")`.
- If `norm !== tenantId` (lossy/case-changed) OR `norm.length > 43`, append determinism guard: `norm = norm.slice(0, 32) + "-" + sha256hex(tenantId).slice(0, 10)` (import `node:crypto`).
- Return `` `tenant-${norm}-v${version ?? INDEX_VERSION}` `` — always ≤63 chars, matches `[a-z0-9.-]`.

Test cases: UUID sub passthrough (`tenant-<uuid>-v1`), uppercase input → hashed suffix, `_`/`@` chars → hashed, two distinct raw ids that sanitize equal must produce different names, length cap, ULID: 26 chars, sortable by time, distinct across calls.

- [ ] Write failing tests → run (`npm test -w @teams-agent-core/backend`) → implement → green → commit `feat(backend): brain ids — ulid and tenant index-name derivation`.

### Task 3: `backend/src/lib/brain/chunker.ts` (TDD)

**Files:** Create `chunker.ts`, `chunker.test.ts` under `backend/src/lib/brain/`.

**Consumes:** shared types `Meeting, ExtractionResult, CleanTranscript, SummaryArtifact, Note`.
**Produces:**
```ts
export interface BrainChunk {
  key: string;
  text: string;                       // what gets embedded AND stored as metadata.text
  metadata: {
    type: "chapter" | "extraction" | "summary" | "digest" | "note";
    meetingId?: string;
    noteId?: string;
    dateEpoch: number;                // seconds
    ownerSub?: string;                // notes only
    embedVersion: string;             // e.g. "titan-v2-1024"
    title: string;                    // meeting/note title (non-filterable at index level)
    chapterTitle?: string;
    turnStart?: string;               // "T4"
    turnEnd?: string;
  };
}
export function chunkMeeting(meeting: Meeting, artifacts: {
  extraction?: ExtractionResult; clean?: CleanTranscript; summary?: SummaryArtifact;
}): BrainChunk[];
export function chunkNote(note: Note): BrainChunk[];
```

Behavior (per spec §3, tests assert key patterns, `[Tn]` preservation, header format, splitting):
- **Extraction micro-chunks** — for each of decisions/actionItems/openQuestions/keyNumbers, one chunk per item, keys `{meetingId}#ex#{dec|act|opq|num}#{i}`. Text: `` `${label} (${fecha}, reunión "${title}"): ${item.text} — cita: "${item.verbatimQuote}" [${item.turnId}]` `` where label ∈ Decisión/Tarea/Pregunta abierta/Cifra clave and `fecha` = `startedAt.slice(0,10)`. Skip items with empty text.
- **Chapters** — assign `clean.turns` to `clean.chapters` by `startTime` window (turns before first chapter go to a synthetic chapter "Inicio"). Render each turn `[Tn] Speaker: text`. Split each chapter into windows of ~500 tokens target, max ~700, min ~300 (estimate tokens = `ceil(chars/4)`), **1-turn overlap** between consecutive windows. Prepend header `` `Reunión: "${title}" — ${fecha} — Capítulo: "${chapterTitle}"\n\n` ``. Keys `{meetingId}#ch#{n}` (global counter). Metadata `turnStart`/`turnEnd` = first/last turn id in window.
- **Summary** — split `summary.text` on `/^## /m` headings (keep heading with its section; preamble before first `##` is chunk 0 if non-empty). Header `` `Resumen de reunión "${title}" — ${fecha}\n\n` ``. Keys `{meetingId}#sum#{n}`.
- **Digest** — one chunk `{meetingId}#dig`: title, date, participant names, and `meeting.summary?.keyPoints` bullets if present.
- **Note** — split `cleanText` ~650-token windows (no overlap), header `` `Nota personal — ${fecha} — ${title}\n\n` ``, keys `note#{noteId}#{n}`, metadata `{type:"note", noteId, ownerSub, dateEpoch(createdAt), title}`.
- `dateEpoch = Math.floor(Date.parse(meeting.startedAt)/1000)`.

- [ ] Tests (fixture meeting with 2 chapters/8 turns, extraction with all 4 kinds, summary with 2 H2s; asserts on keys, headers, `[Tn]` presence, overlap, split bounds) → red → implement → green → commit `feat(backend): structural brain chunker`.

### Task 4: `backend/src/lib/brain/embed.ts`

**Files:** Create `backend/src/lib/brain/embed.ts`.

**Produces:**
```ts
export const EMBED_VERSION = "titan-v2-1024";
export const EMBED_DIMENSIONS = 1024;
export async function embedText(text: string): Promise<number[]>;
export async function embedAll(texts: string[], concurrency?: number): Promise<number[][]>; // default 4
```
- `BedrockRuntimeClient` module-level; model `process.env.EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0"`; `InvokeModelCommand` body `{ inputText: text.slice(0, 40000), dimensions: 1024, normalize: true }`; parse `JSON.parse(new TextDecoder().decode(res.body)).embedding`.
- Retry throttling like agent.ts `sendWithBackoff` (local copy, 4 retries, `500*2**i + jitter`), retry on `ThrottlingException|TooManyRequestsException|ServiceUnavailableException` or `$metadata.httpStatusCode === 429`.
- `embedAll`: bounded worker-pool concurrency (no deps), preserves order.
- [ ] Implement, `tsc -b` green, commit `feat(backend): titan v2 embedding client`.

### Task 5: `backend/src/lib/brain/vectorstore.ts` (+ filter TDD)

**Files:** Create `vectorstore.ts`, `vectorstore.test.ts` (tests target the pure filter builder).

**Produces:**
```ts
export const NON_FILTERABLE_KEYS = ["text", "title", "chapterTitle", "turnStart", "turnEnd"];
export interface QueryHit { key: string; distance?: number; metadata: Record<string, unknown>; }
export function brainQueryFilter(callerSub: string, opts?: {
  types?: string[]; dateFromEpoch?: number; dateToEpoch?: number;
}): Record<string, unknown>;
export async function ensureIndex(indexName: string): Promise<void>;
export async function putChunkVectors(indexName: string, chunks: BrainChunk[], embeddings: number[][]): Promise<string[]>; // returns keys written
export async function queryIndex(indexName: string, embedding: number[], opts: { topK?: number; filter: Record<string, unknown> }): Promise<QueryHit[]>;
export async function deleteVectorKeys(indexName: string, keys: string[]): Promise<void>;
```
- `S3VectorsClient` from `@aws-sdk/client-s3vectors` (add dep to `backend/package.json`). Bucket = `process.env.VECTOR_BUCKET!`.
- `brainQueryFilter` (pure, TDD): base privacy clause exactly `{"$or":[{"type":{"$ne":"note"}},{"$and":[{"type":{"$eq":"note"}},{"ownerSub":{"$eq":callerSub}}]}]}`; when opts present wrap as `{"$and":[base, ...]}` adding `{"type":{"$in":types}}` and/or `{"dateEpoch":{"$gte":from}}`/`{"$lte":to}` (merged into one `{"dateEpoch":{...}}` object when both). Tests: base shape; types+range composition; never a filter that could match another owner's note (assert ownerSub equality clause always present under the note branch).
- `ensureIndex`: `GetIndexCommand` → on `NotFoundException` `CreateIndexCommand({vectorBucketName, indexName, dataType:"float32", dimension:1024, distanceMetric:"cosine", metadataConfiguration:{nonFilterableMetadataKeys: NON_FILTERABLE_KEYS}})`, swallow `ConflictException` (race).
- `putChunkVectors`: vectors `{key, data:{float32: embedding}, metadata: {...chunk.metadata, text: chunk.text}}`, sliced ≤500/call.
- `queryIndex`: `QueryVectorsCommand({vectorBucketName, indexName, queryVector:{float32}, topK: opts.topK ?? 15, filter, returnMetadata: true, returnDistance: true})`. On `NotFoundException` (index doesn't exist yet — empty tenant) return `[]`.
- `deleteVectorKeys`: ≤500 slices; ignore `NotFoundException`.
- [ ] Filter tests red → implement all → green → commit `feat(backend): s3 vectors store with tenant/notes privacy filter`.

### Task 6: store.ts — notes, threads, index bookkeeping

**Files:** Modify `backend/src/lib/store.ts`.

**Produces (following existing keyOf/skOf style):**
```ts
// SKs: NOTE#{ownerSub}#{noteId} · THREAD#{ownerSub}#{threadId} · IDX#MEETING#{id} · IDX#NOTE#{id} · CONFIG#INDEX
export async function putNote(note: Note): Promise<void>;
export async function getNote(tenantId: string, ownerSub: string, noteId: string): Promise<Note | undefined>;
export async function listNotes(tenantId: string, ownerSub: string): Promise<Note[]>;        // newest first
export async function deleteNote(tenantId: string, ownerSub: string, noteId: string): Promise<void>;
export async function putThread(tenantId: string, ownerSub: string, thread: BrainThread): Promise<void>;
export async function getThread(tenantId: string, ownerSub: string, threadId: string): Promise<BrainThread | undefined>;
export async function listThreads(tenantId: string, ownerSub: string): Promise<Pick<BrainThread, "threadId"|"title"|"updatedAt">[]>;
export async function deleteThread(tenantId: string, ownerSub: string, threadId: string): Promise<void>;
export async function putIndexedKeys(tenantId: string, doc: `MEETING#${string}` | `NOTE#${string}`, keys: string[], indexVersion: number): Promise<void>;
export async function getIndexedKeys(tenantId: string, doc: string): Promise<{ keys: string[]; indexVersion: number } | undefined>;
export async function deleteIndexedKeys(tenantId: string, doc: string): Promise<void>;
```
Notes/threads Query: `PK = TENANT#{t} AND begins_with(SK, "NOTE#{sub}#")`, `ScanIndexForward:false` (ULID ⇒ chronological). Threads list projects `threadId, title, updatedAt`.
- [ ] Implement + `tsc -b` + commit `feat(backend): store notes, brain threads and index bookkeeping`.

### Task 7: `backend/src/lib/brain/indexer.ts`

**Files:** Create `indexer.ts`.

**Consumes:** chunker, embed, vectorstore, store, ids.
**Produces:**
```ts
export async function indexMeeting(tenantId: string, meetingId: string): Promise<{ chunks: number }>;
export async function indexNote(note: Note): Promise<{ chunks: number }>;
export async function removeMeetingVectors(tenantId: string, meetingId: string): Promise<void>;
export async function removeNoteVectors(tenantId: string, ownerSub: string, noteId: string): Promise<void>;
```
`indexMeeting`: load meeting item + artifacts (`getExtraction`, `getCleanTranscript`, `getSummaryArtifact` with NoSuchKey→undefined) → `chunkMeeting` → if 0 chunks, still record empty key list → `ensureIndex(indexNameForTenant(tenantId))` → `embedAll(texts)` → diff vs `getIndexedKeys` (delete stale keys no longer emitted) → `putChunkVectors` → `putIndexedKeys` → `updateMeeting(tenantId, meetingId, { indexStatus: "indexed", indexVersion: INDEX_VERSION, indexedAt: iso })`.
`indexNote`: same shape for note; deletes stale via stored list; updates note item `indexVersion`.
`remove*`: `getIndexedKeys` → `deleteVectorKeys` → `deleteIndexedKeys`.
- [ ] Implement + commit `feat(backend): meeting/note vector indexer`.

### Task 8: agent.ts — planner, note cleanup, brain answer tools

**Files:** Modify `backend/src/lib/agent.ts`.

Add THREE tools to `TOOL_CONFIG` union (cache-schema change, accepted):
- `plan_search`: input schema `{searchQuery: string (required), timeIsExplicit: boolean (required), fromEpoch?: number, toEpoch?: number, targetTypes?: string[] (enum chapter|extraction|summary|digest|note)}`.
- `clean_note`: `{title: string, cleanText: string}` (required both).
- `record_brain_answer`: `{answer_md: string (required), citations: string[] (required — refs like "M:<meetingId>:T4" or "N:<noteId>")}`.

**Produces:**
```ts
export interface BrainSearchPlan { searchQuery: string; timeIsExplicit: boolean; fromEpoch?: number; toEpoch?: number; targetTypes?: string[]; }
export async function planBrainSearch(opts: { historyBlock: string; message: string; todayIso: string }): Promise<BrainSearchPlan>;
export async function cleanNoteText(rawText: string): Promise<{ title: string; cleanText: string }>;
export interface BrainAnswer { answerMd: string; citations: string[]; }
export async function generateBrainAnswer(opts: { chunksBlock: string; historyBlock: string; question: string; todayIso: string }): Promise<BrainAnswer>;
```
All via `converseTool`, tier `haiku`, `throttleRetries: 2` (API-sync), manual validators in the existing rec/str style.
- `planBrainSearch` (maxTokens 1024): `context` = stable Spanish planner preamble (rewrite question self-contained using history; time filters ONLY when explicit; today's date placeholder goes AFTER breakpoint). `instruction` = `Hoy es ${todayIso}.\n${historyBlock}\nPregunta: ${message}\n…then call plan_search`.
- `cleanNoteText` (maxTokens 4096): context = stable instructions (title ≤60 chars in Spanish; cleanText = faithful structured cleanup, keep all facts, no inventions); instruction = raw text + "then call clean_note".
- `generateBrainAnswer` (maxTokens 4096): context = stable rules (answer in Spanish from the provided fragments only; cite with inline markers `[M:{meetingId}:T{n}]` for meeting fragments / `[N:{noteId}]` for notes right after each claim; prefer the most recent decision and flag changes over time; if fragments don't cover it, say so plainly). instruction = `Hoy es ${todayIso}` + chunksBlock (each fragment labeled `--- Fragmento {ref} ({tipo}, {fecha}) ---`) + historyBlock + question + "then call record_brain_answer". Validator: answer_md non-empty string; citations array of strings.
- [ ] Implement + `tsc -b` + commit `feat(backend): brain planner, note-cleanup and answer tools`.

### Task 9: `backend/src/lib/brain/citations.ts` (TDD)

**Files:** Create `citations.ts`, `citations.test.ts`.

**Produces:**
```ts
export interface ParsedRef { ref: string; kind: "meeting" | "note"; id: string; turnId?: string; }
export function parseRefs(answerMd: string): ParsedRef[];   // unique, order of appearance
export function resolveCitations(answerMd: string, hits: QueryHit[]): { answerMd: string; citations: BrainCitation[] };
```
- Regex `/\[M:([A-Za-z0-9._-]+):(T\d+)\]|\[N:([A-Za-z0-9._-]+)\]/g`.
- `resolveCitations`: for each parsed ref, find a hit whose metadata matches (`meetingId` equal — turn need not match a specific hit; `noteId` equal). Resolved → citation `{ref, kind, id, turnId?, title: metadata.title, date: iso from dateEpoch, url}` with `url` = `/meeting?id={id}&turn={turnId}` (omit `&turn=` when no turn) or `/notes?id={noteId}`. Unresolvable refs are **stripped from answerMd** and excluded. Dedupe by `ref`.
- Tests: mixed valid/invalid refs, stripping, dedupe, URL shapes, note refs never resolve against meeting hits.
- [ ] Red → implement → green → commit `feat(backend): citation parsing and resolution`.

### Task 10: `backend/src/handlers/notes.ts`

**Files:** Create `backend/src/handlers/notes.ts`.

Single Lambda, `event.routeKey` switch (ingest.ts pattern), `tenantOf(event)` + `sub = String(event.requestContext.authorizer.jwt.claims.sub)`:
- `POST /notes` — body `NoteCreateRequest`; 400 if `!rawText?.trim()` or source invalid. `cleanNoteText(rawText)` → `Note` (ulid, ISO timestamps) → `putNote` → `indexNote(note)` in try/catch (log failure, note still returned) → `json(201, note)`.
- `GET /notes` → `json(200, { notes: await listNotes(tenantId, sub) })`.
- `GET /notes/{id}` → 404 when missing.
- `PUT /notes/{id}` — body `NoteUpdateRequest`; if `reclean` → re-run `cleanNoteText(rawText ?? note.rawText)`; apply field updates, `updatedAt`; `putNote` + `indexNote` (re-embed overwrites same keys; stale extras deleted by indexer diff) → `json(200, note)`.
- `DELETE /notes/{id}` → `removeNoteVectors` + `deleteNote` → `json(204... )` use `json(200, { ok: true })` (existing handlers return bodies).
- [ ] Implement + commit `feat(backend): notes CRUD with LLM cleanup and inline indexing`.

### Task 11: `backend/src/handlers/brain.ts`

**Files:** Create `backend/src/handlers/brain.ts`.

Single Lambda, routeKey switch:
- `POST /brain/ask` — body `BrainAskRequest`; 400 on empty message (cap message 4000 chars).
  1. `thread = threadId ? await getThread(tenantId, sub, threadId) : undefined` (404 if threadId given and missing).
  2. `historyBlock` = last 8 messages rendered `Usuario: …` / `Asistente: …` (strip citation markers from assistant text? keep; harmless) — empty string for new thread.
  3. `plan = await planBrainSearch(...)` with `todayIso = new Date().toISOString().slice(0,10)`.
  4. `embedding = await embedText(plan.searchQuery)`.
  5. `filter = brainQueryFilter(sub, plan.timeIsExplicit ? { dateFromEpoch: plan.fromEpoch, dateToEpoch: plan.toEpoch, types: plan.targetTypes } : { types: plan.targetTypes })` — **hard date filter only when explicit** (spec §5 rule). Note: targetTypes are a boost in spirit; passing as filter is acceptable v1 ONLY for explicit types from planner — to stay safe, only apply `types` when planner returned them AND they exclude nothing critical; simplest compliant choice: ignore `targetTypes` in the filter for v1 (boosts-only rule), keep field for v1.1. **Decision: ignore targetTypes in filter v1.**
  6. `hits = await queryIndex(indexNameForTenant(tenantId), embedding, { topK: 15, filter })`.
  7. `chunksBlock`: for each hit, ref = metadata.type === "note" ? `N:${noteId}` : `M:${meetingId}:${turnStart ?? ""}`… **ref label per fragment** uses the fragment's own identity: meetings `M:{meetingId}:{turnStart|T1}` shown as `[M:…:Tn]`-usable; include full chunk `metadata.text`.
  8. `answer = await generateBrainAnswer(...)`; `{ answerMd, citations } = resolveCitations(answer.answerMd, hits)`.
  9. Thread persistence: create if new (`threadId = ulid()`, `title` = first 60 chars of message), append user+assistant `BrainMessage`s, cap: if `messages.length > 40` → `json(409, { error: "thread full" })` BEFORE the LLM work (step 1.5).
  10. `json(200, { threadId, answer: answerMd, citations } satisfies BrainAskResponse)`.
- `GET /brain/threads` → `{ threads }`; `GET /brain/threads/{id}` → thread or 404; `DELETE /brain/threads/{id}` → `{ ok: true }`.
- [ ] Implement + commit `feat(backend): brain ask endpoint with planner, retrieval and cited answer`.

### Task 12: pipeline worker — `index` / `indexFail` phases

**Files:** Modify `backend/src/handlers/pipeline.ts`.

- Extend `PipelineWorkerPhase` union with `"index" | "indexFail"`; add cases:
  - `index`: `await indexMeeting(tenantId, meetingId)` → return `{ meetingId, phase, status: "ok" }`.
  - `indexFail`: `await updateMeeting(tenantId, meetingId, { indexStatus: "failed" })` → return.
- [ ] Implement + commit `feat(backend): pipeline index phase for post-publish vector indexing`.

### Task 13: `backend/src/handlers/reindex.ts` — admin backfill

**Files:** Create `backend/src/handlers/reindex.ts`.

`POST /admin/reindex` (single-purpose Lambda; `isAdmin` gate first line; NOT in AdminFn — different IAM surface):
- Body `{ cursor?: string, force?: boolean }`. Iterates caller-tenant meetings (`listMeetings` paged — add paged variant or reuse; page 25), skipping `status === "capturing" | "processing"` and (unless `force`) items with `indexVersion === INDEX_VERSION`.
- Processes with concurrency 3 (`indexMeeting`), per-meeting try/catch → `updateMeeting {indexStatus:"failed"}` on error, collects counters.
- Deadline ~20 s (`Date.now() - start > 20000` → stop, return `{ done: false, cursor }` base64 of LastEvaluatedKey / meetingId offset). Response `{ processed, indexed, failed, skipped, done, cursor? }`. Client (or smoke script) loops until `done`.
- Idempotent & resumable by design (deterministic keys, overwrite).
- [ ] Implement (+ paged list helper in store.ts if needed) + commit `feat(backend): admin reindex backfill endpoint`.

### Task 14: infra — vector bucket, Lambdas, routes, SFN, IAM, SpaRewriteFn

**Files:** Modify `infra/lib/teams-agent-core-stack.ts`.

1. **Vector bucket:** `import { aws_s3vectors as s3vectors } from "aws-cdk-lib"` → `const vectorBucket = new s3vectors.CfnVectorBucket(this, "BrainVectorBucket", { vectorBucketName: \`${this.account}-teams-agent-core-brain\` });` (63-char safe, deterministic). `const vectorBucketName = vectorBucket.vectorBucketName!;` ARNs: `const vectorIndexArns = \`arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}/index/tenant-*\`; const vectorBucketArn = \`arn:...:bucket/${vectorBucketName}\`;`
2. **Env for brain-aware fns:** `BRAIN_ENV = { VECTOR_BUCKET: vectorBucketName, EMBED_MODEL_ID: "amazon.titan-embed-text-v2:0", ...fnEnv }`. Add `VECTOR_BUCKET`/`EMBED_MODEL_ID` to `pipelineWorker.environment` too (worker construct: add the two keys).
3. **IAM helper policies:**
   - `titanInvoke` PolicyStatement: `bedrock:InvokeModel` on `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`.
   - `vectorWrite`: actions `s3vectors:CreateIndex, GetIndex, PutVectors, DeleteVectors, GetVectors, QueryVectors, ListIndexes` resources `[vectorBucketArn, vectorIndexArns]`.
   - `vectorQuery`: actions `s3vectors:QueryVectors, GetVectors, GetIndex` resources `[vectorBucketArn, vectorIndexArns]` (defense-in-depth: only `tenant-*` pattern).
   - pipelineWorker += vectorWrite + titanInvoke.
4. **New Lambdas** (NodejsFunction, bundling, node20):
   - `BrainFn` entry `handlers/brain.ts`, timeout 29 s, 512 MB, env BRAIN_ENV + models (MODEL_HAIKU etc. — reuse the three model vars) → grants: `table.grantReadWriteData`, `bedrockModelAccess`, titanInvoke, vectorQuery.
   - `NotesFn` entry `handlers/notes.ts`, timeout 29 s, 512 MB, env BRAIN_ENV + models → `table.grantReadWriteData`, `bedrockModelAccess`, titanInvoke, vectorWrite.
   - `ReindexFn` entry `handlers/reindex.ts`, timeout 29 s, 1024 MB, env BRAIN_ENV → `table.grantReadWriteData`, `transcripts.grantRead`, titanInvoke, vectorWrite.
5. **Routes** (same authorizer): `POST /brain/ask`, `GET /brain/threads`, `GET /brain/threads/{id}`, `DELETE /brain/threads/{id}` → BrainFn (shared `HttpLambdaIntegration("BrainIntegration", brainFn)`); `POST /notes`, `GET /notes`, `GET /notes/{id}`, `PUT /notes/{id}` (add `HttpMethod.PUT` to CORS allowMethods!), `DELETE /notes/{id}` → NotesFn; `POST /admin/reindex` → ReindexFn.
6. **SFN:** after existing publish states:
```ts
const indexMeetingTask = workerTask("IndexMeeting", "index", JsonPath.DISCARD);
const indexFail = workerTask("IndexMeetingFail", "indexFail", JsonPath.DISCARD);
indexMeetingTask.addCatch(indexFail, { resultPath: "$.indexError" });
indexMeetingTask.next(new Succeed(this, "Indexed"));
indexFail.next(new Fail(this, "IndexingFailed", { error: "IndexingFailed", cause: "vector indexing failed after publish" }));
publish.next(indexMeetingTask);
publishWithFlag.next(indexMeetingTask);
```
(NOTE: `workerTask` already adds States.ALL retry ×2. Publish/PublishWithFlag currently terminal — verify no `.next` conflicts.) Do NOT add indexMeetingTask to the global `addCatch(setError)` list — its catch is indexFail.
7. **SpaRewriteFn:** routes array += `"/brain", "/notes"`.
8. **Outputs:** `new CfnOutput(this, "VectorBucketName", { value: vectorBucketName });`
9. `infra` deps: none new (L1 in aws-cdk-lib). `backend` deps: `@aws-sdk/client-s3vectors`.
- [ ] Implement; `npx cdk synth` green locally (with dummy account env); commit `feat(infra): brain vector bucket, lambdas, routes, index SFN state and SPA routes`.

### Task 15: root typecheck fix

**Files:** Create root `tsconfig.json` `{ "files": [], "references": [{ "path": "packages/shared" }, { "path": "backend" }] }` so `npm run typecheck` (`tsc -b`) actually works.
- [ ] Add + verify `npm run typecheck` green + commit `chore: root tsconfig for tsc -b typecheck`.

### Task 16: web — chat primitives extraction

**Files:** Create `web/components/chat/chat-messages.tsx`, `chat-composer.tsx`, `source-ref-text.tsx`; Modify `web/components/markdown.tsx` (optional `renderInline?: (text: string, key: number) => ReactNode` prop), `web/components/meeting/qa-tab.tsx` (consume primitives — visual/behavioral no-op).

- `ChatComposer` props: `{ disabled: boolean; placeholder: string; onSend(text: string): void }` — textarea + Enter/Shift+Enter + ArrowUp button (extracted verbatim from qa-tab).
- `ChatMessages` props: `{ items: { q: string; a?: ReactNode }[]; pending?: string | null; emptyState?: ReactNode }` — user bubble right/primary, answer bubble muted, 3-dot pulse for pending, auto-scroll end ref, hover Copy button on answers (copy raw text — pass `aRaw?: string`).
- `SourceRefText`: like `turn-ref-text.tsx` but regex for `[M:id:Tn]`/`[N:id]` → small Badge chips (label `Reunión·Tn` / `Nota`) navigating via `next/link` to citation URL. (Brain answers already come with `citations[]`; chips link by parsing.)
- qa-tab refactor keeps its sessionStorage thread, auto-prompt logic, [Tn]-only rendering (existing `Markdown` + `TurnRefText` path).
- [ ] Implement; `npm run build -w @teams-agent-core/web` green; commit `refactor(web): extract chat primitives from qa-tab`.

### Task 17: web — api wrappers + config

**Files:** Modify `web/lib/api.ts` (add `BrainCitation, BrainThreadSummary, BrainThread, Note` local types + `brainAsk(token, body)`, `listBrainThreads`, `getBrainThread`, `deleteBrainThread`, `listNotes`, `createNote`, `getNote`, `updateNote`, `deleteNote`), `web/lib/config.ts` (add `identityPoolId: "us-east-1:846a80da-00b1-4db1-8ba5-206249505f29"`).
- [ ] Implement + build green + commit `feat(web): brain and notes api client + identity pool config`.

### Task 18: web — `/brain` page

**Files:** Create `web/app/(shell)/brain/page.tsx`, `web/components/brain/brain-view.tsx`, `web/components/brain/source-cards.tsx`; Modify `web/components/app-sidebar.tsx` (NAV += `{ title: "Memoria", href: "/brain", icon: Brain }`, `{ title: "Notas", href: "/notes", icon: NotebookPen }` from lucide).

- Layout: left threads rail (Card list from `listBrainThreads`, "Nueva conversación" button, delete per thread w/ confirm) + chat area using ChatMessages/ChatComposer.
- Ask flow: staged status while pending — rotate `"Buscando en la memoria…"` (0 s) → `"Leyendo fragmentos…"` (2.5 s) → `"Redactando respuesta…"` (5 s) via interval.
- Answer rendering: `Markdown` with `renderInline` = SourceRefText; below each answer `SourceCards citations={...}` — chip `Reunión`/`Nota`, title, date (es-AR format), deep-link.
- Thread state: URL `?t={threadId}` to reopen; new thread on first send stores returned threadId.
- Errors: sonner toast + draft restore (qa-tab pattern). Empty state: suggestions ("¿Qué decidimos sobre…?", "¿Qué quedó pendiente esta semana?", "Buscá mis notas sobre…").
- [ ] Implement + build + commit `feat(web): brain memory chat page with threads and source cards`.

### Task 19: web — `/notes` page

**Files:** Create `web/app/(shell)/notes/page.tsx`, `web/components/notes/notes-view.tsx`, `note-editor.tsx`.

- List (cards: title, date, source icon Mic/Keyboard, excerpt) + "Nueva nota" + editor panel (Sheet on mobile / right panel xl).
- Editor: title input; Tabs `Limpia` (cleanText textarea) / `Original` (rawText textarea); actions: Guardar (PUT), "Limpiar con IA" (PUT `{reclean:true}`), Eliminar (confirm AlertDialog).
- Create flow: "Nueva nota" opens composer (textarea + mic button); Guardar → `POST /notes {rawText, source:"typed"}` → toast + open created note. `?id=` query opens note; `?record=1` opens composer with mic armed.
- [ ] Implement + build + commit `feat(web): notes module ui`.

### Task 20: web — dictation (Transcribe Streaming)

**Files:** Create `web/lib/use-transcribe-stream.ts`, `web/components/notes/mic-button.tsx`. Deps: `@aws-sdk/client-transcribe-streaming`, `@aws-sdk/credential-providers` in `web/package.json`.

- Hook API: `useTranscribeStream(): { status: "idle"|"recording"|"error"; partial: string; finalText: string; start(): Promise<void>; stop(): void; reset(): void; error?: string }`.
- `start()`: `getUserMedia({audio})` → `AudioContext({ sampleRate: 16000 })` (fallback: default rate + downsample) → inline `AudioWorklet` module via Blob URL posting Float32 frames → convert to PCM16LE `Uint8Array` → push into async queue consumed by `AudioStream` generator → `TranscribeStreamingClient({ region, credentials: fromCognitoIdentityPool({ clientConfig:{region}, identityPoolId: CONFIG.identityPoolId, logins: { [\`cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}\`]: idToken } }) })` (idToken from `useAuth()`), `StartStreamTranscriptionCommand({ LanguageCode: "es-US", MediaEncoding: "pcm", MediaSampleRateHertz: 16000, AudioStream })`; consume `TranscriptResultStream`: `IsPartial` → `partial`, final → append `finalText`.
- Client-only: module imported inside `"use client"` components only.
- `MicButton` props `{ onTranscript(text: string): void }` — toggles record, live partial shown under button, on stop delivers accumulated text.
- **Headless-untestable:** real mic → manual test pending; hook consumed by note composer which also accepts typed text (fallback verified).
- [ ] Implement + build + commit `feat(web): browser dictation via transcribe streaming`.

### Task 21: web — deep links + command palette

**Files:** Modify `web/app/(shell)/meeting/page.tsx` (read `turn` search param; when present after detail load: set tab "transcript" + `setNavTarget({turnId: turn, nonce: Date.now()})` once), `web/components/command-palette.tsx` (Acciones += "Preguntar a la memoria" → `/brain`, "Notas" → `/notes`, "Nueva nota de voz" → `/notes?record=1`).
- [ ] Implement + build + commit `feat(web): turn deep-links and memory palette entries`.

### Task 22: eval harness + golden set scaffold

**Files:** Create `scripts/brain-eval.mjs`, `docs/brain-eval-golden.example.json`.
- Script: env `VECTOR_BUCKET, TENANT_ID, GOLDEN=path` → for each `{question, expectMeetingId}` embed via Titan (AWS SDK from repo deps) → query tenant index → report hit@5/hit@15 + MRR table. Exits nonzero below threshold only when `--gate`. Pragmatic: runnable post-backfill when a golden corpus exists.
- [ ] Implement + commit `feat: embedding eval harness scaffold`.

### Task 23: isolation + smoke scripts

**Files:** Create `scripts/brain-isolation.mjs` (NO-negotiable gate), `scripts/brain-smoke.mjs`.
- `brain-isolation.mjs`: with deploy creds — creates `tenant-smoketest-a-v1`/`tenant-smoketest-b-v1` indexes, puts distinctive vectors (deterministic pseudo-embeddings), queries A topK 10 → **asserts zero keys from B**, asserts notes filter: put note vector ownerSub=u1, query with filter(u2) → zero notes; cleans up (DeleteIndex). Exits 1 on any leak.
- `brain-smoke.mjs`: env `API_URL, USER_EMAIL, USER_PASSWORD` → Cognito SRP login (reuse amazon-cognito-identity-js from web deps or use `aws-sdk` InitiateAuth USER_PASSWORD_AUTH — client has userPassword:true) → `POST /admin/reindex` loop until done → `POST /notes` typed note → assert title+cleanText → `GET /notes` contains it → 3× `POST /brain/ask` (questions passed via args or defaults) → assert 200, answer non-empty, citations array with valid `/meeting?id=`/`/notes?id=` URLs → `GET /brain/threads` shows thread.
- [ ] Implement + commit `test: brain isolation and smoke scripts`.

### Task 24: spec update (§10 decisions)

**Files:** Modify `docs/superpowers/specs/2026-07-11-second-brain-design.md` — mark items 2/3/5 resolved with the decisions in "Resolved open items" above + date.
- [ ] Edit + commit `docs: record resolved open items in second-brain spec`.

## Gates (before push)

- [ ] `npm run typecheck` green (root, after Task 15)
- [ ] `npm run build` green across workspaces (shared, backend, extension, web; infra `cdk synth`)
- [ ] `npm test` green (shared + backend suites)
- [ ] `/code-review` on the diff; apply real findings
- [ ] Push branch, PR to main, merge (authorized), CI deploy green

## Post-deploy (session does not end before)

- [ ] `node scripts/brain-isolation.mjs` against deployed bucket → zero cross-tenant leakage
- [ ] Backfill via smoke script on test tenant; verify index created/populated (ListIndexes / counters)
- [ ] Typed note via API returns title+cleanText and lands in index
- [ ] 2–3 real `POST /brain/ask` with valid `[M:…]`/`[N:…]` citations and live deep-links
- [ ] Web: `/brain` and `/notes` load on CloudFront post-invalidation
- [ ] Report: deployed what/where, smoke evidence, decisions, observed cost, pendings (manual mic test; v1.1 entity/RRF/rerank channel)
