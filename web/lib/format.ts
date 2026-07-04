const LOCALE = "es-AR";

/** "3 jul 2026" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "14:30" */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 jul 2026, 14:30" */
export function formatDateTime(iso: string): string {
  return `${formatDate(iso)}, ${formatTime(iso)}`;
}

/** Seconds from capture start → "mm:ss" (transcript timestamps). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds → "45 s" | "12 min" | "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

/** Wall-clock meeting duration; null while the meeting has no end yet. */
export function meetingDuration(startedAt: string, endedAt?: string): string | null {
  if (!endedAt) return null;
  return formatDuration((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
}

/** "Mauricio Antolin" → "MA"; "mmv@x.com" → "M". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}
