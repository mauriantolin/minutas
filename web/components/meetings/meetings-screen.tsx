"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DateRange } from "react-day-picker";
import { CalendarDays, Mic, Search, Tag, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { openCommandPalette } from "@/components/command-palette";
import { useAuth } from "@/components/auth-provider";
import { deleteMeeting, reprocessMeeting, type Meeting } from "@/lib/api";
import { STATUS_LABELS } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { useMeetings, usePolling } from "@/lib/hooks";
import {
  getLabelDefs,
  getOverrides,
  patchMeetingOverride,
  type LabelDef,
} from "@/lib/overrides";
import { MeetingRow } from "@/components/meetings/meeting-row";

const STATUS_FILTER: { value: string; label: string }[] = [
  { value: "capturing", label: STATUS_LABELS.capturing! },
  { value: "processing", label: STATUS_LABELS.processing! },
  { value: "ready", label: STATUS_LABELS.ready! },
  { value: "needs_review", label: STATUS_LABELS.needs_review! },
];

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Two poll cycles: enough for the server to reflect a reprocess transition,
// short enough that a stale patch can't mask a finished pipeline.
const STATUS_PATCH_TTL_MS = 120_000;

interface MergedMeeting {
  meeting: Meeting;
  labels: string[];
}

export function MeetingsScreen() {
  const { token } = useAuth();
  const searchParams = useSearchParams();
  const { meetings, loading, error, refetch } = useMeetings();
  usePolling(60_000, refetch);

  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [selParticipants, setSelParticipants] = useState<string[]>([]);
  const [selLabels, setSelLabels] = useState<string[]>([]);
  const [selStatuses, setSelStatuses] = useState<string[]>([]);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [statusPatch, setStatusPatch] = useState<Record<string, { status: string; at: number }>>(
    {},
  );
  const [labelDefs, setLabelDefs] = useState<LabelDef[]>([]);
  const [overridesVersion, setOverridesVersion] = useState(0);

  useEffect(() => {
    const load = () => {
      setLabelDefs(getLabelDefs());
      // Label deletes/renames cascade into per-meeting overrides — re-merge.
      setOverridesVersion((v) => v + 1);
    };
    load();
    window.addEventListener("app:labels-changed", load);
    return () => window.removeEventListener("app:labels-changed", load);
  }, []);

  const labelParam = searchParams.get("label");
  useEffect(() => {
    if (labelParam) setSelLabels([labelParam]);
  }, [labelParam]);

  const merged = useMemo<MergedMeeting[]>(() => {
    void overridesVersion;
    return (meetings ?? [])
      .filter((m) => !removedIds.has(m.meetingId))
      .map((m) => {
        const o = getOverrides(m.meetingId);
        // The optimistic reprocess patch only bridges the gap until the server
        // reflects the transition; once the server confirms (or the patch ages
        // out) the server status wins again, so "Procesando" can't stick forever.
        const patch = statusPatch[m.meetingId];
        const patched =
          patch &&
          (m.status === "ready" || m.status === "needs_review") &&
          Date.now() - patch.at < STATUS_PATCH_TTL_MS
            ? patch.status
            : m.status;
        return {
          meeting: {
            ...m,
            title: o.title ?? m.title,
            status: patched,
          },
          labels: o.labels ?? [],
        };
      });
  }, [meetings, removedIds, statusPatch, overridesVersion]);

  const allParticipants = useMemo(() => {
    const names = new Set<string>();
    for (const { meeting } of merged) for (const p of meeting.participants) names.add(p.name);
    return [...names].sort((a, b) => a.localeCompare(b, "es"));
  }, [merged]);

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    return merged.filter(({ meeting, labels }) => {
      if (q) {
        const hay = normalize(
          `${meeting.title} ${meeting.participants.map((p) => p.name).join(" ")}`,
        );
        if (!hay.includes(q)) return false;
      }
      if (dateRange?.from) {
        const t = new Date(meeting.startedAt).getTime();
        const from = new Date(dateRange.from).setHours(0, 0, 0, 0);
        const to = new Date(dateRange.to ?? dateRange.from).setHours(23, 59, 59, 999);
        if (t < from || t > to) return false;
      }
      if (
        selParticipants.length > 0 &&
        !meeting.participants.some((p) => selParticipants.includes(p.name))
      )
        return false;
      if (selLabels.length > 0 && !selLabels.some((l) => labels.includes(l))) return false;
      if (selStatuses.length > 0 && !selStatuses.includes(meeting.status)) return false;
      return true;
    });
  }, [merged, query, dateRange, selParticipants, selLabels, selStatuses]);

  const clearFilters = () => {
    setQuery("");
    setDateRange(undefined);
    setSelParticipants([]);
    setSelLabels([]);
    setSelStatuses([]);
  };

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const handleRename = useCallback((id: string, title: string) => {
    patchMeetingOverride(id, { title });
    setOverridesVersion((v) => v + 1);
  }, []);

  const handleToggleLabel = useCallback((id: string, label: string) => {
    const current = getOverrides(id).labels ?? [];
    patchMeetingOverride(id, {
      labels: current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label],
    });
    setOverridesVersion((v) => v + 1);
  }, []);

  // Drop optimistic patches the server already confirmed.
  useEffect(() => {
    if (!meetings) return;
    setStatusPatch((p) => {
      const confirmed = meetings.filter(
        (m) => p[m.meetingId] && m.status === p[m.meetingId]!.status,
      );
      if (confirmed.length === 0) return p;
      const rest = { ...p };
      for (const m of confirmed) delete rest[m.meetingId];
      return rest;
    });
  }, [meetings]);

  const handleReprocess = useCallback(
    async (id: string) => {
      setStatusPatch((p) => ({ ...p, [id]: { status: "processing", at: Date.now() } }));
      try {
        await reprocessMeeting(token!, id);
        toast("Reprocesamiento iniciado");
      } catch {
        setStatusPatch((p) => {
          const rest = { ...p };
          delete rest[id];
          return rest;
        });
        toast.error("No se pudo reprocesar la reunión.");
      }
    },
    [token],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setRemovedIds((prev) => new Set(prev).add(id));
      try {
        await deleteMeeting(token!, id);
        toast("Reunión eliminada");
        void refetch();
      } catch {
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.error("No se pudo eliminar la reunión.");
      }
    },
    [token, refetch],
  );

  const dateChipLabel =
    dateRange?.from &&
    `${formatDate(dateRange.from.toISOString())}${
      dateRange.to ? ` – ${formatDate(dateRange.to.toISOString())}` : ""
    }`;

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <h1 className="text-xl font-semibold tracking-tight">Reuniones</h1>
        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar reuniones…"
            className="pl-8 pr-12"
          />
          <button
            type="button"
            onClick={openCommandPalette}
            className="absolute right-2 top-1/2 -translate-y-1/2"
            aria-label="Abrir paleta de comandos"
          >
            <Kbd>⌘K</Kbd>
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <CalendarDays />
              {dateChipLabel ?? "Fecha"}
              {dateChipLabel && (
                <X
                  className="size-3.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDateRange(undefined);
                  }}
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar mode="range" selected={dateRange} onSelect={setDateRange} />
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Users />
              Participantes
              {selParticipants.length > 0 && (
                <Badge variant="secondary" className="rounded-full px-1.5">
                  {selParticipants.length}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {allParticipants.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Sin participantes</p>
            )}
            {allParticipants.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={selParticipants.includes(name)}
                onCheckedChange={() => toggle(selParticipants, setSelParticipants, name)}
              >
                {name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Tag />
              Etiqueta
              {selLabels.length > 0 && (
                <Badge variant="secondary" className="rounded-full px-1.5">
                  {selLabels.length}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {labelDefs.map((def) => (
              <DropdownMenuCheckboxItem
                key={def.name}
                checked={selLabels.includes(def.name)}
                onCheckedChange={() => toggle(selLabels, setSelLabels, def.name)}
              >
                {def.emoji} {def.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Estado
              {selStatuses.length > 0 && (
                <Badge variant="secondary" className="rounded-full px-1.5">
                  {selStatuses.length}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUS_FILTER.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={selStatuses.includes(s.value)}
                onCheckedChange={() => toggle(selStatuses, setSelStatuses, s.value)}
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {selParticipants.map((name) => (
          <Badge key={`p-${name}`} variant="secondary" className="gap-1 rounded-full">
            {name}
            <button
              type="button"
              onClick={() => toggle(selParticipants, setSelParticipants, name)}
              aria-label={`Quitar filtro ${name}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {selLabels.map((name) => {
          const def = labelDefs.find((d) => d.name === name);
          return (
            <Badge key={`l-${name}`} variant="secondary" className="gap-1 rounded-full">
              {def ? `${def.emoji} ${def.name}` : name}
              <button
                type="button"
                onClick={() => toggle(selLabels, setSelLabels, name)}
                aria-label={`Quitar filtro ${name}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          );
        })}
        {selStatuses.map((value) => (
          <Badge key={`s-${value}`} variant="secondary" className="gap-1 rounded-full">
            {STATUS_LABELS[value] ?? value}
            <button
              type="button"
              onClick={() => toggle(selStatuses, setSelStatuses, value)}
              aria-label={`Quitar filtro ${STATUS_LABELS[value] ?? value}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="divide-y">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-6 py-4">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-56" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No se pudieron cargar las reuniones</EmptyTitle>
              <EmptyDescription>Reintentá en unos segundos. ({error})</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => void refetch()}>
              Reintentar
            </Button>
          </Empty>
        ) : merged.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Mic />
              </EmptyMedia>
              <EmptyTitle>Todavía no hay reuniones</EmptyTitle>
              <EmptyDescription>
                Instalá la extensión y unite a una reunión de Teams para empezar.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Sin resultados</EmptyTitle>
            </EmptyHeader>
            <Button variant="ghost" onClick={clearFilters}>
              Limpiar filtros
            </Button>
          </Empty>
        ) : (
          <div>
            {filtered.map(({ meeting, labels }) => (
              <MeetingRow
                key={meeting.meetingId}
                meeting={meeting}
                labels={labels}
                labelDefs={labelDefs}
                onRename={handleRename}
                onToggleLabel={handleToggleLabel}
                onReprocess={handleReprocess}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
