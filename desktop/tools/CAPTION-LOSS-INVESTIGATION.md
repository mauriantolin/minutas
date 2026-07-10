# Desktop caption loss — root-cause investigation

**Symptom:** the desktop (WPF/UIA) transcript omitted much of what the live Teams captions showed.

**Method:** static analysis of `TeamsCaptionWatcher.cs` + a faithful Python port of its gates,
replayed over a **real UIA dump** (`~/inbox/teams-uia-dump.jsonl`, 2 snapshots 14 s apart of a
real Spanish-tenant meeting). Everything below marked *[measured]* is evidence from that dump;
*[needs Windows]* requires a real meeting to confirm.

---

## 1. The central hypothesis is REFUTED *[measured]*

> "The captions pane retains only the last ~2-3 lines; anything that scrolls between two 750 ms
> polls is lost irrecoverably at the source."

The real dump shows the RootWebArea `patternText` caption region holds **~20 lines** of history,
not 2-3. Between the two snapshots (14.2 s apart) the buffer advanced only ~2 lines and gained
**1** genuinely new line. So:

- Buffer depth ≈ **20 utterances** ≈ 60-140 s of history at normal pace.
- For a line to vanish between two 750 ms polls, ~20 new lines would have to be produced in
  750 ms — impossible.
- **Therefore polling-gap loss at the source is essentially zero.** The 750 ms poll is not the
  problem, and raising the poll rate (option D) fixes almost nothing.

Per-snapshot **extraction is faithful** too: replaying `GetCaptionCandidates` +
`ConvertCandidatesToCaptions` over each snapshot recovers **all ~20 caption lines** with correct
speaker attribution *[measured]*. And downstream (`CaptureSessionService.OnCaptionFinal` →
segments → flush) **never dedups or drops** — it appends every event *[measured]*.

So the loss is neither the source, nor per-frame extraction, nor the backend. It is in **two
whole-region rejection gates** and **one refinement-handling defect**.

---

## 2. Pipeline map + where it loses

```
Teams RootWebArea.patternText (~20-line buffer, U+FFFC-separated)   <- NOT lossy [measured]
      │
      ▼  GetActiveCaptionRoots + IsMeetingSurface gate
      │      ✗ LOSS #1 [ROOT_GATE]  — rejects the whole root when the meeting toolbar
      │        auto-hides (idle mouse). Score 12 → 0 with controls gone. [measured/simulated]
      ▼  GetCaptionCandidates (start = English marker OR first bare "Name (Org)" tag)
      │      ✗ LOSS #2 [EXTRACTION] — returns [] when no "Name (Org)" tag exists
      │        (guests without org, one-word names) on a non-English tenant → 0 captions.
      │        [measured: English markers already absent; survives only via the tag fallback]
      ▼  ConvertCandidatesToCaptions (+ chrome learning: baseline 3 s / persistence 15 s)
      │      ~ minor: first snapshot discarded as baseline; rare false-chrome learning
      ▼  GetNewSnapshotItems (dedup by exact Speaker|Text)
      │      ~ dedups legitimately-repeated identical short lines ("Sí." "Sí.") [minor]
      ▼  SubmitObservation + IsRevision (prefix-only) + PublishIfStable (2 s)
      │      ✗ DEFECT #3 — Teams refines captions NON-prefix (rewrites words); IsRevision
      │        requires StartsWith → treats each refinement as a new line → emits garbled
      │        partials + duplicates instead of merging. [measured on a real pair]
      ▼  CaptionFinal → OnCaptionFinal → segments → flush   <- NOT lossy [measured]
```

