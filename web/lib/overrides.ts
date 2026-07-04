/**
 * localStorage fallback for edits that lack an API delta yet (spec §2):
 * per-meeting overrides keyed `meeting:<id>:overrides`, segments keyed by
 * stable segment `id` (never array index), merged client-side over API data.
 * When the PATCH delta ships, callers swap the persist call and keep this
 * module as offline fallback.
 */

export interface SegmentOverride {
  text?: string;
  tags?: string[];
  deleted?: boolean;
}

export interface MeetingOverrides {
  title?: string;
  labels?: string[];
  /** Keyed by stable segment/turn id. */
  segments: Record<string, SegmentOverride>;
  /** Keyed by action-item text (items carry no id yet). */
  actionItemsDone: Record<string, boolean>;
}

const key = (meetingId: string) => `meeting:${meetingId}:overrides`;

/** localStorage is a trust boundary: a corrupt value degrades to the default. */
function parseStored<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getOverrides(meetingId: string): MeetingOverrides {
  if (typeof window === "undefined") return { segments: {}, actionItemsDone: {} };
  const parsed = parseStored<Partial<MeetingOverrides>>(
    window.localStorage.getItem(key(meetingId)),
    {},
  );
  return {
    ...parsed,
    segments: parsed.segments ?? {},
    actionItemsDone: parsed.actionItemsDone ?? {},
  };
}

export function saveOverrides(meetingId: string, overrides: MeetingOverrides): void {
  window.localStorage.setItem(key(meetingId), JSON.stringify(overrides));
}

export function patchSegmentOverride(
  meetingId: string,
  segmentId: string,
  patch: SegmentOverride,
): MeetingOverrides {
  const o = getOverrides(meetingId);
  o.segments[segmentId] = { ...o.segments[segmentId], ...patch };
  saveOverrides(meetingId, o);
  return o;
}

export function patchMeetingOverride(
  meetingId: string,
  patch: { title?: string; labels?: string[] },
): MeetingOverrides {
  const o = { ...getOverrides(meetingId), ...patch };
  saveOverrides(meetingId, o);
  return o;
}

export function setActionItemDone(
  meetingId: string,
  itemKey: string,
  done: boolean,
): MeetingOverrides {
  const o = getOverrides(meetingId);
  o.actionItemsDone[itemKey] = done;
  saveOverrides(meetingId, o);
  return o;
}

/** Generic merge over any id-carrying segment shape; drops deleted ones. */
export function applySegmentOverrides<T extends { text: string; tags?: string[] }>(
  segments: readonly T[],
  overrides: MeetingOverrides,
  idOf: (segment: T) => string | undefined,
): (T & { edited?: boolean })[] {
  return segments.flatMap((s) => {
    const id = idOf(s);
    const o = id ? overrides.segments[id] : undefined;
    if (!o) return [s];
    if (o.deleted) return [];
    return [
      {
        ...s,
        text: o.text ?? s.text,
        tags: o.tags ?? s.tags,
        edited: o.text !== undefined,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// User label definitions (Settings §3.10; sidebar Etiquetas group; list filter).
// ---------------------------------------------------------------------------

export interface LabelDef {
  emoji: string;
  name: string;
}

export const DEFAULT_LABELS: LabelDef[] = [
  { emoji: "🤝", name: "1:1" },
  { emoji: "🔁", name: "Recurrente" },
  { emoji: "⏳", name: "Larga" },
  { emoji: "💼", name: "Cliente" },
];

const LABELS_KEY = "labels:defs";

export function getLabelDefs(): LabelDef[] {
  if (typeof window === "undefined") return DEFAULT_LABELS;
  return parseStored(window.localStorage.getItem(LABELS_KEY), DEFAULT_LABELS);
}

export function setLabelDefs(defs: LabelDef[]): void {
  window.localStorage.setItem(LABELS_KEY, JSON.stringify(defs));
  window.dispatchEvent(new CustomEvent("app:labels-changed"));
}

const OVERRIDES_KEY_RE = /^meeting:.+:overrides$/;

function mapMeetingLabels(map: (labels: string[]) => string[]): void {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)!;
    if (OVERRIDES_KEY_RE.test(k)) keys.push(k);
  }
  for (const k of keys) {
    const parsed = parseStored<Partial<MeetingOverrides>>(window.localStorage.getItem(k), {});
    if (!parsed.labels?.length) continue;
    const next = map(parsed.labels);
    if (next.length === parsed.labels.length && next.every((l, i) => l === parsed.labels![i]))
      continue;
    window.localStorage.setItem(k, JSON.stringify({ ...parsed, labels: next }));
  }
  window.dispatchEvent(new CustomEvent("app:labels-changed"));
}

/** Cascade a label deletion into every per-meeting assignment. */
export function removeLabelFromMeetings(name: string): void {
  mapMeetingLabels((labels) => labels.filter((l) => l !== name));
}

/** Cascade a label rename into every per-meeting assignment. */
export function renameLabelInMeetings(oldName: string, newName: string): void {
  mapMeetingLabels((labels) => labels.map((l) => (l === oldName ? newName : l)));
}

// ---------------------------------------------------------------------------
// Custom moment tags (Settings §3.10.4) — merged into transcript tag toggles.
// ---------------------------------------------------------------------------

const CUSTOM_TAGS_KEY = "tags:custom";

export function getCustomTags(): LabelDef[] {
  if (typeof window === "undefined") return [];
  return parseStored<LabelDef[]>(window.localStorage.getItem(CUSTOM_TAGS_KEY), []);
}

export function setCustomTags(tags: LabelDef[]): void {
  window.localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
  window.dispatchEvent(new CustomEvent("app:tags-changed"));
}
