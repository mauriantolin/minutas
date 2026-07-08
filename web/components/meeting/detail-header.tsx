"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, MoreHorizontal, Pencil } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, meetingDuration } from "@/lib/format";
import { getLabelDefs, type LabelDef } from "@/lib/overrides";
import type { MeetingDetail } from "@/lib/api";

export type ExportFormat = "md" | "txt" | "pdf" | "copy";

export interface DetailHeaderProps {
  meeting: MeetingDetail;
  title: string;
  labels: string[];
  onRename: (title: string) => void;
  onToggleLabel: (name: string) => void;
  onRequestReprocess: () => void;
  onDelete: () => void;
  onExport: (format: ExportFormat) => void;
}

function useLabelDefs(): LabelDef[] {
  const [defs, setDefs] = useState<LabelDef[]>([]);
  useEffect(() => {
    setDefs(getLabelDefs());
    const update = () => setDefs(getLabelDefs());
    window.addEventListener("app:labels-changed", update);
    return () => window.removeEventListener("app:labels-changed", update);
  }, []);
  return defs;
}

function InlineTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          const next = draft.trim();
          if (!cancelled.current && next && next !== value) onSave(next);
          cancelled.current = false;
          setEditing(false);
        }}
        className="h-8 w-64"
      />
    );
  }
  return (
    <button
      type="button"
      className="group/title flex min-w-0 items-center gap-1.5"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      <span className="truncate text-sm font-medium">{value}</span>
      <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" />
    </button>
  );
}

export function DetailHeader({
  meeting,
  title,
  labels,
  onRename,
  onToggleLabel,
  onRequestReprocess,
  onDelete,
  onExport,
}: DetailHeaderProps) {
  const labelDefs = useLabelDefs();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const duration = meetingDuration(meeting.startedAt, meeting.endedAt);
  const canReprocess = meeting.status === "ready" || meeting.status === "needs_review";
  const statusBadge = <StatusBadge status={meeting.status} pipeline={meeting.pipeline} />;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/meetings">Reuniones</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="min-w-0">
                <InlineTitle value={title} onSave={onRename} />
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex shrink-0 items-center gap-2">
          {meeting.status === "capturing" ? (
            <Link href={`/live?id=${encodeURIComponent(meeting.meetingId)}`}>{statusBadge}</Link>
          ) : (
            statusBadge
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download />
                Exportar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onExport("md")}>Markdown (.md)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("txt")}>Texto (.txt)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("pdf")}>PDF (imprimir)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onExport("copy")}>Copiar Markdown</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <MoreHorizontal />
                <span className="sr-only">Más acciones</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setRenameDraft(title);
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
                      onCheckedChange={() => onToggleLabel(def.name)}
                    >
                      {def.emoji} {def.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem disabled={!canReprocess} onClick={onRequestReprocess}>
                Reprocesar
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                Eliminar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 px-6 pt-4 text-xs text-muted-foreground">
        <span>{formatDateTime(meeting.startedAt)}</span>
        {duration && (
          <>
            <span>·</span>
            <span>{duration}</span>
          </>
        )}
        <span>·</span>
        <span>{meeting.participants.length} participantes</span>
        {labels.map((name) => {
          const def = labelDefs.find((d) => d.name === name);
          return (
            <Badge key={name} variant="secondary">
              {def ? `${def.emoji} ${name}` : name}
            </Badge>
          );
        })}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Renombrar reunión</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameDraft.trim()) {
                onRename(renameDraft.trim());
                setRenameOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!renameDraft.trim()}
              onClick={() => {
                onRename(renameDraft.trim());
                setRenameOpen(false);
              }}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta reunión?</AlertDialogTitle>
            <AlertDialogDescription>Esta acción no se puede deshacer.</AlertDialogDescription>
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
    </>
  );
}
