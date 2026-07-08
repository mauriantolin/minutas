/**
 * ISOLATED, FRAGILE MODULE. Everything that depends on the Teams PWA markup lives here so
 * that when Microsoft changes the DOM, only this file needs patching. Keep the public API
 * (readActiveSpeaker, readParticipants, readMeetingTitle, readLocalUserName,
 * captionsPresent, observeCaptions, meetingPresent, observeMeetingPresence,
 * enableCaptions) stable.
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
  // In-call only: the hangup button IS the meeting signal (verified against
  // Zerg00s/Live-Captions-Saver 2026-02).
  hangup: [
    "#hangup-button",
    'button[data-tid="hangup-main-btn"]',
    '[data-tid="hangup-leave-button"]',
    '[data-tid="hangup-end-meeting-button"]',
    'button[aria-label="Salir"]',
    'button[aria-label="Leave"]',
    '[aria-label*="Salir"]',
    '[aria-label*="Colgar"]',
    '[aria-label*="Leave"]',
    '[aria-label*="Hang up"]',
  ],
  // Documented menu path to turn live captions on programmatically.
  moreButton: ['button[data-tid="more-button"]', "#callingButtons-showMoreBtn"],
  languageSpeechMenu: ["#LanguageSpeechMenuControl-id"],
  captionsToggle: ["#closed-captions-button"],
};

// Accessible-name fallbacks (ES/EN). UIA Name == DOM accessible name, so these strings
// come straight from a real v2 meeting dump and match aria-label/title/text.
const CAPTIONS_ON_NAMES = ["ocultar subtítulos", "ocultar subtitulos", "hide live captions", "hide captions"];
const TURN_ON_NAMES = ["activar subtítulos", "activar subtitulos", "turn on live captions", "turn on captions", "mostrar subtítulos", "mostrar subtitulos", "show live captions", "show captions"];
const MORE_MENU_NAMES = ["más opciones", "mas opciones", "more options", "more call options", "más", "more"];
const LANGUAGE_MENU_NAMES = ["idioma y voz", "idioma y habla", "language and speech", "language & speech"];
const CAPTION_PANE_NAMES = ["subtítulos en directo", "subtitulos en directo", "live captions"];

// A caption line superseded by a newer one gets this grace to absorb its last
// in-place refinement before we emit its verbatim text; prune/stop are immediate.
const CAPTION_SETTLE_MS = 1200;

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

const SURFACE_TITLE = /^\s*(?:\(\d+\)\s*)?(?:Chat|Calendar|Calendario|Planner|Activity|Actividad|Files|Archivos|Calls|Llamadas|Tasks|Tareas|Home|Inicio|Apps|Aplicaciones|Store|Tienda)\s*\|/i;

export function readMeetingTitle(): string {
  for (const root of roots()) {
    const el = firstMatch(root, SELECTORS.meetingTitle);
    const text = el?.textContent?.trim();
    if (text && !SURFACE_TITLE.test(text)) return text;
  }
  return "Reunión de Teams";
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
    // Region-scoped so the "Activar subtítulos" menu item can't be mistaken for the pane.
    for (const el of root.querySelectorAll(
      "[role='region'], [role='log'], [role='complementary']",
    )) {
      const label = (el.getAttribute("aria-label") ?? "").trim().toLowerCase();
      if (label && CAPTION_PANE_NAMES.some((n) => label.includes(n))) return true;
    }
  }
  return false;
}

function accessibleName(el: Element): string {
  return (
    el.getAttribute("aria-label") ||
    (el as HTMLElement).title ||
    el.textContent ||
    ""
  )
    .trim()
    .toLowerCase();
}

function findByName(root: ParentNode, needles: string[]): HTMLElement | null {
  const els = root.querySelectorAll<HTMLElement>(
    "button, [role='button'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [aria-label], [title]",
  );
  for (const el of els) {
    const label = accessibleName(el);
    if (label && needles.some((n) => label.includes(n))) return el;
  }
  return null;
}

function clickByName(needles: string[]): boolean {
  for (const root of roots()) {
    const el = findByName(root, needles);
    if (el) {
      el.click();
      return true;
    }
  }
  return false;
}

/** ON when the UI exposes an "Ocultar subtítulos"/"Hide captions" affordance. */
function captionsAlreadyOn(): boolean {
  for (const root of roots()) {
    if (findByName(root, CAPTIONS_ON_NAMES)) return true;
  }
  return false;
}

