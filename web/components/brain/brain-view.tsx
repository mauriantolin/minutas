"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brain, Plus, Trash2 } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/components/auth-provider";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessages } from "@/components/chat/chat-messages";
import { SourceRefText } from "@/components/chat/source-ref-text";
import { SourceCards } from "@/components/brain/source-cards";
import { Markdown } from "@/components/markdown";
import {
  brainAsk,
  deleteBrainThread,
  getBrainThread,
  listBrainThreads,
  type BrainCitation,
  type BrainMessage,
  type BrainThreadSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const STAGES = [
  "Buscando en la memoria…",
  "Leyendo fragmentos…",
  "Redactando respuesta…",
] as const;

const SUGGESTIONS: { label: string; draft?: string }[] = [
  { label: "¿Qué decidimos sobre…?", draft: "¿Qué decidimos sobre " },
  { label: "¿Qué quedó pendiente esta semana?" },
  { label: "Buscá mis notas sobre…", draft: "Buscá mis notas sobre " },
];

interface QaItem {
  q: string;
  a?: string;
  citations?: BrainCitation[];
}

function pairMessages(messages: BrainMessage[]): QaItem[] {
  const items: QaItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ q: m.text });
    } else {
      const last = items[items.length - 1];
      if (last && last.a === undefined) {
        last.a = m.text;
        last.citations = m.citations;
      }
    }
  }
  return items;
}

export function BrainView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("t");
  const { token } = useAuth();

  const [threads, setThreads] = useState<BrainThreadSummary[] | null>(null);
  const [items, setItems] = useState<QaItem[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [draft, setDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BrainThreadSummary | null>(null);

  const loadedThreadRef = useRef<string | null>(null);

  const refetchThreads = useCallback(async () => {
    if (!token) return;
    try {
      const { threads: list } = await listBrainThreads(token);
      setThreads(list);
    } catch {
      setThreads((prev) => prev ?? []);
      toast.error("No se pudieron cargar las conversaciones");
    }
  }, [token]);

  useEffect(() => {
    void refetchThreads();
  }, [refetchThreads]);

  useEffect(() => {
    if (!token) return;
    if (!threadId) {
      loadedThreadRef.current = null;
      setItems([]);
      return;
    }
    if (loadedThreadRef.current === threadId) return;
    loadedThreadRef.current = threadId;
    setLoadingThread(true);
    getBrainThread(token, threadId)
      .then((thread) => setItems(pairMessages(thread.messages)))
      .catch(() => toast.error("No se pudo cargar la conversación"))
      .finally(() => setLoadingThread(false));
  }, [token, threadId]);

  useEffect(() => {
    if (!pending) return;
    setStage(0);
    const t1 = setTimeout(() => setStage(1), 2500);
    const t2 = setTimeout(() => setStage(2), 5000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [pending]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !token) return;
      setDraft("");
      setPending(q);
      try {
        const res = await brainAsk(token, {
          threadId: threadId ?? undefined,
          message: q,
        });
        setItems((prev) => [...prev, { q, a: res.answer, citations: res.citations }]);
        if (!threadId) {
          loadedThreadRef.current = res.threadId;
          router.replace(`/brain?t=${encodeURIComponent(res.threadId)}`);
        }
        void refetchThreads();
      } catch {
        toast.error("No se pudo responder la pregunta");
        setDraft(q);
      } finally {
        setPending(null);
      }
    },
    [token, threadId, router, refetchThreads],
  );

  const openThread = (id: string) => {
    if (id === threadId) return;
    router.replace(`/brain?t=${encodeURIComponent(id)}`);
  };

  const newConversation = () => {
    loadedThreadRef.current = null;
    setItems([]);
    router.replace("/brain");
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || !token) return;
    setDeleteTarget(null);
    try {
      await deleteBrainThread(token, target.threadId);
      setThreads((prev) => prev?.filter((t) => t.threadId !== target.threadId) ?? prev);
      if (threadId === target.threadId) newConversation();
      toast("Conversación eliminada");
    } catch {
      toast.error("No se pudo eliminar la conversación");
    }
  };

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <h1 className="text-xl font-semibold tracking-tight">Memoria</h1>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 lg:hidden">
        <Select value={threadId ?? ""} onValueChange={openThread}>
          <SelectTrigger size="sm" className="min-w-0 flex-1">
            <SelectValue placeholder="Conversaciones" />
          </SelectTrigger>
          <SelectContent>
            {(threads ?? []).map((th) => (
              <SelectItem key={th.threadId} value={th.threadId}>
                {th.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={newConversation}
        >
          <Plus />
          Nueva
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r lg:flex">
          <div className="p-3">
            <Button size="sm" className="w-full" onClick={newConversation}>
              <Plus />
              Nueva conversación
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 px-3 pb-3">
              {threads === null ? (
                [0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full" />)
              ) : threads.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  Todavía no hay conversaciones.
                </p>
              ) : (
                threads.map((th) => (
                  <div
                    key={th.threadId}
                    className={cn(
                      "group flex items-center rounded-md transition-colors hover:bg-accent/60",
                      th.threadId === threadId && "bg-accent",
                    )}
                  >
                    <button
                      className="min-w-0 flex-1 px-2 py-1.5 text-left"
                      onClick={() => openThread(th.threadId)}
                    >
                      <span className="block truncate text-sm">{th.title}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {new Date(th.updatedAt).toLocaleDateString("es-AR")}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Eliminar conversación"
                      onClick={() => setDeleteTarget(th)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          {loadingThread ? (
            <div className="grid flex-1 place-items-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : (
            <ChatMessages
              items={items.map((m) => ({
                q: m.q,
                a:
                  m.a != null ? (
                    <div className="flex flex-col gap-2">
                      <Markdown
                        text={m.a}
                        renderInline={(text, key) => (
                          <SourceRefText key={key} text={text} />
                        )}
                      />
                      {m.citations && m.citations.length > 0 && (
                        <SourceCards citations={m.citations} />
                      )}
                    </div>
                  ) : undefined,
                aRaw: m.a,
              }))}
              pending={pending}
              emptyState={
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6">
                  <Brain className="mb-1 size-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Preguntale a tu memoria</p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Busca en todas tus reuniones y notas.
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <Button
                      key={s.label}
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      disabled={!token}
                      onClick={() => (s.draft ? setDraft(s.draft) : send(s.label))}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {pending && (
            <p className="shrink-0 px-4 pb-1 text-xs text-muted-foreground">
              {STAGES[stage]}
            </p>
          )}

          <ChatComposer
            disabled={!!pending || loadingThread}
            sendDisabled={!token}
            placeholder="Preguntá algo sobre tus reuniones y notas…"
            value={draft}
            onValueChange={setDraft}
            onSend={send}
          />
        </main>
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar conversación?</AlertDialogTitle>
            <AlertDialogDescription>
              Se va a borrar «{deleteTarget?.title}» con todos sus mensajes. Esta
              acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
