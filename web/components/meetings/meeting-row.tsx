"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ClipboardCopy,
  FileDown,
  FileText,
  MoreHorizontal,
  Printer,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";
import { useAuth } from "@/components/auth-provider";
import { getMeeting, type Meeting } from "@/lib/api";
import { formatDateTime, initials, meetingDuration } from "@/lib/format";
import type { LabelDef } from "@/lib/overrides";
import { chartColor, cn } from "@/lib/utils";
import {
  copyMarkdown,
  exportMarkdown,
  exportPdf,
  exportTxt,
} from "@/components/meetings/export";

export interface MeetingRowProps {
  meeting: Meeting;
  /** Meeting labels after override merge (names). */
  labels: string[];
  labelDefs: LabelDef[];
  onRename: (id: string, title: string) => void;
  onToggleLabel: (id: string, label: string) => void;
  onReprocess: (id: string) => void;
  onDelete: (id: string) => void;
}

const MAX_AVATARS = 4;

export function MeetingRow({
  meeting,
  labels,
  labelDefs,
  onRename,
  onToggleLabel,
  onReprocess,
  onDelete,
}: MeetingRowProps) {
  const { token } = useAuth();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(meeting.title);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const id = meeting.meetingId;
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const participants = meeting.participants;
  const extra = participants.length - MAX_AVATARS;
  const canReprocess = meeting.status === "ready" || meeting.status === "needs_review";

  const runExport = async (fn: (m: Awaited<ReturnType<typeof getMeeting>>) => void | Promise<void>) => {
    try {
      await fn(await getMeeting(token!, id));
    } catch {
      toast.error("No se pudo exportar la reunión.");
    }
  };

  const submitRename = () => {
    const title = renameValue.trim();
    if (title && title !== meeting.title) onRename(id, title);
    setRenameOpen(false);
  };

  return (
    <div className="relative flex items-center gap-4 border-b px-6 py-4 hover:bg-accent/50">
      <Link
        href={`/meeting?id=${encodeURIComponent(id)}`}
        className="absolute inset-0"
        aria-label={meeting.title}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{meeting.title}</span>
          {labels.map((name) => {
            const def = labelDefs.find((d) => d.name === name);
            return (
              <Badge key={name} variant="secondary" className="rounded-full">
                {def ? `${def.emoji} ${def.name}` : name}
              </Badge>
            );
          })}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDateTime(meeting.startedAt)} · {participants.length}{" "}
          {participants.length === 1 ? "participante" : "participantes"}
          {duration ? ` · ${duration}` : ""}
        </p>
      </div>

      <div className="hidden items-center -space-x-2 sm:flex">
        {participants.slice(0, MAX_AVATARS).map((p, i) => (
          <Avatar key={`${p.name}-${i}`} className="size-6 ring-2 ring-background">
            <AvatarFallback
              className="text-[10px] text-white"
              style={{ backgroundColor: chartColor(i) }}
            >
              {initials(p.name)}
            </AvatarFallback>
          </Avatar>
        ))}
        {extra > 0 && (
          <Avatar className="size-6 ring-2 ring-background">
            <AvatarFallback className="text-[10px]">+{extra}</AvatarFallback>
          </Avatar>
        )}
      </div>

      {meeting.status === "capturing" ? (
        <Link href={`/live?id=${encodeURIComponent(id)}`} className="relative z-10">
          <StatusBadge status={meeting.status} pipeline={meeting.pipeline} />
        </Link>
      ) : (
        <StatusBadge status={meeting.status} pipeline={meeting.pipeline} />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("relative z-10 size-8 text-muted-foreground")}
            aria-label="Más acciones"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem asChild>
            <Link href={`/meeting?id=${encodeURIComponent(id)}`}>Abrir</Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setRenameValue(meeting.title);
              setRenameOpen(true);
            }}
          >
            Renombrar
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Etiquetas</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {labelDefs.map((def) => (
                <DropdownMenuCheckboxItem
                  key={def.name}
                  checked={labels.includes(def.name)}
                  onCheckedChange={() => onToggleLabel(id, def.name)}
                >
                  {def.emoji} {def.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Exportar</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void runExport(exportTxt)}>
                <FileText /> Texto (.txt)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runExport(exportMarkdown)}>
                <FileDown /> Markdown (.md)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runExport(exportPdf)}>
                <Printer /> PDF (imprimir)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runExport(copyMarkdown)}>
                <ClipboardCopy /> Copiar Markdown
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {canReprocess && (
            <DropdownMenuItem onSelect={() => setReprocessOpen(true)}>
              Reprocesar
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            Eliminar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Renombrar reunión</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitRename}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reprocessOpen} onOpenChange={setReprocessOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>¿Reprocesar esta reunión?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Se vuelve a ejecutar todo el pipeline: la transcripción limpia y el
            resumen actuales se reemplazan.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReprocessOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                setReprocessOpen(false);
                onReprocess(id);
              }}
            >
              Reprocesar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta reunión?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => onDelete(id)}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
