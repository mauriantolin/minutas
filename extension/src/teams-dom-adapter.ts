/**
 * ISOLATED, FRAGILE MODULE. Everything that depends on the Teams PWA markup lives here so
 * that when Microsoft changes the DOM, only this file needs patching. Keep the public API
 * (readActiveSpeaker, readMeetingTitle, readLocalUserName) stable.
 *
 * Strategy: Teams marks the participant currently speaking with a visual "speaking" ring on
 * their video/roster tile. We read the name off that tile. Selectors are best-effort with
 * fallbacks; verify against live Teams and adjust the SELECTORS below if they drift.
 */

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
};

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
