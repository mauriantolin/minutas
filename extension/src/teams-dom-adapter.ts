/**
 * ISOLATED, FRAGILE MODULE. Everything that depends on the Teams PWA markup lives here so
 * that when Microsoft changes the DOM, only this file needs patching. Keep the public API
 * (readActiveSpeaker, readParticipants, readMeetingTitle, readLocalUserName,
 * captionsPresent, observeCaptions) stable.
 *
 * Selector provenance (v2 client, teams.microsoft.com — cross-checked against actively
 * maintained scrapers: Vexa "verified 2026-03", Zerg00s/Live-Captions-Saver 2026-02,
 * AWS live-meeting-assistant, Meeting-BaaS, joinly):
 * - Speaking = `div[data-tid="voice-level-stream-outline"]` carrying the
 *   `vdi-frame-occlusion` class (toggles while the person talks). Some builds draw the
 *   ring only on the ::before pseudo-element — computed-style fallback covers that.
 * - Name = `[data-tid="participant-info-nametag"]` inside the tile, else the tile's
 *   aria-label prefix ("Name, video is on, ..." → "Name").
 * - Captions = `closed-caption-renderer-wrapper` / `closed-caption-v2-window-wrapper`,
 *   per-utterance author `[data-tid="author"]` + text `[data-tid="closed-caption-text"]`
 *   (stable across host and guest views; `closed-captions-v2-items-renderer` is
 *   host-only — never rely on it alone).
 * - The minimized "call monitor" has NO published markup: nothing here may hold node
 *   references or assume the stage stays mounted. Every read re-queries document and
 *   same-origin iframes, so detection resumes the instant Teams re-mounts the tiles;
 *   while minimized, captions (if enabled) remain the naming signal.
 */

import type { CaptionEvent } from "@teams-agent-core/shared";

const SELECTORS = {
  // v2: the speaking ring lives on this element; class presence = speaking.
  voiceOutline: 'div[data-tid="voice-level-stream-outline"]',
  speakingClass: "vdi-frame-occlusion",
  // Classic (v1) client, kept as legacy fallback only.
  legacySpeakingTile: [
    '[data-tid="participant-speaker-ring"]',
    '[data-cid="calling-participant-stream"][class*="isSpeaking"]',
  ],
  // Tile ancestors that carry identity (v2 stage, consumer live, classic).
  tile: '[role="menuitem"], [data-tid="menur1j"], [data-cid="calling-participant-stream"]',
  nameTag: '[data-tid="participant-info-nametag"]',
  rosterRow:
    "[data-cid='roster-participant'][aria-label], [data-tid^='participantsInCall-']",
  meetingTitle: ['[data-tid="calling-title"]', '[class*="meeting-title"]'],
  localUserName: [
    '[data-tid="me-control-displayname"]',
    '[data-tid="me-control-display-name"]',
    '[data-tid="participant-info"] .fui-StyledText span',
    '[data-tid="myself-video"]',
  ],
  captionPane: [
    '[data-tid="closed-caption-renderer-wrapper"]',
    '[data-tid="closed-caption-v2-window-wrapper"]',
    '[data-tid="closed-captions-renderer"]',
    '[class*="closed-captions"]',
  ],
  captionItem: [
    '[data-tid="closed-caption-message"]',
    ".fui-ChatMessageCompact",
    ".ui-chat__item__message",
    '[class*="caption-item"]',
  ],
  captionAuthor: ['[data-tid="author"]', '[class*="author"]', '[class*="displayName"]'],
  captionText: ['[data-tid="closed-caption-text"]', '[class*="caption-text"]'],
};

// Partials mutate in place for a while; an utterance is considered final once no
// mutation touched its node for this long (or a newer caption node started mutating).
const CAPTION_STABLE_MS = 2500;

/** document + same-origin iframes (older v2 builds embedded the call in an iframe). */
function roots(): Document[] {
  const out: Document[] = [document];
  for (const frame of document.querySelectorAll("iframe")) {
    const doc = (frame as HTMLIFrameElement).contentDocument;
    if (doc) out.push(doc);
  }
  return out;
}

