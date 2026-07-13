"use client";

import { Fragment, useEffect, useRef } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ChatMessageItem {
  q: string;
  a?: React.ReactNode;
  /** Raw answer text for the hover Copy button; omit to hide it. */
  aRaw?: string;
}

export interface ChatMessagesProps {
  items: ChatMessageItem[];
  /** Question currently in flight — rendered as a user bubble + 3-dot pulse. */
  pending?: string | null;
  /** Rendered instead of the list while there are no items and nothing pending. */
  emptyState?: React.ReactNode;
}

export function ChatMessages({ items, pending, emptyState }: ChatMessagesProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, pending]);

  function copyAnswer(text: string) {
    navigator.clipboard.writeText(text);
    toast("Copiado");
  }

  if (items.length === 0 && !pending && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <ScrollArea className="min-h-0 flex-1 px-4">
      <div className="flex flex-col gap-3 py-4">
        {items.map((m, i) => {
          const raw = m.aRaw;
          return (
            <Fragment key={i}>
              <UserBubble question={m.q} />
              {m.a != null && (
                <div className="group flex max-w-[85%] items-start gap-1 self-start">
                  <div className="rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm">
                    {m.a}
                  </div>
                  {raw != null && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mt-1 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Copiar respuesta"
                      onClick={() => copyAnswer(raw)}
                    >
                      <Copy />
                    </Button>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
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
  );
}

function UserBubble({ question }: { question: string }) {
  return (
    <div className="max-w-[85%] self-end rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
      {question}
    </div>
  );
}