type Entry = { t: number; author: string; text: string };

/**
 * Mirrors the Teams live-captions pane VERBATIM: one CaptionEvent per utterance,
 * carrying the caption element's own `textContent` exactly as Teams rendered it.
 *
 * Teams refines each utterance's text in place — the ASR rewrites words, it does
 * not merely append — and starts a NEW element for the next utterance, which
 * virtualization later prunes. So an element's text is final once a newer caption
 * supersedes it or Teams removes it; we emit its full text at that moment and never
 * reconstruct it. (The previous delta-splicing over an in-place-rewritten caption
 * is exactly what made the saved transcript diverge from what Teams displayed.)
 *
 * - `now()` supplies seconds-from-capture-start (same clock as the ASR segments).
 * - `onFinal` fires once per utterance with the verbatim final text.
 * - `onHeartbeat` fires on every caption mutation — the liveness signal.
 * - `onPartial` (optional) fires with the current in-progress text — live widget.
 *
 * Observes document.body so captions enabled mid-meeting (or a re-created pane) are
 * picked up without re-arming; per-record filtering keeps the hot path cheap.
 */
export function observeCaptions(
  now: () => number,
  onFinal: (e: CaptionEvent) => void,
  onHeartbeat: () => void,
  onPartial?: (e: CaptionEvent, lineId: number) => void,
): () => void {
  const itemSel = SELECTORS.captionItem.join(",");
  const paneSel = SELECTORS.captionPane.join(",");
  const tracked = new Map<Element, Entry>();
  const superseded = new Set<Element>();
  let settleTimer: number | undefined;

  // Stable per-utterance id so the live widget can mirror each Teams caption line
  // and refine it IN PLACE (Teams rewrites a line's text as the ASR corrects it),
  // instead of accumulating divergent copies. A recycled node gets a fresh id.
  const ids = new WeakMap<Element, number>();
  let nextId = 1;
  const idOf = (item: Element): number => {
    let id = ids.get(item);
    if (id === undefined) {
      id = nextId++;
      ids.set(item, id);
    }
    return id;
  };

  const emit = (item: Element) => {
    const e = tracked.get(item);
    tracked.delete(item);
    superseded.delete(item);
    if (e && e.text && e.author) {
      onFinal({ t: e.t, speakerName: e.author, text: e.text, final: true });
    }
  };

  const scheduleSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      for (const it of [...superseded]) emit(it);
    }, CAPTION_SETTLE_MS);
  };

  const readText = (item: Element) =>
    firstMatch(item, SELECTORS.captionText)?.textContent?.trim() ?? "";
  const readAuthor = (item: Element) => {
    const a = firstMatch(item, SELECTORS.captionAuthor)?.textContent;
    return a ? cleanName(a) : "";
  };

  const touch = (item: Element) => {
    const text = readText(item);
    if (!text) return;
    onHeartbeat();
    const isNew = !tracked.has(item);
    const prev = tracked.get(item);
    // No author node ever seen for this item: an unattributable final would
    // anchor downstream speaker labels to a fake name — drop it.
    const author = readAuthor(item) || prev?.author || "";
    if (!author) return;
    if (prev && author !== prev.author) {
      // Same DOM node recycled for a different speaker: the previous utterance is
      // finished — emit it verbatim before overwriting with the new one, and give
      // the node a fresh id so the widget shows it as a new line.
      onFinal({ t: prev.t, speakerName: prev.author, text: prev.text, final: true });
      superseded.delete(item);
      ids.set(item, nextId++);
      tracked.set(item, { t: now(), author, text });
    } else {
      tracked.set(item, { t: prev?.t ?? now(), author, text });
    }
    onPartial?.({ t: tracked.get(item)!.t, speakerName: author, text, final: false }, idOf(item));
    if (isNew) {
      // A new utterance element appeared → every older tracked line is done.
      for (const it of tracked.keys()) if (it !== item) superseded.add(it);
      if (superseded.size) scheduleSettle();
    }
  };

  // The pane selector guard keeps chat messages (same fui-* classes) out.
  const itemOf = (node: Node): Element | null => {
    const el = node instanceof Element ? node : node.parentElement;
    const item = el?.closest(itemSel) ?? null;
    return item?.closest(paneSel) ? item : null;
  };

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      // In-place text refinement of an existing caption line.
      const target = itemOf(rec.target);
      if (target) touch(target);
      // Teams virtualizes the caption list: a new utterance may arrive as the item
      // itself, or wrapped in a row/pane container that CONTAINS it — scan the added
      // subtree for items either way, or the row would be missed until its next
      // mutation.
      for (const added of rec.addedNodes) {
        if (!(added instanceof Element)) continue;
        const self = added.closest(itemSel);
        if (self && self !== target && self.closest(paneSel)) touch(self);
        added.querySelectorAll(itemSel).forEach((el) => {
          if (el !== target && el.closest(paneSel)) touch(el);
        });
      }
    }
    // Teams prunes old caption nodes; a pruned line is final by definition.
    for (const el of [...tracked.keys()]) {
      if (!el.isConnected) emit(el);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  return () => {
    observer.disconnect();
    clearTimeout(settleTimer);
    for (const el of [...tracked.keys()]) emit(el);
  };
}

