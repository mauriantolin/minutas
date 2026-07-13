"use client";

import { Fragment } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface SourceRefTextProps {
  text: string;
  className?: string;
}

const REF_RE = /\[M:([A-Za-z0-9._-]+)(?::(T\d+))?\]|\[N:([A-Za-z0-9._-]+)\]/g;

/**
 * Renders text with inline `[M:{meetingId}:Tn]` / `[N:{noteId}]` citation
 * anchors as Badge chips linking to the source. Anything that doesn't match
 * those exact forms passes through as plain text.
 */
export function SourceRefText({ text, className }: SourceRefTextProps) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((match = REF_RE.exec(text)) !== null) {
    const meetingId = match[1];
    const turnId = match[2];
    const noteId = match[3];

    let href: string;
    let label: string;
    if (meetingId != null) {
      href = turnId
        ? `/meeting?id=${encodeURIComponent(meetingId)}&turn=${turnId}`
        : `/meeting?id=${encodeURIComponent(meetingId)}`;
      label = turnId ? `Reunión·${turnId}` : "Reunión";
    } else if (noteId != null) {
      href = `/notes?id=${encodeURIComponent(noteId)}`;
      label = "Nota";
    } else {
      continue;
    }

    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <Badge
        key={match.index}
        variant="outline"
        asChild
        className="mx-0.5 cursor-pointer px-1.5 py-0 align-baseline font-mono text-[10px] hover:bg-accent hover:text-accent-foreground"
      >
        <Link href={href}>{label}</Link>
      </Badge>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </span>
  );
}
