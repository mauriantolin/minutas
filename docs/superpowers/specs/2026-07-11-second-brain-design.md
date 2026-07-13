# Second Brain — account-level chat over meetings + personal notes with voice capture

**Date:** 2026-07-11
**Status:** Approved design (pre-implementation)

## 1. Goal

An account-level ("second brain") chat where a user asks questions across **all** their tenant's captured meetings and their **personal notes**, with answers grounded in sources (deep-links to `/meeting?id=X` with `[Tn]` turn anchors, or to notes). Plus a notes module: typed or dictated (mic button in the web dashboard) personal notes that join the same retrieval corpus.

Product constraints confirmed with the user:

- **Multi-tenant product** — strict tenant isolation in index and retrieval.
- **Design for growth** — semantic retrieval (embeddings) from day 1; thousands of meetings per tenant.
- **Voice capture lives in the web dashboard** (desktop/extension later if useful).
- **Voice notes store both** the raw transcription and an LLM-cleaned version (title + structured text); the cleaned version is what gets embedded.
- Bedrock-only LLM stack, Spanish UI/content, white-label (no client/brand references).

## 2. Decision: embeddings — yes, via S3 Vectors (no Bedrock KB, no OpenSearch)

At hundreds-to-thousands of meetings per tenant (~10k tokens per 1h meeting), whole-corpus-in-context is not viable; semantic retrieval is required. Vector store choice:

