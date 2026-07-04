/**
 * ISOLATED, FRAGILE MODULE. Everything that depends on the Teams PWA markup lives here so
 * that when Microsoft changes the DOM, only this file needs patching. Keep the public API
 * (readActiveSpeaker, readMeetingTitle, readLocalUserName, captionsPresent, observeCaptions)
 * stable.
 *
 * Two signals live here:
 * - Active-speaker ring: Teams marks the participant currently speaking with a visual
 *   "speaking" ring on their video/roster tile; we read the name off that tile (polled,
 *   fallback signal when captions are off).
 * - Live captions: MutationObserver over the caption pane, on-mutation only — Teams
 *   virtualizes and prunes old caption nodes, so re-scanning the pane misses utterances.
 *
 * Selectors are best-effort with fallbacks; verify against live Teams and adjust the
 * SELECTORS below if they drift.
 */

import type { CaptionEvent } from "@teams-agent-core/shared";

const SELECTORS = {
  // Tiles flagged as actively speaking (data-tid / aria patterns seen in the Teams PWA).
  speakingTile: [
    '[data-tid="participant-speaker-ring"]',
    '[class*="speaking"]',
    '[data-cid="calling-participant-stream"][class*="isSpeaking"]',
  ],
  // Where a tile carries the display name.
  nameAttr: ["data-tid-name", "aria-label", "data-tid"],
  meetingTitle: ['[data-tid="calling-title"]', '[class*="meeting-title"]', "title"],
  // Live-captions pane and its per-utterance children (Teams PWA closed-captions renderer).
  captionPane: [
    '[data-tid="closed-captions-renderer"]',
    '[data-tid="closed-caption-v2-window-wrapper"]',
    '[class*="closed-captions"]',
  ],
  captionItem: [
    '[data-tid="closed-caption-message"]',
    ".fui-ChatMessageCompact",
    '[class*="caption-item"]',
  ],
  captionAuthor: ['[data-tid="author"]', '[class*="author"]', '[class*="displayName"]'],
  captionText: ['[data-tid="closed-caption-text"]', '[class*="caption-text"]'],
};

// Partials mutate in place for a while; an utterance is considered final once no
// mutation touched its node for this long (or a newer caption node started mutating).
const CAPTION_STABLE_MS = 2500;

function firstMatch(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function nameOf(el: Element): string | null {
  for (const attr of SELECTORS.nameAttr) {
    const v = el.getAttribute(attr);
    if (v) return cleanName(v);
  }
  const text = el.textContent?.trim();
  return text ? cleanName(text) : null;
}

function cleanName(raw: string): string {
  // Aria labels often read like "Juan Pérez is speaking" / "Juan Pérez, muted".
  return raw
    .replace(/\b(is speaking|está hablando|muted|silenciado)\b.*$/i, "")
    .replace(/[,·|].*$/, "")
    .trim();
}

/** Name of whoever Teams currently shows as the active speaker, or null. */
export function readActiveSpeaker(): string | null {
  const tile = firstMatch(document, SELECTORS.speakingTile);
  return tile ? nameOf(tile) : null;
}

export function readMeetingTitle(): string {
  const el = firstMatch(document, SELECTORS.meetingTitle);
  return el?.textContent?.trim() || document.title || "Reunión de Teams";
}

/** Best-effort local user name; the backend also falls back to the JWT name claim. */
export function readLocalUserName(): string {
  const el = document.querySelector('[data-tid="me-control-display-name"]');
  return el?.textContent?.trim() || "";
}

/** Capture-start self-test: is the live-captions pane in the DOM? Feeds signalHealth. */
export function captionsPresent(): boolean {
  return firstMatch(document, SELECTORS.captionPane) !== null;
}

type Utterance = { t: number; speakerName: string; text: string };

/**
 * Watches the caption pane and emits one final CaptionEvent per utterance.
 *
 * - `now()` supplies seconds-from-capture-start (same clock as the ASR segments).
 * - `onFinal` fires once per utterance, with `t` = when the utterance first appeared.
 * - `onHeartbeat` fires on every caption mutation (partial or final) — the liveness
 *   signal behind `captionHeartbeatLastT`.
 *
 * Observes document.body so captions enabled mid-meeting (or a re-created pane) are
 * picked up without re-arming; per-record filtering keeps the hot path cheap.
 */
export function observeCaptions(
  now: () => number,
  onFinal: (e: CaptionEvent) => void,
  onHeartbeat: () => void,
): () => void {
  const itemSel = SELECTORS.captionItem.join(",");
  const paneSel = SELECTORS.captionPane.join(",");
  const tracked = new Map<Element, Utterance>();
  // Last finalized text per node: a node mutating again after the stability
  // window re-enters tracking, and re-emitting its full text would duplicate
  // caption content — emit only the appended delta.
  const finalized = new WeakMap<Element, string>();
  let activeItem: Element | null = null;
  let stabilityTimer: number | undefined;

  const finalize = (item: Element) => {
    const u = tracked.get(item);
    tracked.delete(item);
    if (item === activeItem) activeItem = null;
    if (!u) return;
    const prevText = finalized.get(item);
    finalized.set(item, u.text);
    if (prevText !== undefined && u.text.startsWith(prevText)) {
      const delta = u.text.slice(prevText.length).trim();
      if (delta) onFinal({ t: u.t, speakerName: u.speakerName, text: delta, final: true });
      return;
    }
    onFinal({ ...u, final: true });
  };

  const touch = (item: Element) => {
    const text = firstMatch(item, SELECTORS.captionText)?.textContent?.trim();
    if (!text) return;
    onHeartbeat();
    const prev = tracked.get(item);
    const author = firstMatch(item, SELECTORS.captionAuthor)?.textContent;
    const speakerName = (author && cleanName(author)) || prev?.speakerName;
    // No author node ever seen for this item: an unattributable final would
    // anchor downstream speaker labels to a fake name — drop it.
    if (!speakerName) return;
    tracked.set(item, { t: prev?.t ?? now(), speakerName, text });
    if (activeItem && activeItem !== item) finalize(activeItem);
    activeItem = item;
    clearTimeout(stabilityTimer);
    stabilityTimer = window.setTimeout(() => finalize(item), CAPTION_STABLE_MS);
  };

  // The pane selector guard keeps chat messages (same fui-* classes) out.
  const itemOf = (node: Node): Element | null => {
    const el = node instanceof Element ? node : node.parentElement;
    const item = el?.closest(itemSel) ?? null;
    return item?.closest(paneSel) ? item : null;
  };

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const item = itemOf(rec.target);
      if (item) touch(item);
      for (const added of rec.addedNodes) {
        const it = itemOf(added);
        if (it) {
          if (it !== item) touch(it);
        } else if (added instanceof Element) {
          // Pane just rendered (captions enabled mid-meeting): seed from the utterances
          // it came with — this is the pane's initial content, not a re-scan. The added
          // node may BE the pane, not just contain it.
          const pane = added.matches(paneSel)
            ? added
            : added.querySelector(paneSel);
          pane?.querySelectorAll(itemSel).forEach((el) => touch(el));
        }
      }
    }
    // Teams prunes old caption nodes; a pruned utterance is final by definition.
    for (const el of [...tracked.keys()]) {
      if (!el.isConnected) finalize(el);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  return () => {
    observer.disconnect();
    clearTimeout(stabilityTimer);
    for (const el of [...tracked.keys()]) finalize(el);
  };
}
