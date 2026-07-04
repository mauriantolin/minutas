"use client";

import type { MeetingDetail } from "@/lib/api";
import { formatClock, formatDateTime, meetingDuration } from "@/lib/format";
import type { Turn } from "@/components/meeting/detail-api";

/** Drops the pipeline's inline `[Tn]` anchors — noise outside the app. */
const stripAnchors = (text: string) => text.replace(/\s*\[T\d+\]/g, "");

export function buildTranscriptMarkdown(turns: Turn[]): string {
  return turns
    .map((t) => `**${t.speaker}** (${formatClock(t.startTime)}): ${t.text}`)
    .join("\n\n");
}

export function buildTranscriptText(turns: Turn[]): string {
  return turns
    .map((t) => `${t.speaker} (${formatClock(t.startTime)}): ${t.text}`)
    .join("\n");
}

export function buildMeetingMarkdown(
  meeting: MeetingDetail,
  title: string,
  turns: Turn[],
): string {
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Fecha: ${formatDateTime(meeting.startedAt)}`,
    ...(duration ? [`- Duración: ${duration}`] : []),
    `- Participantes: ${meeting.participants.map((p) => p.name).join(", ")}`,
    "",
  ];
  if (meeting.summary) {
    lines.push("## Resumen", "", stripAnchors(meeting.summary.summary), "");
    if (meeting.summary.keyPoints.length > 0) {
      lines.push("### Puntos clave", "");
      for (const kp of meeting.summary.keyPoints) lines.push(`- ${stripAnchors(kp)}`);
      lines.push("");
    }
    if (meeting.summary.actionItems.length > 0) {
      lines.push("## Acciones", "");
      for (const ai of meeting.summary.actionItems)
        lines.push(`- [ ] ${stripAnchors(ai.text)}${ai.owner ? ` — ${ai.owner}` : ""}`);
      lines.push("");
    }
  }
  lines.push("## Transcripción", "", buildTranscriptMarkdown(turns), "");
  return lines.join("\n");
}

export function exportFileName(title: string, ext: string): string {
  return `${title.replace(/[\\/:*?"<>|]/g, "-").trim() || "reunion"}.${ext}`;
}

export function downloadFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Print-only DOM for the "PDF (imprimir)" export (spec §3.11): hidden on
 * screen, the visibility hack keeps multi-page flow working while hiding
 * the app shell without touching global styles.
 */
export function MeetingPrintView({
  meeting,
  title,
  turns,
}: {
  meeting: MeetingDetail;
  title: string;
  turns: Turn[];
}) {
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  return (
    <div id="meeting-print" className="hidden print:block">
      <style>{`@media print {
        body * { visibility: hidden; }
        #meeting-print, #meeting-print * { visibility: visible; }
        #meeting-print { position: absolute; left: 0; top: 0; width: 100%; background: #fff; color: #000; }
      }`}</style>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-xs">
        {formatDateTime(meeting.startedAt)}
        {duration ? ` · ${duration}` : ""} ·{" "}
        {meeting.participants.map((p) => p.name).join(", ")}
      </p>
      {meeting.summary && (
        <section className="mt-4">
          <h2 className="text-base font-semibold">Resumen</h2>
          <p className="mt-1 text-sm whitespace-pre-wrap">
            {stripAnchors(meeting.summary.summary)}
          </p>
          {meeting.summary.keyPoints.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {meeting.summary.keyPoints.map((kp, i) => (
                <li key={i}>{stripAnchors(kp)}</li>
              ))}
            </ul>
          )}
          {meeting.summary.actionItems.length > 0 && (
            <>
              <h2 className="mt-3 text-base font-semibold">Acciones</h2>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {meeting.summary.actionItems.map((ai, i) => (
                  <li key={i}>
                    {stripAnchors(ai.text)}
                    {ai.owner ? ` — ${ai.owner}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <section className="mt-4">
        <h2 className="text-base font-semibold">Transcripción</h2>
        <div className="mt-2 space-y-2">
          {turns.map((t) => (
            <p key={t.id} className="text-sm">
              <strong>{t.speaker}</strong>{" "}
              <span className="font-mono text-xs">({formatClock(t.startTime)})</span>: {t.text}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
