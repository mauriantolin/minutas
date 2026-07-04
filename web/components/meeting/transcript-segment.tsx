"use client";

import { useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatClock, formatTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TagDef, Turn } from "@/components/meeting/detail-api";

export interface TranscriptSegmentProps {
  turn: Turn;
  /** Built-in + custom moment tags (Settings §3.10.4). */
  tagDefs: TagDef[];
  color: string;
  startedAt: string;
  editMode: boolean;
  query: string;
  /** Index (within this turn) of the globally active search match, or -1. */
  activeOccurrence: number;
  flash: boolean;
  onToggleTag: (tag: string) => void;
  onSaveText: (text: string) => void;
  onDelete: () => void;
}

function highlightMatches(text: string, query: string, activeOccurrence: number) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  let occ = 0;
  for (let idx = lower.indexOf(q); idx !== -1; idx = lower.indexOf(q, pos)) {
    if (idx > pos) nodes.push(text.slice(pos, idx));
    nodes.push(
      <mark
        key={idx}
        data-match-active={occ === activeOccurrence || undefined}
        className={cn(
          "rounded bg-chart-4/30 px-0.5",
          occ === activeOccurrence && "ring-1 ring-ring",
        )}
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    pos = idx + q.length;
    occ++;
  }
  nodes.push(text.slice(pos));
  return nodes;
}

export function TranscriptSegment({
  turn,
  tagDefs,
  color,
  startedAt,
  editMode,
  query,
  activeOccurrence,
  flash,
  onToggleTag,
  onSaveText,
  onDelete,
}: TranscriptSegmentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const absoluteTime = formatTime(
    new Date(new Date(startedAt).getTime() + turn.startTime * 1000).toISOString(),
  );

  const startEdit = () => {
    setDraft(turn.text);
    setEditing(true);
  };
  const save = () => {
    const next = draft.trim();
    if (next && next !== turn.text) onSaveText(next);
    setEditing(false);
  };

  return (
    <div
      id={`turn-${turn.id}`}
      className={cn(
        "group -mx-2 rounded-md px-2 py-1 transition-shadow",
        flash && "ring-1 ring-ring bg-accent/40",
      )}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 88px" }}
    >
      <div className="flex items-center gap-2">
        <Avatar className="size-7">
          <AvatarFallback
            className="text-[10px] font-medium text-white"
            style={{ backgroundColor: color }}
          >
            {initials(turn.speaker)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm font-semibold" style={{ color }}>
          {turn.speaker}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatClock(turn.startTime)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{absoluteTime}</TooltipContent>
        </Tooltip>
        {turn.tags.map((tag) => (
          <Badge key={tag} variant="outline" className="px-1.5 py-0 text-xs">
            {tagDefs.find((d) => d.tag === tag)?.emoji ?? tag}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {tagDefs.map((def) => (
            <Tooltip key={def.tag}>
              <TooltipTrigger asChild>
                <Toggle
                  size="sm"
                  className="size-6 min-w-0 p-0 text-xs"
                  pressed={turn.tags.includes(def.tag)}
                  onPressedChange={() => onToggleTag(def.tag)}
                  aria-label={def.label}
                >
                  {def.emoji}
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>{def.label}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => {
                  void navigator.clipboard.writeText(turn.text);
                  toast("Copiado");
                }}
              >
                <Copy className="size-3.5" />
                <span className="sr-only">Copiar fragmento</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copiar</TooltipContent>
          </Tooltip>
          {editMode && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6" onClick={startEdit}>
                    <Pencil className="size-3.5" />
                    <span className="sr-only">Editar fragmento</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Editar</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-destructive hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">Eliminar fragmento</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Eliminar</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-1 space-y-2 pl-9">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            className="min-h-9 resize-none text-sm leading-6"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              Guardar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={cn("pl-9 text-sm leading-6", editMode && "cursor-text hover:bg-accent/30 rounded")}
          onClick={editMode ? startEdit : undefined}
        >
          {highlightMatches(turn.text, query, activeOccurrence)}
          {turn.edited && <span className="ml-1 text-xs text-muted-foreground">(editado)</span>}
        </div>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar este fragmento?</AlertDialogTitle>
            <AlertDialogDescription>
              Eliminar este fragmento es irreversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={onDelete}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
