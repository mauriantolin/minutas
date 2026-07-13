"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Keyboard, Mic, NotebookPen, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/components/auth-provider";
import { MicButton } from "@/components/notes/mic-button";
import { NoteEditor } from "@/components/notes/note-editor";
import { createNote, getNote, listNotes, type Note, type NoteSource } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useIsXl } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function NotesView() {
  const { token } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const isXl = useIsXl();

  const composing = params.get("record") === "1";
  const selectedId = composing ? null : params.get("id");

  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!token) return;
    try {
      const r = await listNotes(token);
      setNotes(r.notes);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const loading = notes === null && !error;

  const sorted = useMemo(
    () => [...(notes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [notes],
  );

  const [openNote, setOpenNote] = useState<Note | null>(null);
  useEffect(() => {
    if (!selectedId || !token) {
      setOpenNote(null);
      return;
    }
    let alive = true;
    getNote(token, selectedId)
      .then((n) => {
        if (alive) setOpenNote(n);
      })
      .catch(() => {
        if (alive) toast.error("No se pudo cargar la nota.");
      });
    return () => {
      alive = false;
    };
  }, [selectedId, token]);

  const displayNote =
    openNote?.noteId === selectedId
      ? openNote
      : (sorted.find((n) => n.noteId === selectedId) ?? null);

  const openComposer = () => router.push("/notes?record=1");
  const openNoteById = (id: string) => router.push(`/notes?id=${encodeURIComponent(id)}`);
  const closePanel = () => router.replace("/notes");

  const handleCreated = (note: Note) => {
    setNotes((prev) => [note, ...(prev ?? [])]);
    router.replace(`/notes?id=${encodeURIComponent(note.noteId)}`);
  };

  const handleSaved = (note: Note) => {
    setOpenNote(note);
    setNotes((prev) => (prev ?? []).map((n) => (n.noteId === note.noteId ? note : n)));
  };

  const handleDeleted = (noteId: string) => {
    setNotes((prev) => (prev ?? []).filter((n) => n.noteId !== noteId));
    closePanel();
  };

  const panelOpen = composing || selectedId !== null;
  const panelTitle = composing ? "Nueva nota" : "Nota";
  const panelBody = composing ? (
    <NoteComposer onCreated={handleCreated} />
  ) : displayNote ? (
    <NoteEditor
      key={displayNote.noteId}
      note={displayNote}
      onSaved={handleSaved}
      onDeleted={handleDeleted}
    />
  ) : (
    <div className="grid h-full place-items-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <h1 className="text-xl font-semibold tracking-tight">Notas</h1>
        <Button size="sm" className="ml-auto" onClick={openComposer}>
          <Plus />
          Nueva nota
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-2 rounded-xl border p-4">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No se pudieron cargar las notas</EmptyTitle>
                <EmptyDescription>Reintentá en unos segundos. ({error})</EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => void refetch()}>
                Reintentar
              </Button>
            </Empty>
          ) : sorted.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NotebookPen />
                </EmptyMedia>
                <EmptyTitle>Todavía no tenés notas</EmptyTitle>
                <EmptyDescription>
                  Escribí o dictá tu primera nota; la IA la limpia y la suma a tu memoria.
                </EmptyDescription>
              </EmptyHeader>
              <Button onClick={openComposer}>
                <Plus />
                Nueva nota
              </Button>
            </Empty>
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
              {sorted.map((note) => (
                <NoteCard
                  key={note.noteId}
                  note={note}
                  selected={note.noteId === selectedId}
                  onOpen={() => openNoteById(note.noteId)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {isXl === true && panelOpen && (
          <aside className="flex w-[420px] shrink-0 flex-col border-l">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <h2 className="text-sm font-medium">{panelTitle}</h2>
              <Button variant="ghost" size="icon" onClick={closePanel} aria-label="Cerrar">
                <X />
              </Button>
            </div>
            <div className="min-h-0 flex-1">{panelBody}</div>
          </aside>
        )}
      </div>

      {isXl === false && (
        <Sheet
          open={panelOpen}
          onOpenChange={(open) => {
            if (!open) closePanel();
          }}
        >
          <SheetContent side="bottom" className="h-[85svh] gap-0">
            <SheetHeader className="shrink-0 border-b">
              <SheetTitle>{panelTitle}</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">{panelBody}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function NoteCard({
  note,
  selected,
  onOpen,
}: {
  note: Note;
  selected: boolean;
  onOpen: () => void;
}) {
  const SourceIcon = note.source === "voice" ? Mic : Keyboard;
  return (
    <button type="button" onClick={onOpen} className="block w-full text-left">
      <Card
        className={cn(
          "gap-2 py-4 transition-colors hover:bg-accent/50",
          selected && "border-primary",
        )}
      >
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{note.title || "Sin título"}</CardTitle>
          <CardDescription className="flex items-center gap-1.5 text-xs">
            <SourceIcon className="size-3.5" />
            {formatDate(note.createdAt)}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <p className="line-clamp-2 text-sm text-muted-foreground">{note.cleanText}</p>
        </CardContent>
      </Card>
    </button>
  );
}

function NoteComposer({ onCreated }: { onCreated: (note: Note) => void }) {
  const { token } = useAuth();
  const [text, setText] = useState("");
  const [dictated, setDictated] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleTranscript = (t: string) => {
    const chunk = t.trim();
    if (!chunk) return;
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${chunk}` : chunk));
    setDictated(true);
  };

  const save = async () => {
    if (!token || !text.trim()) return;
    const source: NoteSource = dictated ? "voice" : "typed";
    setSaving(true);
    try {
      const note = await createNote(token, { rawText: text.trim(), source });
      toast("Nota creada");
      onCreated(note);
    } catch {
      toast.error("No se pudo crear la nota.");
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <p className="text-sm text-muted-foreground">
        Escribí o dictá tu nota. Al guardar, la IA genera el título y la versión limpia.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Escribí tu nota…"
        aria-label="Texto de la nota"
        autoFocus
        className="min-h-40 flex-1 resize-none"
      />
      <div className="flex shrink-0 items-start gap-2">
        <MicButton onTranscript={handleTranscript} disabled={saving} />
        <Button className="ml-auto" onClick={() => void save()} disabled={saving || !text.trim()}>
          {saving && <Spinner />}
          Guardar
        </Button>
      </div>
    </div>
  );
}
