"use client";

import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PHASE_LABELS, STATUS_LABELS } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { PipelineState } from "@/lib/api";

export interface StatusBadgeProps {
  status: string;
  pipeline?: PipelineState;
  className?: string;
}

/**
 * Status pill per spec §3.2. Renders nothing for `ready` and for unknown
 * legacy statuses. `capturing` shows a pulsing dot; consumers wrap it in a
 * link to /live?id= where the spec asks for it.
 */
export function StatusBadge({ status, pipeline, className }: StatusBadgeProps) {
  if (status === "capturing") {
    return (
      <Badge className={cn("bg-destructive/10 text-destructive", className)}>
        <span className="size-1.5 rounded-full bg-current animate-pulse" />
        {STATUS_LABELS.capturing}
      </Badge>
    );
  }
  if (status === "processing") {
    const phase = pipeline ? PHASE_LABELS[pipeline.phase] : undefined;
    return (
      <Badge variant="secondary" className={className}>
        <Spinner className="size-3" />
        {phase ? `${STATUS_LABELS.processing} · ${phase}` : STATUS_LABELS.processing}
      </Badge>
    );
  }
  if (status === "needs_review") {
    return (
      <Badge variant="outline" className={cn("border-chart-4/50 text-chart-4", className)}>
        <TriangleAlert />
        {STATUS_LABELS.needs_review}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className={cn("border-destructive/50 text-destructive", className)}>
        <TriangleAlert />
        {STATUS_LABELS.failed}
      </Badge>
    );
  }
  return null;
}
