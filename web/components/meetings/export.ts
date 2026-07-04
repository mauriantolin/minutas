import { toast } from "sonner";
import type { MeetingDetail, Segment } from "@/lib/api";
import { formatClock, formatDateTime, meetingDuration } from "@/lib/format";
import { applySegmentOverrides, getOverrides } from "@/lib/overrides";

/** Drops the pipeline's inline `[Tn]` anchors — noise outside the app. */
const stripAnchors = (text: string) => text.replace(/\s*\[T\d+\]/g, "");

function mergedView(meeting: MeetingDetail) {
  const overrides = getOverrides(meeting.meetingId);
  const segments = applySegmentOverrides(
    meeting.segments ?? [],
    overrides,
    (s: Segment) => s.segId,
  );
  return { title: overrides.title ?? meeting.title, segments, overrides };
}

export function buildMarkdown(meeting: MeetingDetail): string {
  const { title, segments } = mergedView(meeting);
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Fecha: ${formatDateTime(meeting.startedAt)}`,
    `- Participantes: ${meeting.participants.map((p) => p.name).join(", ") || "—"}`,
  ];
  if (duration) lines.push(`- Duración: ${duration}`);
  if (meeting.summary?.summary) {
    lines.push("", "## Resumen", "", stripAnchors(meeting.summary.summary));
    if (meeting.summary.keyPoints.length > 0) {
      lines.push("", "### Puntos clave", "");
      for (const kp of meeting.summary.keyPoints) lines.push(`- ${stripAnchors(kp)}`);
    }
  }
  if (meeting.summary?.actionItems.length) {
    lines.push("", "## Acciones", "");
    for (const ai of meeting.summary.actionItems) {
      lines.push(`- ${stripAnchors(ai.text)}${ai.owner ? ` — ${ai.owner}` : ""}`);
    }
  }
  lines.push("", "## Transcripción", "");
  for (const s of segments) {
    lines.push(`**${s.speaker}** (${formatClock(s.startTime)}): ${s.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function buildTxt(meeting: MeetingDetail): string {
  const { segments } = mergedView(meeting);
  return segments
    .map((s) => `${s.speaker} (${formatClock(s.startTime)}): ${s.text}`)
    .join("\n");
}

function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "reunion"
  );
}

export function exportMarkdown(meeting: MeetingDetail): void {
  const { title } = mergedView(meeting);
  download(`${slug(title)}.md`, buildMarkdown(meeting), "text/markdown");
}

export function exportTxt(meeting: MeetingDetail): void {
  const { title } = mergedView(meeting);
  download(`${slug(title)}.txt`, buildTxt(meeting), "text/plain");
}

export async function copyMarkdown(meeting: MeetingDetail): Promise<void> {
  await navigator.clipboard.writeText(buildMarkdown(meeting));
  toast("Markdown copiado al portapapeles");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Print-to-PDF via a hidden iframe carrying a clean black-on-white document —
 * avoids touching the shell DOM and works identically from list and detail.
 */
export function exportPdf(meeting: MeetingDetail): void {
  const { title, segments } = mergedView(meeting);
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const summary = meeting.summary;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; color: #000; background: #fff; margin: 2rem; font-size: 12px; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 20px 0 8px; }
  .meta { color: #555; margin-bottom: 12px; }
  .seg { margin-bottom: 8px; } .spk { font-weight: 600; } .ts { color: #777; font-family: ui-monospace, monospace; }
  ul { margin: 0; padding-left: 18px; }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">${esc(formatDateTime(meeting.startedAt))}${duration ? ` · ${esc(duration)}` : ""} · ${esc(
    meeting.participants.map((p) => p.name).join(", ") || "—",
  )}</div>
${
  summary?.summary
    ? `<h2>Resumen</h2><p>${esc(stripAnchors(summary.summary))}</p>${
        summary.keyPoints.length
          ? `<ul>${summary.keyPoints.map((k) => `<li>${esc(stripAnchors(k))}</li>`).join("")}</ul>`
          : ""
      }`
    : ""
}
${
  summary?.actionItems.length
    ? `<h2>Acciones</h2><ul>${summary.actionItems
        .map((a) => `<li>${esc(stripAnchors(a.text))}${a.owner ? ` — ${esc(a.owner)}` : ""}</li>`)
        .join("")}</ul>`
    : ""
}
<h2>Transcripción</h2>
${segments
  .map(
    (s) =>
      `<div class="seg"><span class="spk">${esc(s.speaker)}</span> <span class="ts">(${formatClock(
        s.startTime,
      )})</span><br>${esc(s.text)}</div>`,
  )
  .join("")}
</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  iframe.contentWindow!.focus();
  iframe.contentWindow!.print();
  setTimeout(() => iframe.remove(), 60_000);
}