### Loss #1 — root gate rejects captions when the toolbar auto-hides *(primary suspect for the reported omission)*
`IsMeetingSurface` needs a score ≥ 5 built entirely from **meeting-control** keywords (Salir,
Compartir contenido, Silenciar…). With the toolbar visible the dump scores **12**. Teams
auto-hides that toolbar after ~5 s of mouse inactivity. Removing those chunks drops the score to
**0** → the root is rejected → `ReadSnapshot` yields nothing → **every caption in that poll is
dropped**, even though the caption text is still sitting in `patternText`. A long meeting where
you don't wiggle the mouse loses large contiguous stretches — exactly the reported symptom.
*[measured that score→0 when controls removed; NEEDS WINDOWS to confirm Teams actually removes
the strings from the UIA tree vs merely hiding them with CSS.]*

### Loss #2 — extraction returns empty without a "Name (Org)" anchor
`GetCaptionCandidates` finds the caption region start via an **English-only** marker
(`Live Captions` / `Invite people to join you`) or, as fallback, the **first bare `Name (Org)`
line**. On the Spanish tenant the English markers are already absent *[measured]*; the pipeline
survives only because a tile nametag `Yanina Gonzalez (Semantix)` happens to match. Strip org
attribution (external guests "Desconocido externo", one-word names, tenants that don't render
"(Org)") and **both anchors fail → `[]` → zero captures** for the whole time that composition
holds *[measured by removing "(Semantix)"]*.

### Defect #3 — non-prefix refinement → duplicates/garble (not omission, but corruption)
Real pair from the dump: `"Sí después veo cuál es no sé cuál"` → `"Sí, después veo cuál es. No sé
cuál es."`. `IsRevision` is prefix-only (`StartsWith`), so it returns **False** *[measured]* and
the two are emitted as separate lines. The extension's own comment says the ASR **rewrites**
words in place; the desktop's merge model assumes append-only. Result: garbled mid-refinement
partials and duplicate lines (matches the open B3 "double-capture" note).

---

## 3. Root cause

