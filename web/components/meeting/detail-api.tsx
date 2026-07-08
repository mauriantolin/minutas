"use client";

import { useEffect, useState } from "react";
import { CONFIG } from "@/lib/config";
import { chartColor } from "@/lib/utils";
import type { MeetingDetail, Segment } from "@/lib/api";
import { applySegmentOverrides, getCustomTags, type MeetingOverrides } from "@/lib/overrides";

/** Clean-transcript turn as rendered by the detail view (spec §2/§3.4). */
export interface Turn {
  id: string;
  speaker: string;
  startTime: number;
  endTime?: number;
  text: string;
  tags: string[];
  edited?: boolean;
}

export interface TagDef {
  tag: string;
  emoji: string;
  label: string;
}

export const TAG_DEFS: TagDef[] = [
  { tag: "decision", emoji: "📌", label: "Decisión" },
  { tag: "action", emoji: "✅", label: "Acción" },
  { tag: "question", emoji: "❓", label: "Pregunta" },
  { tag: "highlight", emoji: "⭐", label: "Destacado" },
];

export const tagEmoji = (tag: string): string =>
  TAG_DEFS.find((d) => d.tag === tag)?.emoji ?? tag;

/** Built-in defs merged with the user's custom moment tags (Settings §3.10.4). */
export function useTagDefs(): TagDef[] {
  const [defs, setDefs] = useState<TagDef[]>(TAG_DEFS);
  useEffect(() => {
    const load = () =>
      setDefs([
        ...TAG_DEFS,
        ...getCustomTags().map((t) => ({ tag: t.name, emoji: t.emoji, label: t.name })),
      ]);
    load();
    window.addEventListener("app:tags-changed", load);
    return () => window.removeEventListener("app:tags-changed", load);
  }, []);
  return defs;
}

type RawTurn = Segment & { id?: string; tags?: string[] };

/**
 * Canonical turns for the detail view: the clean-transcript artifact when the
 * pipeline published one (real `T{n}` ids + pipeline tags, spec §3.4), raw
 * segments otherwise (legacy/live meetings), falling back to `segId`, then to
 * a positional `T{n}` so [Tn] anchors still resolve. localStorage overrides
 * merge on top, keyed by the same stable id.
 */
export function buildTurns(meeting: MeetingDetail, overrides: MeetingOverrides): Turn[] {
  const source: RawTurn[] = meeting.cleanTranscript?.turns ?? (meeting.segments as RawTurn[]);
  const withIds = source.map((s, i) => ({
    ...s,
    id: s.id ?? s.segId ?? `T${i + 1}`,
    tags: s.tags ?? [],
  }));
  return applySegmentOverrides(withIds, overrides, (s) => s.id).map((s) => ({
    id: s.id,
    speaker: s.speaker,
    startTime: s.startTime,
    endTime: s.endTime,
    text: s.text,
    tags: s.tags ?? [],
    edited: s.edited,
  }));
}

/** [Tn] anchor targets — the same ids the transcript DOM uses (`turn-{id}`). */
export function turnIdSet(turns: Turn[]): ReadonlySet<string> | undefined {
  const ids = new Set(turns.map((t) => t.id));
  return ids.size > 0 ? ids : undefined;
}

/** Stable speaker → chart color map, order of first appearance (spec §3.4). */
export function speakerColors(
  turns: Turn[],
  participants: { name: string }[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of turns) if (!m.has(t.speaker)) m.set(t.speaker, chartColor(m.size));
  for (const p of participants) if (!m.has(p.name)) m.set(p.name, chartColor(m.size));
  return m;
}

export interface MeetingPatchBody {
  title?: string;
  labels?: string[];
  segments?: { id: string; text?: string; tags?: string[]; deleted?: boolean }[];
}

/**
 * Best-effort PATCH /meetings/{id} (spec §2 API delta). The localStorage
 * override is always written first and remains the durable fallback until
 * the backend delta ships, so failures here are intentionally swallowed.
 */
export async function patchMeetingRemote(
  token: string,
  meetingId: string,
  body: MeetingPatchBody,
): Promise<void> {
  try {
    await fetch(`${CONFIG.apiUrl}/meetings/${encodeURIComponent(meetingId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Endpoint absent/offline — overrides already persisted locally.
  }
}
