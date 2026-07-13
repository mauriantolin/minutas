"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TriangleAlert } from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/components/auth-provider";
import { useIsXl, useMeeting, usePolling } from "@/lib/hooks";
import { deleteMeeting, reprocessMeeting } from "@/lib/api";
import {
  getOverrides,
  patchMeetingOverride,
  patchSegmentOverride,
  type MeetingOverrides,
  type SegmentOverride,
} from "@/lib/overrides";
import {
  buildTurns,
  patchMeetingRemote,
  speakerColors,
  turnIdSet,
} from "@/components/meeting/detail-api";
import {
  buildMeetingMarkdown,
  buildTranscriptText,
  downloadFile,
  exportFileName,
  MeetingPrintView,
} from "@/components/meeting/detail-export";
import { DetailHeader, type ExportFormat } from "@/components/meeting/detail-header";
import { TranscriptTab, type NavTarget } from "@/components/meeting/transcript-tab";
import { StatsTab } from "@/components/meeting/stats-tab";
import { SummaryTab } from "@/components/meeting/summary-tab";
import { QaTab } from "@/components/meeting/qa-tab";

export default function MeetingPage() {
  return (
    <Suspense
      fallback={
        <div className="grid h-svh place-items-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      }
    >
      <MeetingDetailScreen />
    </Suspense>
  );
}

function MeetingDetailScreen() {
  const params = useSearchParams();
  const id = params.get("id");
  const router = useRouter();
  const { token } = useAuth();
  const { meeting, loading, error, refetch, mutate } = useMeeting(id);

  const [overrides, setOverrides] = useState<MeetingOverrides | null>(null);
  useEffect(() => {
    setOverrides(id ? getOverrides(id) : null);
  }, [id]);

  usePolling(meeting?.status === "processing" ? 10_000 : null, refetch);

  const [tab, setTab] = useState("transcript");
  const [navTarget, setNavTarget] = useState<NavTarget | null>(null);
  const [reprocessOpen, setReprocessOpen] = useState(false);

  // Q&A mounts exactly once: xl rail OR "Preguntar" tab, never both (a hidden
  // duplicate would double-fire the ?prompt= auto-send and fork the thread).
  const isXl = useIsXl();
  useEffect(() => {
    if (isXl && tab === "ask") setTab("transcript");
  }, [isXl, tab]);

  const navigateToTurn = useCallback((turnId: string) => {
    setTab("transcript");
    setNavTarget({ turnId, nonce: Date.now() });
  }, []);

  const turnParam = params.get("turn");
  const turnDeepLinkDone = useRef(false);
  useEffect(() => {
    if (!turnParam || turnDeepLinkDone.current || !meeting || !overrides) return;
    turnDeepLinkDone.current = true;
    navigateToTurn(turnParam);
  }, [turnParam, meeting, overrides, navigateToTurn]);

  const turns = useMemo(
    () => (meeting && overrides ? buildTurns(meeting, overrides) : []),
    [meeting, overrides],
  );
  const knownIds = useMemo(() => turnIdSet(turns), [turns]);
  const colors = useMemo(
    () => speakerColors(turns, meeting?.participants ?? []),
    [turns, meeting?.participants],
  );
  const colorOf = useCallback(
    (speaker: string) => colors.get(speaker) ?? "var(--chart-1)",
    [colors],
  );

  if (!id) {
    return (
      <div className="grid h-svh place-items-center text-sm text-muted-foreground">
        Reunión no encontrada.
      </div>
    );
  }
  if (error && !meeting) {
    return (
      <div className="grid h-svh place-items-center px-6">
        <Alert variant="destructive" className="max-w-md">
          <TriangleAlert />
          <AlertTitle>No se pudo cargar la reunión</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()}>
              Reintentar
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (loading || !meeting || !overrides) {
    return (
      <div className="grid h-svh place-items-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const title = overrides.title ?? meeting.title;
  const labels = overrides.labels ?? [];

  const rename = (next: string) => {
    setOverrides(patchMeetingOverride(id, { title: next }));
    mutate({ title: next });
    if (token) void patchMeetingRemote(token, id, { title: next });
  };

  const toggleLabel = (name: string) => {
    const next = labels.includes(name) ? labels.filter((l) => l !== name) : [...labels, name];
    setOverrides(patchMeetingOverride(id, { labels: next }));
    if (token) void patchMeetingRemote(token, id, { labels: next });
  };

  const patchSegment = (segId: string, patch: SegmentOverride) => {
    setOverrides(patchSegmentOverride(id, segId, patch));
    if (token) void patchMeetingRemote(token, id, { segments: [{ id: segId, ...patch }] });
  };

  const reprocess = async () => {
    if (!token) return;
    try {
      await reprocessMeeting(token, id);
      mutate({ status: "processing", pipeline: undefined });
      toast("Reprocesando la reunión…");
    } catch {
      toast.error("No se pudo reprocesar la reunión.");
    }
  };

  const remove = async () => {
    if (!token) return;
    try {
      await deleteMeeting(token, id);
      toast("Reunión eliminada");
      router.replace("/meetings");
    } catch {
      toast.error("No se pudo eliminar la reunión.");
    }
  };

  const exportMeeting = (format: ExportFormat) => {
    if (format === "md") {
      downloadFile(exportFileName(title, "md"), buildMeetingMarkdown(meeting, title, turns), "text/markdown");
    } else if (format === "txt") {
      downloadFile(exportFileName(title, "txt"), buildTranscriptText(turns), "text/plain");
    } else if (format === "pdf") {
      window.print();
    } else {
      void navigator.clipboard.writeText(buildMeetingMarkdown(meeting, title, turns));
      toast("Copiado");
    }
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <DetailHeader
        meeting={meeting}
        title={title}
        labels={labels}
        onRename={rename}
        onToggleLabel={toggleLabel}
        onRequestReprocess={() => setReprocessOpen(true)}
        onDelete={() => void remove()}
        onExport={exportMeeting}
      />

      {meeting.status === "needs_review" && (
        <Alert className="mx-6 mt-4 border-chart-4/50 [&>svg]:text-chart-4">
          <TriangleAlert />
          <AlertTitle>Esta reunión quedó marcada para revisión</AlertTitle>
          <AlertDescription>
            <p>
              La verificación automática encontró afirmaciones sin respaldo en la transcripción.
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setReprocessOpen(true)}>
                Reprocesar
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setTab("summary")}>
                Ver resumen
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="px-6 py-3">
              <TabsList>
                <TabsTrigger value="transcript">Transcripción</TabsTrigger>
                <TabsTrigger value="summary">Resumen</TabsTrigger>
                {isXl === false && <TabsTrigger value="ask">Preguntar</TabsTrigger>}
                <TabsTrigger value="stats">Estadísticas</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent
              value="transcript"
              forceMount
              className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <TranscriptTab
                meeting={meeting}
                turns={turns}
                colorOf={colorOf}
                navTarget={navTarget}
                onPatchSegment={patchSegment}
              />
            </TabsContent>
            <TabsContent value="summary" className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <SummaryTab meeting={meeting} knownIds={knownIds} onNavigateToTurn={navigateToTurn} />
            </TabsContent>
            {isXl === false && (
              <TabsContent value="ask" className="flex min-h-0 flex-1 flex-col">
                <QaTab meeting={meeting} knownIds={knownIds} onNavigateToTurn={navigateToTurn} />
              </TabsContent>
            )}
            <TabsContent value="stats" className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <StatsTab meeting={meeting} turns={turns} colorOf={colorOf} />
            </TabsContent>
          </Tabs>
        </div>
        {isXl === true && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l">
            <QaTab meeting={meeting} knownIds={knownIds} onNavigateToTurn={navigateToTurn} />
          </aside>
        )}
      </div>

      <MeetingPrintView meeting={meeting} title={title} turns={turns} />

      <AlertDialog open={reprocessOpen} onOpenChange={setReprocessOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Reprocesar esta reunión?</AlertDialogTitle>
            <AlertDialogDescription>
              Se vuelve a ejecutar el pipeline completo: el resumen y las acciones se regeneran.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reprocess()}>Reprocesar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