**Primary:** the desktop reconstructs captions from a flat, chrome-polluted `patternText` dump and
defends against that pollution with **heuristic region gates** (`IsMeetingSurface` root gate +
`GetCaptionCandidates` speaker-anchored start). Those gates are coupled to **transient, locale-,
and roster-dependent UI state** (toolbar visibility, "(Org)" attribution, English strings). When
that state shifts mid-meeting, a gate silently rejects a whole region and captions that are
physically present in the tree are never read. This is an **architecture** problem (Phase 4.5:
each heuristic patch moves the failure, it doesn't remove it), not a single bug.

**Contributing:** append-only `IsRevision` corrupts refined lines (defect #3).

**Not the cause:** poll interval / source scroll (refuted), per-frame extraction, backend.

---

## 4. Alternatives, ranked

| # | Option | Removes which loss | Robustness (locale/tenant/version) | Effort | Risk |
|---|--------|--------------------|-----------------------------------|--------|------|
| **C** | **WebView2 shell hosting Teams + inject `observeCaptions`** | #1, #2, #3, source — *all* | **High** — same DOM engine as the extension, no chrome heuristics, no UIA gates | High | Med (UX change: capture happens in our window; Teams ToS/SSO to validate) |
| **B** | Force renderer accessibility (`--force-renderer-accessibility`) so caption DOM appears as discrete UIA `author`+`text` nodes; read structurally | #1, #2, #3 | Med-High — structural read kills the gates, but depends on being able to force AXMode on the Teams process | Med | Med — may not be forceable on the packaged Teams/WebView2; **take a NEW probe to confirm** |
| **B′/A** | Keep UIA text but (a) drop the `IsMeetingSurface` root gate in favor of a caption-only signal, (b) anchor `GetCaptionCandidates` on the caption-pane chrome (localized) not the speaker tag, (c) fix `IsRevision` to fuzzy/replace, (d) add UIA `TextChanged` events instead of pure polling | #1, #2, #3 (mitigate) | Med — still heuristic, still one Teams redesign from breaking | **Low-Med** | Low | 
| **E** | Native Teams transcript / `.vtt` / Graph API, or a mature scraper (Live-Captions-Saver, Vexa) | source of truth | High if available; but requires cloud recording / admin / different consent model | Med-High | Med (licensing, tenant policy) |
| **D** | Just raise poll rate / scan sub-region | ~nothing (source isn't the loss) | n/a | Low | Low — **do not ship as the fix**; useful only as a ground-truth probe |

Notes on A/B/E robustness for **white-label**: B′ still hard-codes locale strings (fragile per the
brief); C and B inherit the extension's cross-checked selectors and are locale-independent, which
is why they rank above the heuristic patch despite more effort.

---

## 5. Recommendation + phased plan

**Target architecture: C (WebView2 + `observeCaptions`)** — one caption engine shared with the
extension, lossless, locale/tenant/name-independent. But it needs the two Windows confirmations
below before committing, so ship the low-risk stop-the-bleeding fixes first.

- **Phase 0 — measure (this deliverable).** Run the ground-truth capture (section 6) on the next
  real meeting *including a >15 s no-mouse stretch and a guest without "(Org)"*. Get the actual
  recall % and the loss-attribution histogram. Confirms #1 (ROOT_GATE) and #2 (EXTRACTION) with
  numbers before touching code.
- **Phase 1 — stop the bleeding (B′/A, low risk, ~1 day).**
  1. **Remove the `IsMeetingSurface` root gate as a hard filter**; keep a root if it has
     *caption-like* text (`hasCaptions` / caption-pane chrome) regardless of toolbar controls.
     This alone should recover Loss #1.
  2. **Anchor `GetCaptionCandidates` on the caption-pane chrome** (add localized
     "Subtítulos en directo"/"Live captions" region markers) with the speaker tag as a *secondary*
     fallback — recover Loss #2 for guests/one-word names.
  3. **Fix `IsRevision`** to treat same-speaker in-place rewrites as revisions (similarity ratio /
     longest-common-prefix-ratio, not strict `StartsWith`) — kill the garble/dup from defect #3.
  4. Add UIA `TextPattern.TextChanged` / `StructureChanged` handlers (option A) to complement
     polling — cheaper and lower-latency, though not required for correctness given the deep buffer.
- **Phase 2 — validate the target (needs Windows).**
  - Take a **new probe with `--force-renderer-accessibility`** on the Teams process; confirm the
    caption DOM surfaces as discrete `author`+`text` UIA nodes. If yes → option **B** is a cheaper
    path to the same losslessness than C.
  - Spike **C**: a WebView2 window that loads teams.microsoft.com and injects the existing
    `observeCaptions`. Validate SSO/login and ToS.
- **Phase 3 — migrate** to B or C based on Phase 2, retire the heuristic gates.

---

## 6. Ground-truth capture kit (in `desktop/tools/`, ready to reuse)

Two series, same meeting, same clock → recall + per-stage loss:

1. **Desktop's raw view** — `Log-TeamsCaptionGroundTruth.ps1` (Windows). High-frequency (250 ms)
   lossless logger of the RootWebArea `patternText`, preserving U+FFFC. Leave a >15 s no-mouse
   stretch and have a guest without "(Org)" present.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Log-TeamsCaptionGroundTruth.ps1 -DurationSeconds 900
   ```
2. **Reference truth** — `groundtruth-devtools-observer.js` (paste in Teams tab DevTools, captions
   ON). Event-driven mirror of the extension's `observeCaptions`; `__gt.stop()` downloads
   `teams-truth-*.json`. (Alternative: Zerg00s/Live-Captions-Saver, normalized to the same shape.)
3. **Analyze (Linux)** — `Analyze-CaptionRecall.py` replays the real C# gates over the raw log,
   simulates the 750 ms cross-poll pipeline, and attributes every missing truth line to
   SOURCE / ROOT_GATE / EXTRACTION / PIPELINE.
   ```bash
   python3 Analyze-CaptionRecall.py --raw 'teams-groundtruth-*.jsonl' --truth 'teams-truth-*.json'
   ```

The analyzer's port of the gates is kept 1:1 with `TeamsCaptionWatcher.cs`; update both together.
