"use client";

import { useEffect, useRef } from "react";
import { Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/auth-provider";
import { useTranscribeStream } from "@/lib/use-transcribe-stream";

export function MicButton({
  onTranscript,
  disabled = false,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const { token } = useAuth();
  const { status, partial, finalText, error, start, stop, reset } = useTranscribeStream(token);
  const recording = status === "recording";
  const wasRecording = useRef(false);

  useEffect(() => {
    if (status === "recording") {
      wasRecording.current = true;
      return;
    }
    if (!wasRecording.current && status !== "error") return;
    wasRecording.current = false;
    if (status === "error" && error) toast.error(error);
    const text = finalText.trim();
    if (text) onTranscript(text);
    reset();
  }, [status, error, finalText, onTranscript, reset]);

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || !token}
        aria-pressed={recording}
        onClick={() => (recording ? stop() : void start())}
      >
        {recording ? (
          <>
            <Square />
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-red-500" />
            </span>
            Detener
          </>
        ) : (
          <>
            <Mic />
            Dictar
          </>
        )}
      </Button>
      {recording && (
        <p aria-live="polite" className="text-xs italic text-muted-foreground">
          {partial || "Escuchando…"}
        </p>
      )}
    </div>
  );
}
