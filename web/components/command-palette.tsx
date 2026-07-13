"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Brain,
  CalendarDays,
  Mic,
  Moon,
  NotebookPen,
  Search,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { Meeting } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const OPEN_EVENT = "app:open-command-palette";

/** Opens the global ⌘K palette from anywhere (e.g. the list search input). */
export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function CommandPalette({ meetings }: { meetings: Meeting[] | null }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Buscar" description="Buscar reuniones y acciones">
      <CommandInput placeholder="Buscar reuniones o acciones…" />
      <CommandList>
        <CommandEmpty>Sin resultados.</CommandEmpty>
        <CommandGroup heading="Reuniones">
          {(meetings ?? []).slice(0, 20).map((m) => (
            <CommandItem
              key={m.meetingId}
              value={`${m.title} ${m.meetingId}`}
              onSelect={() => go(`/meeting?id=${encodeURIComponent(m.meetingId)}`)}
            >
              <CalendarDays />
              <span className="truncate">{m.title}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {formatDateTime(m.startedAt)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Acciones">
          <CommandItem onSelect={() => go("/meetings")}>
            <Search />
            Nueva búsqueda
          </CommandItem>
          <CommandItem onSelect={() => go("/brain")}>
            <Brain />
            Preguntar a la memoria
          </CommandItem>
          <CommandItem onSelect={() => go("/notes")}>
            <NotebookPen />
            Notas
          </CommandItem>
          <CommandItem onSelect={() => go("/notes?record=1")}>
            <Mic />
            Nueva nota de voz
          </CommandItem>
          <CommandItem onSelect={() => go("/kits")}>
            <Sparkles />
            Kits de IA
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <Settings />
            Configuración
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            Cambiar tema
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