function firstMatch(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function nameOf(el: Element): string | null {
  for (const attr of ["data-tid-name", "aria-label", "data-tid"]) {
    const v = el.getAttribute(attr);
    if (v) return cleanName(v);
  }
  const text = el.textContent?.trim();
  return text ? cleanName(text) : null;
}

function cleanName(raw: string): string {
  // Aria labels read like "Juan Pérez, video is on, muted, Context menu is available".
  return raw
    .split(/[,·|]/)[0]
    .replace(/\b(is speaking|está hablando|muted|silenciado)\b.*$/i, "")
    .replace(/\(unverified\)/i, "")
    .trim();
}

function isSpeaking(outline: Element): boolean {
  if (outline.classList.contains(SELECTORS.speakingClass)) return true;
  // Some builds draw the ring purely on ::before (blue border at opacity 1) with no
  // class change — pseudo-elements fire no mutations, hence the polled style check.
  const style = getComputedStyle(outline, "::before");
  if (style.opacity !== "1") return false;
  const rgb = style.borderColor.match(/\d+/g);
  if (!rgb || rgb.length < 3) return false;
  const [r, g, b] = rgb.map(Number);
  return b > 180 && b > r + 40 && b > g + 40;
}

function tileNameOf(outline: Element): string | null {
  const tile = outline.closest(SELECTORS.tile) ?? outline.parentElement;
  const tag = tile?.querySelector(SELECTORS.nameTag)?.textContent?.trim();
  if (tag) return cleanName(tag);
  for (let el: Element | null = outline; el; el = el.parentElement) {
    const aria = el.getAttribute("aria-label");
    if (aria) {
      const name = cleanName(aria);
      if (name) return name;
    }
    if (el === tile) break;
  }
  return null;
}

/** Name of whoever Teams currently shows as the active speaker, or null. */
export function readActiveSpeaker(): string | null {
  for (const root of roots()) {
    for (const outline of root.querySelectorAll(SELECTORS.voiceOutline)) {
      // Virtualized stages leave 0×0 recycled phantom tiles behind — skip them.
      const host = (outline.closest(SELECTORS.tile) ??
        outline.parentElement) as HTMLElement | null;
      if (host && host.clientWidth === 0 && host.clientHeight === 0) continue;
      if (!isSpeaking(outline)) continue;
      const name = tileNameOf(outline);
      if (name) return name;
    }
    const legacy = firstMatch(root, SELECTORS.legacySpeakingTile);
    if (legacy) {
      const name = nameOf(legacy);
      if (name) return name;
    }
  }
  return null;
}

/** Every display name visible right now (stage nametags + roster pane if open). */
export function readParticipants(): string[] {
  const names = new Set<string>();
  for (const root of roots()) {
    root.querySelectorAll(SELECTORS.nameTag).forEach((el) => {
      const text = el.textContent?.trim();
      if (text) names.add(cleanName(text));
    });
    root.querySelectorAll(SELECTORS.rosterRow).forEach((el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) names.add(cleanName(aria));
    });
  }
  names.delete("");
  return [...names];
}

export function readMeetingTitle(): string {
  for (const root of roots()) {
    const el = firstMatch(root, SELECTORS.meetingTitle);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return document.title || "Reunión de Teams";
}

/** Best-effort local user name; the backend also falls back to the JWT name claim. */
export function readLocalUserName(): string {
  for (const root of roots()) {
    for (const sel of SELECTORS.localUserName) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const name = cleanName(
        el.textContent?.trim() || el.getAttribute("aria-label") || "",
      );
      if (name) return name;
    }
  }
  return "";
}

/** Capture-start self-test: is the live-captions pane in the DOM? Feeds signalHealth. */
export function captionsPresent(): boolean {
  for (const root of roots()) {
    if (firstMatch(root, SELECTORS.captionPane)) return true;
  }
  return false;
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
