"use client";

import { useState } from "react";
import { Keyboard, Mic, Sparkles, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/components/auth-provider";
import { deleteNote, updateNote, type Note } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface NoteEditorProps {
  note: Note;
  onSaved: (note: Note) => void;
  onDeleted: (noteId: string) => void;
}

/** Mount with `key={note.noteId}` so local drafts reset when switching notes. */
export function NoteEditor({ note, onSaved, onDeleted }: NoteEditorProps) {
  const { token } = useAuth();
  const [title, setTitle] = useState(note.title);
  const [cleanText, setCleanText] = useState(note.cleanText);
  const [rawText, setRawText] = useState(note.rawText);
  const [saving, setSaving] = useState(false);
  const [recleaning, setRecleaning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const busy = saving || recleaning || deleting;

  const applyServer = (updated: Note) => {
    setTitle(updated.title);
    setCleanText(updated.cleanText);
    setRawText(updated.rawText);
    onSaved(updated);
  };

  const save = async () => {
    if (!token) return;
    const body: { title?: string; cleanText?: string; rawText?: string } = {};
    if (title !== note.title) body.title = title;
    if (cleanText !== note.cleanText) body.cleanText = cleanText;
    if (rawText !== note.rawText) body.rawText = rawText;
    if (Object.keys(body).length === 0) {
      toast("No hay cambios para guardar");
      return;
    }
    setSaving(true);
    try {
      applyServer(await updateNote(token, note.noteId, body));
      toast("Nota guardada");
    } catch {
      toast.error("No se pudo guardar la nota.");
    } finally {
      setSaving(false);
    }
  };

  const reclean = async () => {
    if (!token) return;
    setRecleaning(true);
    try {
      applyServer(await updateNote(token, note.noteId, { reclean: true }));
      toast("Nota limpiada con IA");
    } catch {
      toast.error("No se pudo limpiar la nota.");
    } finally {
      setRecleaning(false);
    }
  };

  const remove = async () => {
    if (!token) return;
    setDeleting(true);
    try {
      await deleteNote(token, note.noteId);
      toast("Nota eliminada");
      onDeleted(note.noteId);
    } catch {
      toast.error("No se pudo eliminar la nota.");
      setDeleting(false);
    }
  };

  const SourceIcon = note.source === "voice" ? Mic : Keyboard;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Título"
        aria-label="Título de la nota"
      />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SourceIcon className="size-3.5" />
        <span>{note.source === "voice" ? "Dictada" : "Escrita"}</span>
        <span aria-hidden>·</span>
        <span>{formatDateTime(note.createdAt)}</span>
      </div>

      <Tabs defaultValue="clean" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="clean">Limpia</TabsTrigger>
          <TabsTrigger value="raw">Original</TabsTrigger>
        </TabsList>
        <TabsContent value="clean" className="min-h-0 flex-1">
          <Textarea
            value={cleanText}
            onChange={(e) => setCleanText(e.target.value)}
            placeholder="Versión limpia de la nota…"
            aria-label="Texto limpio"
            className="h-full min-h-40 resize-none"
          />
        </TabsContent>
        <TabsContent value="raw" className="min-h-0 flex-1">
          <Textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Texto original…"
            aria-label="Texto original"
            className="h-full min-h-40 resize-none"
          />
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 items-center gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {saving && <Spinner />}
          Guardar
        </Button>
        <Button variant="outline" onClick={() => void reclean()} disabled={busy}>
          {recleaning ? <Spinner /> : <Sparkles />}
          Limpiar con IA
        </Button>
        <Button
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
        >
          <Trash2 />
          Eliminar
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta nota?</AlertDialogTitle>
            <AlertDialogDescription>
              La nota se quita de tu memoria y no se puede recuperar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
