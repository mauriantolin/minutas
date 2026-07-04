"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, FileText, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PHASE_LABELS } from "@/lib/config";
import type { MeetingDetail } from "@/lib/api";
import type { SegmentOverride } from "@/lib/overrides";
import { useTagDefs, type Turn } from "@/components/meeting/detail-api";
import { buildTranscriptMarkdown } from "@/components/meeting/detail-export";
import { TranscriptSegment } from "@/components/meeting/transcript-segment";

export interface NavTarget {
  turnId: string;
  nonce: number;
}

export interface TranscriptTabProps {
  meeting: MeetingDetail;
  turns: Turn[];
  colorOf: (speaker: string) => string;
  /** [Tn] navigation request from Summary/Q&A; new nonce re-triggers. */
  navTarget: NavTarget | null;
  onPatchSegment: (id: string, patch: SegmentOverride) => void;
}

const FLASH_MS = 1600;

export function TranscriptTab({
  meeting,
  turns,
  colorOf,
  navTarget,
  onPatchSegment,
}: TranscriptTabProps) {
  const tagDefs = useTagDefs();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visibleTurns = useMemo(
    () =>
      tagFilter.length === 0
        ? turns
        : turns.filter((t) => t.tags.some((tag) => tagFilter.includes(tag))),
    [turns, tagFilter],
  );

  const trimmedQuery = query.trim();
  const matches = useMemo(() => {
    if (!trimmedQuery) return [];
    const q = trimmedQuery.toLowerCase();
    const out: { turnId: string; occurrence: number }[] = [];
    for (const t of visibleTurns) {
      const lower = t.text.toLowerCase();
      let pos = 0;
      let occ = 0;
      for (let idx = lower.indexOf(q); idx !== -1; idx = lower.indexOf(q, pos)) {
        out.push({ turnId: t.id, occurrence: occ });
        pos = idx + q.length;
        occ++;
      }
    }
    return out;
  }, [visibleTurns, trimmedQuery]);

  useEffect(() => setActiveIndex(0), [trimmedQuery, tagFilter]);

  const activeMatch = matches[Math.min(activeIndex, matches.length - 1)] ?? null;

  useEffect(() => {
    if (!activeMatch) return;
    document
      .getElementById(`turn-${activeMatch.turnId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatch]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setActiveIndex((i) => (i + delta + matches.length) % matches.length);
  };

  useEffect(() => {
    if (!navTarget) return;
    // A tag filter could hide the anchored turn — clear it so the jump lands.
    setTagFilter((f) => (f.length > 0 ? [] : f));
    const t = setTimeout(() => {
      document
        .getElementById(`turn-${navTarget.turnId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlashId(navTarget.turnId);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS);
    }, 60);
    return () => clearTimeout(t);
  }, [navTarget]);

  const copyAll = () => {
    void navigator.clipboard.writeText(buildTranscriptMarkdown(visibleTurns));
    toast("Transcripción copiada");
  };

  if (turns.length === 0) {
    const phase = meeting.pipeline ? PHASE_LABELS[meeting.pipeline.phase] : undefined;
    return (
      <Empty className="m-6 flex-1 border">
        {meeting.status === "processing" || meeting.status === "capturing" ? (
          <EmptyHeader>
            <EmptyMedia>
              <Spinner className="size-6 text-muted-foreground" />
            </EmptyMedia>
            <EmptyTitle>Transcripción en proceso…</EmptyTitle>
            {phase && <EmptyDescription>{phase}</EmptyDescription>}
          </EmptyHeader>
        ) : (
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>Sin transcripción</EmptyTitle>
            <EmptyDescription>Esta reunión no tiene fragmentos de transcripción.</EmptyDescription>
          </EmptyHeader>
        )}
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Buscar en la transcripción…"
            className="h-8 w-56 pl-8"
          />
        </div>
        {trimmedQuery && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {matches.length === 0 ? "0/0" : `${Math.min(activeIndex, matches.length - 1) + 1}/${matches.length}`}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp />
          <span className="sr-only">Resultado anterior</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          <ChevronDown />
          <span className="sr-only">Resultado siguiente</span>
        </Button>
        <Separator orientation="vertical" className="h-5!" />
        <ToggleGroup
          type="multiple"
          value={tagFilter}
          onValueChange={setTagFilter}
          className="gap-1"
        >
          {tagDefs.map((def) => (
            <ToggleGroupItem
              key={def.tag}
              value={def.tag}
              size="sm"
              className="size-7 min-w-0 rounded-md p-0 text-xs"
              aria-label={def.label}
              title={def.label}
            >
              {def.emoji}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={copyAll}>
            <Copy />
            Copiar
          </Button>
          <div className="flex items-center gap-2">
            <Switch id="transcript-edit-mode" checked={editMode} onCheckedChange={setEditMode} />
            <Label htmlFor="transcript-edit-mode" className="text-sm">
              Editar
            </Label>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <TooltipProvider delayDuration={300}>
          <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
            {visibleTurns.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Sin fragmentos con esos tags.
              </p>
            ) : (
              visibleTurns.map((turn) => (
                <TranscriptSegment
                  key={turn.id}
                  turn={turn}
                  tagDefs={tagDefs}
                  color={colorOf(turn.speaker)}
                  startedAt={meeting.startedAt}
                  editMode={editMode}
                  query={trimmedQuery}
                  activeOccurrence={
                    activeMatch?.turnId === turn.id ? activeMatch.occurrence : -1
                  }
                  flash={flashId === turn.id}
                  onToggleTag={(tag) =>
                    onPatchSegment(turn.id, {
                      tags: turn.tags.includes(tag)
                        ? turn.tags.filter((t) => t !== tag)
                        : [...turn.tags, tag],
                    })
                  }
                  onSaveText={(text) => onPatchSegment(turn.id, { text })}
                  onDelete={() => onPatchSegment(turn.id, { deleted: true })}
                />
              ))
            )}
          </div>
        </TooltipProvider>
      </ScrollArea>
    </div>
  );
}
