"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Copy, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { askMeeting, type MeetingDetail } from "@/lib/api";

export interface QaTabProps {
  meeting: MeetingDetail;
  /** [Tn] anchor targets — same ids the transcript view renders (`turn-{id}`). */
  knownIds?: ReadonlySet<string>;
  onNavigateToTurn: (turnId: string) => void;
}

const SUGGESTED_QUESTIONS = [
  "¿Qué decisiones se tomaron?",
  "¿Qué quedó pendiente?",
  "Redactá un mail de seguimiento",
];

interface QaMessage {
  q: string;
  a: string;
}

const storageKey = (meetingId: string) => `meeting:${meetingId}:qa`;
const autoPromptKey = (meetingId: string) => `meeting:${meetingId}:qa:autoprompt`;

function loadThread(meetingId: string): QaMessage[] {
  if (typeof window === "undefined") return [];
  const raw = window.sessionStorage.getItem(storageKey(meetingId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as QaMessage[];
  } catch {
    return [];
  }
}

function saveThread(meetingId: string, messages: QaMessage[]) {
  window.sessionStorage.setItem(storageKey(meetingId), JSON.stringify(messages));
}

export function QaTab({ meeting, knownIds, onNavigateToTurn }: QaTabProps) {
  const { token } = useAuth();
  const meetingId = meeting.meetingId;

  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadThread(meetingId));
  }, [meetingId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !token) return;
      setDraft("");
      setPending(q);
      try {
        const { answer } = await askMeeting(token, meetingId, q);
        setMessages((prev) => {
          const next = [...prev, { q, a: answer }];
          saveThread(meetingId, next);
          return next;
        });
      } catch {
        toast.error("No se pudo responder la pregunta");
        setDraft(q);
      } finally {
        setPending(null);
      }
    },
    [token, meetingId],
  );

  // Kit prompts deep-link here: /meeting?id=X&prompt=<encoded> auto-sends once.
  // The sessionStorage marker is written BEFORE the request so a remount while
  // the answer is in flight (tab switch, xl-breakpoint resize) can't re-send.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!token || autoSent.current) return;
    autoSent.current = true;
    const prompt = new URLSearchParams(window.location.search).get("prompt");
    if (!prompt) return;
    if (window.sessionStorage.getItem(autoPromptKey(meetingId)) === prompt) return;
    if (loadThread(meetingId).some((m) => m.q === prompt)) return;
    window.sessionStorage.setItem(autoPromptKey(meetingId), prompt);
    void send(prompt);
  }, [token, meetingId, send]);

  function copyAnswer(text: string) {
    navigator.clipboard.writeText(text);
    toast("Copiado");
  }

  const empty = messages.length === 0 && !pending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Preguntale a la reunión</h2>
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6">
          <p className="mb-1 text-xs text-muted-foreground">Probá con:</p>
          {SUGGESTED_QUESTIONS.map((q) => (
            <Button
              key={q}
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={!token}
              onClick={() => send(q)}
            >
              {q}
            </Button>
          ))}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 px-4">
          <div className="flex flex-col gap-3 py-4">
            {messages.map((m, i) => (
              <Fragment key={i}>
                <UserBubble question={m.q} />
                <div className="group flex max-w-[85%] items-start gap-1 self-start">
                  <div className="rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm">
                    <Markdown
                      text={m.a}
                      onNavigate={onNavigateToTurn}
                      knownIds={knownIds}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mt-1 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Copiar respuesta"
                    onClick={() => copyAnswer(m.a)}
                  >
                    <Copy />
                  </Button>
                </div>
              </Fragment>
            ))}
            {pending && (
              <>
                <UserBubble question={pending} />
                <div className="flex items-center gap-1 self-start rounded-lg rounded-bl-sm bg-muted px-3 py-3">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
              </>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>
      )}

      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={draft}
            placeholder="Preguntá algo…"
            className="max-h-32 min-h-9 flex-1 resize-none py-2"
            disabled={!!pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!pending) send(draft);
              }
            }}
          />
          <Button
            size="icon"
            className="shrink-0"
            aria-label="Enviar pregunta"
            disabled={!!pending || !draft.trim() || !token}
            onClick={() => send(draft)}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ question }: { question: string }) {
  return (
    <div className="max-w-[85%] self-end rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
      {question}
    </div>
  );
}
