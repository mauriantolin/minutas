"use client";

import { useMemo } from "react";
import { ChartColumn } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { formatDuration, initials, meetingDuration } from "@/lib/format";
import type { MeetingDetail } from "@/lib/api";
import type { Turn } from "@/components/meeting/detail-api";

const WORDS_PER_SECOND = 2.5;

interface SpeakerStat {
  speaker: string;
  seconds: number;
  words: number;
  interventions: number;
  pct: number;
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Talk time = Σ(endTime − startTime) over the speaker's own turns (spec §3.9);
 * never consecutive-segment deltas. Legacy turns without endTime estimate by
 * word count / 2.5 wps.
 */
function computeStats(turns: Turn[]): SpeakerStat[] {
  const bySpeaker = new Map<string, SpeakerStat>();
  for (const t of turns) {
    const stat =
      bySpeaker.get(t.speaker) ??
      bySpeaker
        .set(t.speaker, { speaker: t.speaker, seconds: 0, words: 0, interventions: 0, pct: 0 })
        .get(t.speaker)!;
    const words = wordCount(t.text);
    stat.seconds +=
      t.endTime !== undefined ? Math.max(0, t.endTime - t.startTime) : words / WORDS_PER_SECOND;
    stat.words += words;
    stat.interventions += 1;
  }
  const total = [...bySpeaker.values()].reduce((s, x) => s + x.seconds, 0);
  const stats = [...bySpeaker.values()].map((s) => ({
    ...s,
    pct: total > 0 ? (s.seconds / total) * 100 : 0,
  }));
  stats.sort((a, b) => b.seconds - a.seconds);
  return stats;
}

export interface StatsTabProps {
  meeting: MeetingDetail;
  turns: Turn[];
  colorOf: (speaker: string) => string;
}

export function StatsTab({ meeting, turns, colorOf }: StatsTabProps) {
  const stats = useMemo(() => computeStats(turns), [turns]);
  const totalWords = stats.reduce((s, x) => s + x.words, 0);
  const totalTalk = stats.reduce((s, x) => s + x.seconds, 0);
  const duration = meetingDuration(meeting.startedAt, meeting.endedAt) ?? formatDuration(totalTalk);
  const top = stats[0];

  if (turns.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChartColumn />
          </EmptyMedia>
          <EmptyTitle>Sin datos todavía</EmptyTitle>
          <EmptyDescription>
            Las estadísticas se calculan a partir de la transcripción.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Participación</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {stats.map((s) => {
            const color = colorOf(s.speaker);
            return (
              <div key={s.speaker}>
                <div className="flex items-center gap-2">
                  <Avatar className="size-6">
                    <AvatarFallback
                      className="text-[10px] font-medium text-white"
                      style={{ backgroundColor: color }}
                    >
                      {initials(s.speaker)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm">{s.speaker}</span>
                  <span className="ml-auto text-sm font-medium tabular-nums">
                    {Math.round(s.pct)} %
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full"
                    style={{ width: `${s.pct}%`, backgroundColor: color }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDuration(s.seconds)} · {s.interventions}{" "}
                  {s.interventions === 1 ? "intervención" : "intervenciones"}
                </p>
              </div>
            );
          })}
          {top && top.pct > 60 && (
            <p className="text-xs text-muted-foreground">
              ⚖️ {top.speaker} habló más del 60 % del tiempo.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resumen de la sesión</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 divide-x">
            <div className="px-4 text-center first:pl-0 last:pr-0">
              <p className="text-xl font-semibold tabular-nums">{duration}</p>
              <p className="text-xs text-muted-foreground">Duración</p>
            </div>
            <div className="px-4 text-center">
              <p className="text-xl font-semibold tabular-nums">{stats.length}</p>
              <p className="text-xs text-muted-foreground">Participantes</p>
            </div>
            <div className="px-4 text-center">
              <p className="text-xl font-semibold tabular-nums">
                {totalWords.toLocaleString("es-AR")}
              </p>
              <p className="text-xs text-muted-foreground">Palabras</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
