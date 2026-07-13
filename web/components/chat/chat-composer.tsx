"use client";

import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ChatComposerProps {
  /** Disables input and send while a request is in flight. */
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  /** Controlled draft — pass with `onValueChange` to own it (e.g. restore on error). */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Extra gate for the send button only (e.g. missing auth token). */
  sendDisabled?: boolean;
}

export function ChatComposer({
  disabled,
  placeholder,
  onSend,
  value,
  onValueChange,
  sendDisabled = false,
}: ChatComposerProps) {
  const [inner, setInner] = useState("");
  const controlled = value !== undefined;
  const draft = controlled ? value : inner;
  const setDraft = onValueChange ?? setInner;

  const send = () => {
    if (!draft.trim()) return;
    onSend(draft);
    if (!controlled) setInner("");
  };

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          rows={1}
          value={draft}
          placeholder={placeholder}
          className="max-h-32 min-h-9 flex-1 resize-none py-2"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled) send();
            }
          }}
        />
        <Button
          size="icon"
          className="shrink-0"
          aria-label="Enviar pregunta"
          disabled={disabled || sendDisabled || !draft.trim()}
          onClick={send}
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
