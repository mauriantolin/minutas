"use client";

import { CalendarDays } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useMeetings } from "@/lib/hooks";
import { formatDateTime } from "@/lib/format";

export interface MeetingPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (meetingId: string) => void;
}

/** "¿Sobre qué reunión?" picker for running a kit prompt (spec §3.8). */
export function MeetingPicker({ open, onOpenChange, onSelect }: MeetingPickerProps) {
  const { meetings } = useMeetings();
  const recent = [...(meetings ?? [])]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="¿Sobre qué reunión?"
      description="Elegí la reunión sobre la que ejecutar el prompt"
    >
      <CommandInput placeholder="Buscar reunión…" />
      <CommandList>
        <CommandEmpty>Sin reuniones.</CommandEmpty>
        <CommandGroup heading="Recientes">
          {recent.map((m) => (
            <CommandItem
              key={m.meetingId}
              value={`${m.title} ${m.meetingId}`}
              onSelect={() => onSelect(m.meetingId)}
            >
              <CalendarDays />
              <span className="truncate">{m.title}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {formatDateTime(m.startedAt)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
