"use client";

// Markdown serialization for the Settings bulk export (ZIP of .md files).
// Per-meeting exports live in components/meetings/export.ts and
// components/meeting/detail-export.tsx; all three strip [Tn] anchors so the
// same meeting reads identically regardless of the export entry point.

import type { MeetingDetail } from "@/lib/api";
import { formatClock, formatDateTime, meetingDuration } from "@/lib/format";
import { applySegmentOverrides, getOverrides, type MeetingOverrides } from "@/lib/overrides";

/** Drops the pipeline's inline `[Tn]` anchors — noise outside the app. */
const stripAnchors = (text: string) => text.replace(/\s*\[T\d+\]/g, "");

/** "Sprint review · 3/7" → "sprint-review-3-7"; safe cross-OS filename base. */
export function fileSlug(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return s || "reunion";
}

function effective(meeting: MeetingDetail): {
  title: string;
  overrides: MeetingOverrides;
  segments: ReturnType<typeof applySegmentOverrides<MeetingDetail["segments"][number]>>;
} {
  const overrides = getOverrides(meeting.meetingId);
  return {
    title: overrides.title ?? meeting.title,
    overrides,
    segments: applySegmentOverrides(meeting.segments, overrides, (s) => s.segId),
  };
}

/** Full meeting → Markdown per spec §3.11 (local edits/overrides applied). */
export function meetingToMarkdown(meeting: MeetingDetail): string {
  const { title, overrides, segments } = effective(meeting);
  const lines: string[] = [`# ${title}`, ""];
  lines.push(`- **Fecha:** ${formatDateTime(meeting.startedAt)}`);
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  if (duration) lines.push(`- **Duración:** ${duration}`);
  if (meeting.participants.length > 0) {
    lines.push(`- **Participantes:** ${meeting.participants.map((p) => p.name).join(", ")}`);
  }
  if (meeting.summary) {
    lines.push("", "## Resumen", "", stripAnchors(meeting.summary.summary));
    if (meeting.summary.keyPoints.length > 0) {
      lines.push("", "### Puntos clave", "");
      for (const kp of meeting.summary.keyPoints) lines.push(`- ${stripAnchors(kp)}`);
    }
    if (meeting.summary.actionItems.length > 0) {
      lines.push("", "## Acciones", "");
      for (const item of meeting.summary.actionItems) {
        const mark = overrides.actionItemsDone[item.text] ? "x" : " ";
        lines.push(`- [${mark}] ${stripAnchors(item.text)}${item.owner ? ` — ${item.owner}` : ""}`);
      }
    }
  }
  if (segments.length > 0) {
    lines.push("", "## Transcripción", "");
    for (const s of segments) {
      lines.push(`**${s.speaker}** (${formatClock(s.startTime)}): ${s.text}`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