/** Is a call/meeting live in this tab right now? Hangup-button presence is the signal. */
export function meetingPresent(): boolean {
  for (const root of roots()) {
    if (firstMatch(root, SELECTORS.hangup)) return true;
  }
  return false;
}

const PRESENCE_POLL_MS = 2000;
// Join fires only after the hangup button held for ~3 s (pre-join screens flash it);
// leave only after ~8 s gone — shorter absences are Teams re-rendering, not an exit.
const JOIN_DEBOUNCE_MS = 3000;
const LEAVE_DEBOUNCE_MS = 8000;

/**
 * Watches meeting presence and fires `onJoin` / `onLeave` on debounced transitions.
 * Runs permanently (a Teams tab hosts many meetings over its lifetime).
 */
export function observeMeetingPresence(onJoin: () => void, onLeave: () => void): () => void {
  let inMeeting = false;
  let presentSince = 0;
  let absentSince = 0;
  const timer = window.setInterval(() => {
    if (meetingPresent()) {
      absentSince = 0;
      if (inMeeting) return;
      if (!presentSince) presentSince = Date.now();
      else if (Date.now() - presentSince >= JOIN_DEBOUNCE_MS) {
        inMeeting = true;
        presentSince = 0;
        onJoin();
      }
    } else {
      presentSince = 0;
      if (!inMeeting) return;
      if (!absentSince) absentSince = Date.now();
      else if (Date.now() - absentSince >= LEAVE_DEBOUNCE_MS) {
        inMeeting = false;
        absentSince = 0;
        onLeave();
      }
    }
  }, PRESENCE_POLL_MS);
  return () => window.clearInterval(timer);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function clickFirst(selectors: string[]): boolean {
  for (const root of roots()) {
    const el = firstMatch(root, selectors);
    if (el instanceof HTMLElement) {
      el.click();
      return true;
    }
  }
  return false;
}

async function tryEnableCaptionsOnce(): Promise<boolean> {
  try {
    if (captionsAlreadyOn()) return true;
    if (!clickFirst(SELECTORS.moreButton) && !clickByName(MORE_MENU_NAMES)) return false;
    await sleep(600);
    if (!clickFirst(SELECTORS.languageSpeechMenu) && !clickByName(LANGUAGE_MENU_NAMES))
      return false;
    await sleep(600);
    if (captionsAlreadyOn()) return true;
    if (!clickFirst(SELECTORS.captionsToggle) && !clickByName(TURN_ON_NAMES)) return false;
    await sleep(2000);
    return captionsAlreadyOn() || captionsPresent();
  } finally {
    for (const root of roots()) {
      root.body?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
    }
  }
}

/**
 * Best-effort programmatic captions enable via the in-call menu:
 * More → Language and speech → Turn on live captions. Retried a few times because
 * the call toolbar/menu mounts a beat after join; the menu is closed (Escape) each
 * attempt. Verified with captionsPresent().
 */
export async function enableCaptions(): Promise<boolean> {
  if (captionsAlreadyOn() || captionsPresent()) return true;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (captionsAlreadyOn() || captionsPresent()) return true;
    if (await tryEnableCaptionsOnce()) return true;
    await sleep(1500);
  }
  if (captionsAlreadyOn() || captionsPresent()) return true;
  // Last resort: the Alt+Shift+C chord toggles captions, so only fire it while still OFF.
  if (!captionsAlreadyOn()) {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "C",
        code: "KeyC",
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await sleep(1500);
  }
  return captionsAlreadyOn() || captionsPresent();
}
