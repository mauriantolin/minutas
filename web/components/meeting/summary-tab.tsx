"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { TurnRefText } from "@/components/turn-ref-text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  askMeeting,
  reprocessMeeting,
  type ExtractedActionItem,
  type ExtractedItem,
  type Extraction,
  type MeetingDetail,
} from "@/lib/api";
import { CONFIG } from "@/lib/config";
import { initials } from "@/lib/format";
import { getOverrides, setActionItemDone } from "@/lib/overrides";

export interface SummaryTabProps {
  meeting: MeetingDetail;
  /** [Tn] anchor targets — same ids the transcript view renders (`turn-{id}`). */
  knownIds?: ReadonlySet<string>;
  onNavigateToTurn: (turnId: string) => void;
}

// Canned prompts for summary variants — executed via the existing POST /ask;
// results are client-side only ("variante generada, no guardada").
const SUMMARY_VARIANTS = [
  {
    label: "Corto",
    prompt: "Generá un resumen corto (5 líneas) de esta reunión.",
  },
  {
    label: "Detallado",
    prompt: "Generá un resumen detallado de esta reunión, organizado por temas.",
  },
  {
    label: "Detallado con citas",
    prompt:
      "Generá un resumen detallado de esta reunión. Incluí citas [Tn] a los turnos de la transcripción que respalden cada afirmación.",
  },
  {
    label: "Resumen + acciones",
    prompt:
      "Generá un resumen de esta reunión seguido de la lista de acciones acordadas, con responsable y fecha si se mencionaron.",
  },
] as const;

type SummaryVariant = (typeof SUMMARY_VARIANTS)[number];

const DETAILED_VARIANT = SUMMARY_VARIANTS[1];

const stripRefs = (text: string) => text.replace(/\s*\[T\d+\]/g, "");

/** Minimal inline-Markdown cleanup — emphasis markers read as noise in the UI. */
const stripEmphasis = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1");

const withTurnRef = (item: ExtractedItem) =>
  item.turnId && !item.text.includes(`[${item.turnId}]`)
    ? `${item.text} [${item.turnId}]`
    : item.text;

// ---------------------------------------------------------------------------
// Markdown-lite rendering of the published summary artifact (spec §3.5): the
// pipeline emits headings/bullets/paragraphs with inline [Tn] anchors, which
// must render as links — never literal text — so a full MD lib is overkill.
// ---------------------------------------------------------------------------

type MdBlock =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "para"; text: string };

function parseMarkdownBlocks(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) {
      blocks.push({ kind: "para", text: para.join("\n") });
      para = [];
    }
  };
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(t);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(t);
    if (item) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item[1]!);
      else blocks.push({ kind: "list", items: [item[1]!] });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

