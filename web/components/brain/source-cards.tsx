"use client";

import Link from "next/link";
import { CalendarDays, ChevronRight, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BrainCitation } from "@/lib/api";

export interface SourceCardsProps {
  citations: BrainCitation[];
}

export function SourceCards({ citations }: SourceCardsProps) {
  const unique = citations.filter(
    (c, i) => citations.findIndex((o) => o.url === c.url) === i,
  );
  if (unique.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {unique.map((c) => (
        <Link
          key={c.url}
          href={c.url}
          className="group flex min-w-0 max-w-full items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 transition-colors hover:bg-accent"
        >
          <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 text-[10px]">
            {c.kind === "meeting" ? (
              <CalendarDays className="size-3" />
            ) : (
              <StickyNote className="size-3" />
            )}
            {c.kind === "meeting" ? "Reunión" : "Nota"}
          </Badge>
          <span className="min-w-0 truncate text-xs font-medium">{c.title}</span>
          {c.turnId && (
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
            >
              {c.turnId}
            </Badge>
          )}
          {c.date && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {new Date(c.date).toLocaleDateString("es-AR")}
            </span>
          )}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      ))}
    </div>
  );
}