- **Amazon S3 Vectors** (GA since Dec 2025, us-east-1): serverless, ~$0 idle (~$0.06/GB-mo storage, pay-per-query), per-index ARNs enable hard IAM isolation. Chosen.
- OpenSearch Serverless (~$350/mo idle) and Aurora pgvector (cold-resume friction or always-on cost) rejected on cost floor.
- **Bedrock Knowledge Bases rejected**: its managed chunker is not turn-aware (would destroy the `[Tn]`/chapter structure that is this corpus's main asset), custom metadata is capped, ingestion via sync jobs doesn't fit per-document indexing at publish, and we'd only use `Retrieve` anyway. DIY is two SDK calls (`PutVectors`/`QueryVectors`).

### Layout & tenancy

- One vector bucket in the CDK stack; **one index per tenant**: `tenant-{tenantId}-v{INDEX_VERSION}`, created lazily on first write.
- Index name derived **exclusively** from the JWT `custom:tenantId` claim (fallback `sub`), never from client input. Defense-in-depth: IAM condition scoping `s3vectors:QueryVectors` on the chat Lambda role by ARN pattern.
- Per-tenant indexes also make queries cheaper: S3 Vectors query cost scales with the size of the *queried* index.
- **Index config is immutable** (dims/metric/model). Mitigations from day 1: `INDEX_VERSION` constant + blue/green migration (create `-v{n+1}`, backfill, swap config pointer stored as DDB item `SK=CONFIG#INDEX` per tenant, delete old); `embedVersion` in vector metadata.

### Embedding model

Default **Titan Text Embeddings V2, 1024 dims, cosine** ($0.02/1M tokens, multilingual). Before creating any index, run an **eval gate**: 20–30 golden Spanish Q&A pairs, Titan V2 vs Cohere Embed Multilingual v3. If Cohere wins clearly, adopt it (backfill delta ≈ $13 one-time). Note: Titan `InvokeModel` takes one text per call — indexing throughput uses per-text calls with bounded concurrency, not batching.

### Vector metadata

- **Filterable** (≤2 KB): `type` (`chapter|extraction|summary|digest|note`), `meetingId`, `dateEpoch`, `ownerSub` (notes only), `embedVersion`.
- **Non-filterable**: `text` (the chunk), `title`, `chapterTitle`, `turnStart`, `turnEnd`, `noteId` — retrieval returns chunk text directly, no per-chunk S3 GETs.
- Open item (flagged unverified): the exact native `s3vectors` filter operator grammar (OR-across-conditions) must be verified during implementation. Fallback that works regardless: per-tenant index + equals-filter on `ownerSub` for the notes-privacy condition.

## 3. Chunking (structural, exploits existing artifacts)

Sources per meeting under S3 `{tenantId}/{meetingId}/`; deterministic vector keys; the emitted key list is stored in DDB (`SK=IDX#MEETING#{id}` / `IDX#NOTE#{id}`) for exact delete/reindex.

| Source | Chunks | Key pattern |
|---|---|---|
| `extraction.json` | **Micro-chunks: one vector per decision/actionItem/openQuestion/keyNumber**, rendered as `Decisión ({fecha}, reunión "{title}"): {text} — cita: "{verbatim}" [T{n}]` | `{meetingId}#ex#{kind}#{i}` |
| `transcript.clean.json` | One per chapter (split ~300–700 tokens, 1-turn overlap), **contextualized header** prepended before embedding: `Reunión: "{title}" — {fecha} — Capítulo: "{chapterTitle}"` | `{meetingId}#ch#{n}` |
| `summary.json` | Split by H2 heading | `{meetingId}#sum#{n}` |
| Meeting digest | 1 vector: title + date + participants + keyPoints | `{meetingId}#dig` |
| Note (`cleanText`) | 1 per note (split ~500–800 tokens if long), header `Nota personal — {fecha} — {title}` | `note#{noteId}#{n}` |

≈ 30 vectors per 1h meeting. Extraction micro-chunks are the precision channel for the dominant query shape ("¿qué decidimos sobre X?") and carry ready-to-cite turn ids.

## 4. Indexing flow

- New lib `backend/src/lib/brain/` (`chunker.ts`, `embed.ts`, `vectorstore.ts`): `indexMeeting(tenantId, meetingId)`, `indexNote(...)`, `deleteDoc(...)`.
- **Pipeline hook: new `IndexMeeting` state in the Step Function after Publish**, with Catch → mark `indexStatus: failed` on the meeting item. Failures are visible/retryable in the state machine and never block publish.
- **Notes**: indexed inline in the notes handler right after LLM cleanup; edit → re-embed + overwrite same keys; delete → `DeleteVectors` using the stored `IDX#` key list.
- **Backfill**: `POST /admin/reindex` (admin group) — paginates the tenant's meetings, skips items with current `indexVersion`, concurrency 3–5 (Bedrock rate limits), resumable and idempotent (deterministic keys + overwrite). Doubles as the blue/green migration mechanism.

## 5. Chat backend

**Routes** (new `backend/src/handlers/brain.ts`, behind the existing Cognito JWT authorizer):

- `POST /brain/ask` — `{threadId?, message}` → `{threadId, answer_md, citations[], usage}`
- `GET /brain/threads`, `GET /brain/threads/{id}`, `DELETE /brain/threads/{id}`

**Per-query flow** (p50 ~7s, comfortably under the ~29s API GW cap):

1. Load thread (last ~6–10 turns) if `threadId` present.
2. **Planner — one Haiku forced-tool call** (~1s): `{searchQuery (self-contained Spanish rewrite using the thread), timeRange?, timeIsExplicit, targetTypes?}`. Resolves anaphoric follow-ups and temporality. **Rule: inferred filters are boosts; hard `dateEpoch` filters only when temporality is explicit.**
3. Embed rewrite → `QueryVectors` on the tenant index, topK≈15, notes-privacy filter injected server-side (`ownerSub` = caller for `type=note`).
4. Answer with **Haiku via `backend/src/lib/agent.ts` conventions**: cached stable system block, forced tool `{answer_md, citations[]}`, Spanish output, instruction to prefer the most recent decision and flag changes over time, and to say plainly when the corpus doesn't cover the question.
5. Citations `[M:{meetingId}:T{n}]` and `[N:{noteId}]` mapped to `{title, date, url}`; frontend renders links.
6. Persist thread.

- **Single-shot, no streaming in v1** (HTTP API v2 cannot stream — verified). UI compensates with staged status ("Buscando… / Leyendo fragmentos… / Redactando…"). Documented upgrade path: Lambda Function URL `RESPONSE_STREAM` behind CloudFront, JWT validated in-function — only this route would migrate.
- **Threads in DDB** (same table, no GSI): `PK=TENANT#{t}`, `SK=THREAD#{userSub}#{ulid}` — one item per thread `{title, messages[], updatedAt}`, append via UpdateExpression, cap ~40 messages (UI suggests a new thread).
- **Deferred to v1.1** (interfaces kept compatible): entity channel (exact names/codes — first upgrade), RRF fusion, Haiku listwise rerank, streaming.

## 6. Notes module

DDB items, same table:

```
PK = TENANT#{tenantId}
SK = NOTE#{userSub}#{ulid}
attrs: title, rawText, cleanText, source: "typed"|"voice",
       createdAt, updatedAt, indexVersion, (key list in IDX#NOTE#{id})
```

- `POST /notes` `{rawText, source}` → one Haiku forced-tool call (`clean_note` → `{title, cleanText}`) → store **both** → index clean version → return note.
- `GET /notes` (Query `begins_with(NOTE#{sub}#)`, ULID = chronological), `GET/PUT/DELETE /notes/{id}`; PUT re-indexes.
- Notes are private to the user: sub in the sort key + server-injected retrieval filter.

## 7. Voice capture (web)

**Amazon Transcribe Streaming over WebSocket from the browser**, using the **already-granted, unused Identity Pool permission** (`transcribe:StartStreamTranscriptionWebSocket`) and `@aws-sdk/client-transcribe-streaming` (`es-ES`/`es-US`, live partials). New hook `web/lib/use-transcribe-stream.ts` (mic → AudioWorklet PCM 16-bit → SDK).

Why streaming (not the existing batch path): the batch path is coupled to the meeting-pipeline consent gate; streaming needs **zero new backend** and gives live-partials UX. Client POSTs the final transcript to `/notes` as `rawText`; **audio is never stored** (deliberate: less PII). Cost delta vs batch is noise (~$0.01/min).

## 8. Web UI

- New top-level routes `web/app/(shell)/brain/page.tsx` and `web/app/(shell)/notes/page.tsx` + **mandatory `SpaRewriteFn` edit** in `infra/lib/teams-agent-core-stack.ts`.
- **Extract chat primitives** from `web/components/meeting/qa-tab.tsx` into `web/components/chat/` (message list, composer, staged status, markdown-with-anchors); `qa-tab` becomes a consumer. Markdown renderer extended: `[M:id:Tn]` → `/meeting?id={id}&turn=T{n}`, `[N:id]` → `/notes?id={id}`.
- Transcript tab: support `?turn=Tn` scroll + highlight so deep-links land.
- `/brain`: chat + threads sidebar + SourceCards per answer (chip Reunión/Nota, title, date, deep-link).
- `/notes`: list + editor (tabs "Limpia"/"Original", both editable) + `mic-button.tsx` with live transcript and "Limpiar con IA".
- `web/lib/api.ts` wrappers; Cmd+K entries ("Preguntar a la memoria", "Notas", "Nueva nota de voz"). Spanish strings, English identifiers, neutral white-label naming ("Memoria"/"Asistente").

## 9. Cost (10 tenants × 1000 meetings + 500 notes, 50 queries/day total)

- Idle floor: **~$0.10/mo** (vector storage). One-time backfill embeddings: ~$3 (Titan) / ~$13 (Cohere).
- Realistic recurring: **$20–60/mo**, dominated by answer-LLM (~$0.01/query Haiku) and Transcribe streaming for dictation. Vector layer is rounding noise. If usage is 50 q/day *per tenant*, LLM scales ×10; infra still noise.

## 10. Risks & open items

1. **No BM25/hybrid in v1** — exact codes/rare names can miss; extraction micro-chunks concentrate the most-queried facts; entity channel is the planned v1.1 add.
2. **CFN/CDK support for `AWS::S3Vectors::*`** — **RESOLVED 2026-07-13:** supported — `CfnVectorBucket` L1 lands in aws-cdk-lib ≥2.223.0 (repo locks 2.261.0); indexes stay lazy via SDK.
3. **Native s3vectors filter grammar** — **RESOLVED 2026-07-13:** grammar supports `$or` across conditions, so the notes-privacy filter is one native query; caveat: `QueryVectors` with `filter` also needs `s3vectors:GetVectors` in IAM.
4. **29s ceiling** — instrument per-stage budgets; reduce topK before escalating models.
5. **Titan V2 Spanish quality** — **RESOLVED 2026-07-13:** Titan V2 1024/cosine adopted now; eval harness at `scripts/brain-eval.mjs` ready to run once a golden corpus exists; `INDEX_VERSION` covers any migration.
6. **Tenant isolation is backend-derived** — mandatory **cross-tenant integration test**: tenant A's query must return zero of tenant B's documents; unit tests on index-name derivation and notes `ownerSub` filter.

## 11. Testing

- Unit: chunker (turn/chapter fidelity, `[Tn]` preservation), index-name derivation from JWT, notes privacy filter, citation post-processing.
- Integration: cross-tenant isolation test (§10.6), index→query round-trip on a fixture meeting, backfill idempotency.
- Eval: golden Spanish Q&A set (20–30 pairs) run pre-index (model gate) and re-runnable post-changes.
- Web: dictation flow manually verified in browser (dev server) before reporting done.

## 12. Files to touch (summary)

`infra/lib/teams-agent-core-stack.ts` (vector bucket, SFN `IndexMeeting` state, routes, IAM, SpaRewriteFn) · `backend/src/lib/brain/{chunker,embed,vectorstore}.ts` (new) · `backend/src/handlers/{brain,notes,indexer}.ts` (new) · `backend/src/handlers/admin.ts` (reindex) · `backend/src/lib/agent.ts` (extend: planner/clean_note/answer tools) · `packages/shared/src/types.ts` (Note, BrainThread types) · `web/app/(shell)/{brain,notes}/` (new) · `web/components/chat/` (extracted) · `web/components/notes/` (new) · `web/components/meeting/qa-tab.tsx` (refactor to consume chat primitives) · `web/lib/{api.ts,use-transcribe-stream.ts}` · `web/components/command-palette.tsx`.