function copyText(text: string) {
  navigator.clipboard.writeText(text);
  toast("Copiado");
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\[t\d+\]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Fuzzy claim↔bullet match: containment or ≥60 % shared significant tokens. */
function claimMatchesText(claim: string, text: string): boolean {
  const c = normalize(claim);
  const t = normalize(text);
  if (!c || !t) return false;
  if (t.includes(c) || c.includes(t)) return true;
  const ct = new Set(c.split(" ").filter((w) => w.length > 3));
  const tt = new Set(t.split(" ").filter((w) => w.length > 3));
  if (ct.size === 0 || tt.size === 0) return false;
  let shared = 0;
  for (const w of ct) if (tt.has(w)) shared++;
  return shared / Math.min(ct.size, tt.size) >= 0.6;
}

/** Best-effort PATCH (spec §2 delta); localStorage override is the fallback. */
function patchActionItemDone(token: string, meetingId: string, id: string, done: boolean) {
  fetch(`${CONFIG.apiUrl}/meetings/${encodeURIComponent(meetingId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ actionItems: [{ id, done }] }),
  }).catch(() => undefined);
}

export function SummaryTab({ meeting, knownIds, onNavigateToTurn }: SummaryTabProps) {
  const { token } = useAuth();
  const { extraction, verification, summaryArtifact } = meeting;
  const summary = meeting.summary;

  const unsupportedClaims = useMemo(
    () =>
      meeting.status === "needs_review"
        ? (verification?.claims ?? []).filter((c) => c.verdict === "UNSUPPORTED")
        : [],
    [meeting.status, verification],
  );

  // --- Regenerated variant (client-side only, never saved) ---
  const [variant, setVariant] = useState<{ label: string; text: string } | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);

  async function generate(v: SummaryVariant) {
    if (!token || generating) return;
    setGenerating(v.label);
    try {
      const { answer } = await askMeeting(token, meeting.meetingId, v.prompt);
      setVariant({ label: v.label, text: answer });
    } catch {
      toast.error("No se pudo generar la variante");
    } finally {
      setGenerating(null);
    }
  }

  // --- Reprocess (needs_review recovery) ---
  const [reprocessing, setReprocessing] = useState(false);

  async function reprocess() {
    if (!token || reprocessing) return;
    setReprocessing(true);
    try {
      await reprocessMeeting(token, meeting.meetingId);
      toast("Reprocesamiento iniciado");
    } catch {
      toast.error("No se pudo reprocesar la reunión");
      setReprocessing(false);
    }
  }

  // --- Action items (extraction artifact preferred, legacy summary fallback) ---
  const actionItems = useMemo<ExtractedActionItem[]>(
    () =>
      extraction?.actionItems?.length
        ? extraction.actionItems
        : (summary?.actionItems ?? []),
    [extraction, summary],
  );

  // Keyed by item text (items carry no id yet — foundation open issue #2).
  const [doneMap, setDoneMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setDoneMap(getOverrides(meeting.meetingId).actionItemsDone);
  }, [meeting.meetingId]);

  const isDone = (item: ExtractedActionItem) =>
    doneMap[item.text] ?? item.done ?? false;

  function toggleDone(item: ExtractedActionItem, done: boolean) {
    setDoneMap((prev) => ({ ...prev, [item.text]: done }));
    setActionItemDone(meeting.meetingId, item.text, done);
    if (token) patchActionItemDone(token, meeting.meetingId, item.text, done);
  }

  function copyChecklist() {
    const md = actionItems
      .map(
        (i) =>
          `- [${isDone(i) ? "x" : " "}] ${stripRefs(i.text)}${i.owner ? ` — ${i.owner}` : ""}`,
      )
      .join("\n");
    copyText(md);
  }

  const displayedText = variant?.text ?? summaryArtifact?.text ?? summary?.summary;
  const loading = meeting.status === "processing" && !displayedText;

  const isFlagged = (text: string) =>
    unsupportedClaims.some((c) => claimMatchesText(c.claim, text));

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
        {meeting.status === "needs_review" && (
          <Alert className="border-chart-4/50 [&>svg]:text-chart-4">
            <TriangleAlert />
            <AlertTitle>Revisión pendiente</AlertTitle>
            <AlertDescription className="gap-2">
              <p>
                Esta reunión quedó marcada para revisión: la verificación
                automática encontró afirmaciones sin respaldo en la
                transcripción. Los puntos afectados están señalados abajo.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={reprocessing}
                onClick={reprocess}
              >
                {reprocessing && <Spinner className="size-3" />}
                Reprocesar
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Resumen</CardTitle>
            {(summaryArtifact || summary || variant) && (
              <CardAction>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={!!generating}>
                      Regenerar
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {SUMMARY_VARIANTS.map((v) => (
                      <DropdownMenuItem key={v.label} onSelect={() => generate(v)}>
                        {v.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : displayedText ? (
              <div className="relative">
                {generating && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50">
                    <Spinner />
                  </div>
                )}
                <div className={generating ? "opacity-50" : undefined}>
                  {variant ? (
                    <>
                      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Variante «{variant.label}» generada, no guardada.</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Copiar variante"
                          onClick={() => copyText(variant.text)}
                        >
                          <Copy />
                        </Button>
                        {(summaryArtifact || summary) && (
                          <Button variant="ghost" size="xs" onClick={() => setVariant(null)}>
                            Ver guardado
                          </Button>
                        )}
                      </div>
                      <TurnRefText
                        text={variant.text}
                        onNavigate={onNavigateToTurn}
                        knownIds={knownIds}
                        className="text-sm leading-6"
                      />
                    </>
                  ) : summaryArtifact ? (
                    <ArtifactSummary
                      text={summaryArtifact.text}
                      knownIds={knownIds}
                      onNavigateToTurn={onNavigateToTurn}
                      isFlagged={isFlagged}
                    />
                  ) : (
                    summary && (
                      <>
                        <TurnRefText
                          text={summary.summary}
                          onNavigate={onNavigateToTurn}
                          knownIds={knownIds}
                          className="text-sm leading-6"
                        />
                        {summary.keyPoints.length > 0 && (
                          <>
                            <Separator className="my-4" />
                            <h3 className="text-sm font-medium">Puntos clave</h3>
                            <ul className="mt-2 space-y-1.5">
                              {summary.keyPoints.map((kp, i) => (
                                <li key={i} className="flex gap-1.5 text-sm leading-6">
                                  <ChevronRight className="mt-1.5 size-3.5 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0">
                                    <TurnRefText
                                      text={kp}
                                      onNavigate={onNavigateToTurn}
                                      knownIds={knownIds}
                                    />
                                    {isFlagged(kp) && <UnsupportedFlag />}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </>
                    )
                  )}
                </div>
              </div>
            ) : (
              <Empty className="border-0 p-6 md:p-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>Todavía no hay resumen</EmptyTitle>
                  <EmptyDescription>
                    Generá uno a partir de la transcripción de esta reunión.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  disabled={!!generating || !token}
                  onClick={() => generate(DETAILED_VARIANT)}
                >
                  {generating && <Spinner />}
                  Generar resumen
                </Button>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acciones</CardTitle>
          </CardHeader>
          <CardContent>
            {actionItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No se registraron acciones en esta reunión.
              </p>
            ) : (
              <ul className="space-y-1">
                {actionItems.map((item, i) => {
                  const done = isDone(item);
                  return (
                    <li key={item.text + i} className="flex items-start gap-3 py-1.5">
                      <Checkbox
                        className="mt-0.5"
                        checked={done}
                        onCheckedChange={(v) => toggleDone(item, v === true)}
                        aria-label={`Marcar acción como ${done ? "pendiente" : "hecha"}`}
                      />
                      <span
                        className={
                          done
                            ? "min-w-0 text-sm leading-6 text-muted-foreground line-through"
                            : "min-w-0 text-sm leading-6"
                        }
                      >
                        <TurnRefText
                          text={withTurnRef(item)}
                          onNavigate={onNavigateToTurn}
                          knownIds={knownIds}
                        />
                      </span>
                      {item.owner && (
                        <Badge variant="secondary" className="ml-auto shrink-0 gap-1">
                          <Avatar className="size-4">
                            <AvatarFallback className="text-[8px]">
                              {initials(item.owner)}
                            </AvatarFallback>
                          </Avatar>
                          {item.owner}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
          {actionItems.length > 0 && (
            <CardFooter>
              <Button variant="ghost" size="sm" onClick={copyChecklist}>
                <Copy />
                Copiar como lista
              </Button>
            </CardFooter>
          )}
        </Card>

        <SummaryExtraction
          extraction={extraction}
          knownIds={knownIds}
          onNavigateToTurn={onNavigateToTurn}
        />
      </div>
    </TooltipProvider>
  );
}

function UnsupportedFlag() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TriangleAlert
          className="ml-1.5 inline size-3.5 align-[-2px] text-chart-4"
          aria-label="Sin respaldo en la transcripción"
        />
      </TooltipTrigger>
      <TooltipContent>Sin respaldo en la transcripción</TooltipContent>
    </Tooltip>
  );
}

/** Published summary artifact (spec §3.5): full Markdown with [Tn] anchors. */
function ArtifactSummary({
  text,
  knownIds,
  onNavigateToTurn,
  isFlagged,
}: {
  text: string;
  knownIds?: ReadonlySet<string>;
  onNavigateToTurn: (turnId: string) => void;
  isFlagged: (text: string) => boolean;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="space-y-3">
      {blocks.map((block, i) =>
        block.kind === "heading" ? (
          <h3 key={i} className="text-sm font-medium">
            {stripEmphasis(block.text)}
          </h3>
        ) : block.kind === "list" ? (
          <ul key={i} className="space-y-1.5">
            {block.items.map((item, j) => (
              <li key={j} className="flex gap-1.5 text-sm leading-6">
                <ChevronRight className="mt-1.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <TurnRefText
                    text={stripEmphasis(item)}
                    onNavigate={onNavigateToTurn}
                    knownIds={knownIds}
                  />
                  {isFlagged(item) && <UnsupportedFlag />}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="text-sm leading-6">
            <TurnRefText
              text={stripEmphasis(block.text)}
              onNavigate={onNavigateToTurn}
              knownIds={knownIds}
            />
            {isFlagged(block.text) && <UnsupportedFlag />}
          </p>
        ),
      )}
    </div>
  );
}

function SummaryExtraction({
  extraction,
  knownIds,
  onNavigateToTurn,
}: {
  extraction?: Extraction;
  knownIds?: ReadonlySet<string>;
  onNavigateToTurn: (turnId: string) => void;
}) {
  const sections = [
    { title: "Decisiones", items: extraction?.decisions },
    { title: "Preguntas abiertas", items: extraction?.openQuestions },
    { title: "Números clave", items: extraction?.keyNumbers },
  ].filter((s): s is { title: string; items: ExtractedItem[] } => !!s.items?.length);

  if (sections.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Destacados</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections.map((section) => (
          <div key={section.title}>
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {section.title}
            </h3>
            <ul className="mt-2 space-y-1.5">
              {section.items.map((item, i) => (
                <li key={i} className="flex gap-1.5 text-sm leading-6">
                  <ChevronRight className="mt-1.5 size-3.5 shrink-0 text-muted-foreground" />
                  <TurnRefText
                    text={withTurnRef(item)}
                    onNavigate={onNavigateToTurn}
                    knownIds={knownIds}
                    className="min-w-0"
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
