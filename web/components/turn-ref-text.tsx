"use client";

import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface TurnRefTextProps {
  text: string;
  /**
   * Called with the clean-turn id (e.g. "T14"). The consumer handles tab
   * switch + scrollIntoView + ring flash on the matching segment.
   */
  onNavigate?: (turnId: string) => void;
  /** When provided, refs not in the set render as plain text. */
  knownIds?: ReadonlySet<string>;
  className?: string;
}

const REF_RE = /\[T(\d+)\]/g;

/**
 * Renders text with inline `[Tn]` citation anchors as clickable outline
 * badges (spec §2). Preserves line breaks (`whitespace-pre-wrap`); raw
 * `[Tn]` strings never reach the DOM for known refs.
 */
export function TurnRefText({ text, onNavigate, knownIds, className }: TurnRefTextProps) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((match = REF_RE.exec(text)) !== null) {
    const turnId = `T${match[1]}`;
    if (knownIds && !knownIds.has(turnId)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <Badge
        key={`${match.index}-${turnId}`}
        variant="outline"
        asChild
        className="mx-0.5 cursor-pointer px-1.5 py-0 align-baseline font-mono text-[10px] hover:bg-accent hover:text-accent-foreground"
      >
        <button type="button" onClick={() => onNavigate?.(turnId)}>
          {turnId}
        </button>
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
