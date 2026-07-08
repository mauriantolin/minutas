"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, Mic } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/status-badge";
import { useMeeting, usePolling } from "@/lib/hooks";
import { PHASE_LABELS } from "@/lib/config";
import { formatClock, initials, meetingDuration } from "@/lib/format";
import { chartColor } from "@/lib/utils";
import type { Segment } from "@/lib/api";

const PIN_THRESHOLD_PX = 48;

function LiveSegment({ segment, colorIndex }: { segment: Segment; colorIndex: number }) {
  const color = chartColor(colorIndex);
  return (
    <div className="duration-300 animate-in fade-in slide-in-from-bottom-1">
      <div className="flex items-center gap-2">
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
          style={{ backgroundColor: color }}
        >
          {initials(segment.speaker)}
        </div>
        <span className="text-sm font-semibold" style={{ color }}>
          {segment.speaker}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatClock(segment.startTime)}
        </span>
      </div>
      <p className="pl-9 text-sm leading-6">{segment.text}</p>
    </div>
  );
}

/** Live transcript mirror (spec §3.7): read-only, 3 s poll, auto-scroll. */
export function LiveView({ meetingId }: { meetingId: string | null }) {
  const router = useRouter();
  const { meeting, loading, error, refetch } = useMeeting(meetingId);
  const status = meeting?.status;
  const terminal = status === "ready" || status === "needs_review" || status === "failed";
  usePolling(meetingId && !terminal ? 3_000 : null, refetch);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "capturing") return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [status]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const viewport = () =>
    containerRef.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null;

  const hasBody = meeting !== null;
  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const onScroll = () => {
      const pinned = vp.scrollHeight - vp.scrollTop - vp.clientHeight < PIN_THRESHOLD_PX;
      pinnedRef.current = pinned;
      setShowJump(!pinned);
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [hasBody]);

  const segmentCount = meeting?.segments.length ?? 0;
  useEffect(() => {
    if (!pinnedRef.current) return;
    const vp = viewport();
    vp?.scrollTo({ top: vp.scrollHeight });
  }, [segmentCount]);

  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!meetingId || !status) return;
    if (status === "ready" || status === "needs_review") {
      if (prevStatusRef.current && prevStatusRef.current !== status) {
        toast(
          status === "ready"
            ? "El resumen está listo"
            : "La reunión quedó marcada para revisión",
        );
      }
      router.replace(`/meeting?id=${encodeURIComponent(meetingId)}`);
    }
    prevStatusRef.current = status;
  }, [status, meetingId, router]);

  const speakerIndex = new Map<string, number>();
  for (const s of meeting?.segments ?? []) {
    if (!speakerIndex.has(s.speaker)) speakerIndex.set(s.speaker, speakerIndex.size);
  }

  const elapsed =
    meeting &&
    (meeting.endedAt
      ? meetingDuration(meeting.startedAt, meeting.endedAt)
      : formatClock((now - new Date(meeting.startedAt).getTime()) / 1000));
  const phase = meeting?.pipeline ? PHASE_LABELS[meeting.pipeline.phase] : undefined;

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        {status === "capturing" && <StatusBadge status="capturing" />}
        {meeting ? (
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
            {meeting.title}
          </h1>
        ) : (
          <Skeleton className="h-6 w-48" />
        )}
        {elapsed && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{elapsed}</span>
        )}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/meetings">Detener vista</Link>
          </Button>
        </div>
      </header>

      {!meetingId || error ? (
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Mic />
              </EmptyMedia>
              <EmptyTitle>
                {!meetingId ? "Falta el id de la reunión" : "No se pudo cargar la reunión"}
              </EmptyTitle>
              <EmptyDescription>
                <Link href="/meetings" className="underline underline-offset-4">
                  Volver a reuniones
                </Link>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : loading ? (
        <div className="grid flex-1 place-items-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      ) : (
        <div ref={containerRef} className="relative min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
              {status === "processing" && (
                <Alert>
                  <Spinner className="size-4" />
                  <AlertTitle>La reunión terminó. Generando resumen…</AlertTitle>
                  {phase && <AlertDescription>Fase actual: {phase}</AlertDescription>}
                </Alert>
              )}
              {status === "failed" && (
                <Alert variant="destructive">
                  <AlertTitle>El procesamiento falló.</AlertTitle>
                  <AlertDescription>
                    <Link href={`/meeting?id=${encodeURIComponent(meetingId)}`} className="underline underline-offset-4">
                      Abrir la reunión
                    </Link>
                  </AlertDescription>
                </Alert>
              )}
              {segmentCount === 0 && status === "capturing" && (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Spinner />
                    </EmptyMedia>
                    <EmptyTitle>Esperando transcripción…</EmptyTitle>
                    <EmptyDescription>
                      Los fragmentos van a aparecer acá a medida que se transcriben.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {meeting?.segments.map((s, i) => (
                <LiveSegment
                  key={s.segId ?? `${s.speaker}-${s.startTime}-${i}`}
                  segment={s}
                  colorIndex={speakerIndex.get(s.speaker) ?? 0}
                />
              ))}
            </div>
          </ScrollArea>
          {showJump && (
            <Button
              size="sm"
              className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full shadow-sm"
              onClick={() => {
                const vp = viewport();
                vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
              }}
            >
              <ArrowDown />
              Ir al final
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
