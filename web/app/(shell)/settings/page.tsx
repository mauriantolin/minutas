"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Download, Info, LogOut, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/components/auth-provider";
import { fileSlug, meetingToMarkdown } from "@/components/export-menu";
import { getMeeting, listMeetings } from "@/lib/api";
import { APP_NAME, CONFIG } from "@/lib/config";
import { initials } from "@/lib/format";
import {
  getCustomTags,
  getLabelDefs,
  removeLabelFromMeetings,
  renameLabelInMeetings,
  setCustomTags,
  setLabelDefs,
  type LabelDef,
} from "@/lib/overrides";
import { buildZip, type ZipEntry } from "./zip";

/** Built-in moment tags (spec §3.4/§3.10) — read-only here. */
const BUILT_IN_TAGS: LabelDef[] = [
  { emoji: "📌", name: "Decisión" },
  { emoji: "✅", name: "Acción" },
  { emoji: "❓", name: "Pregunta" },
  { emoji: "⭐", name: "Destacado" },
];

/** How many meetings carry each label, from the per-meeting overrides store. */
function labelUsage(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)!;
    if (!/^meeting:.+:overrides$/.test(key)) continue;
    let labels: string[] = [];
    try {
      labels = (JSON.parse(window.localStorage.getItem(key)!) as { labels?: string[] }).labels ?? [];
    } catch {
      continue;
    }
    for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function EmojiNameDialog({
  open,
  onOpenChange,
  title,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial?: LabelDef | null;
  onSave: (def: LabelDef) => void;
}) {
  const [emoji, setEmoji] = useState("🏷️");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    setEmoji(initial?.emoji ?? "🏷️");
    setName(initial?.name ?? "");
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="def-emoji">Emoji</Label>
            <Input
              id="def-emoji"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={2}
              className="w-16 text-center"
            />
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="def-name">Nombre</Label>
            <Input id="def-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSave({ emoji: emoji.trim() || "🏷️", name: name.trim() });
              onOpenChange(false);
            }}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { token, email, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  const [labels, setLabels] = useState<LabelDef[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [labelDialog, setLabelDialog] = useState<{ open: boolean; editIndex: number | null }>({
    open: false,
    editIndex: null,
  });
  const [labelToDelete, setLabelToDelete] = useState<LabelDef | null>(null);

  const [customTags, setTags] = useState<LabelDef[]>([]);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setMounted(true);
    setLabels(getLabelDefs());
    setUsage(labelUsage());
    setTags(getCustomTags());
  }, []);

  const persistLabels = (defs: LabelDef[]) => {
    setLabels(defs);
    setLabelDefs(defs);
  };

  // Deleting/renaming a definition cascades into every per-meeting assignment,
  // matching the confirm dialog's "van a perder la etiqueta".
  const removeLabel = (def: LabelDef) => {
    persistLabels(labels.filter((l) => l.name !== def.name));
    removeLabelFromMeetings(def.name);
    setUsage(labelUsage());
  };

  const exportAll = async () => {
    if (!token) return;
    setExporting(true);
    try {
      const { meetings } = await listMeetings(token);
      const enc = new TextEncoder();
      const seen = new Set<string>();
      const entries: ZipEntry[] = [];
      for (const m of meetings) {
        const detail = await getMeeting(token, m.meetingId);
        let base = `${detail.startedAt.slice(0, 10)}-${fileSlug(detail.title)}`;
        if (seen.has(base)) base = `${base}-${entries.length + 1}`;
        seen.add(base);
        entries.push({ name: `${base}.md`, data: enc.encode(meetingToMarkdown(detail)) });
      }
      const url = URL.createObjectURL(buildZip(entries));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${APP_NAME.toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Exportación lista: ${entries.length} reuniones`);
    } catch {
      toast.error("No se pudo completar la exportación");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <header className="flex h-14 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <h1 className="text-xl font-semibold tracking-tight">Configuración</h1>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Cuenta</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <Avatar className="size-10">
              <AvatarFallback>{initials(email ?? "?")}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{email ?? "—"}</p>
              <p className="text-xs text-muted-foreground">
                Usuarios gestionados en Cognito ({CONFIG.region}). Todo el equipo ve las mismas
                reuniones.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                signOut();
                router.replace("/login");
              }}
            >
              <LogOut />
              Salir
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Requisito para capturar</CardTitle>
            <CardDescription>
              Minutix lee los subtítulos de Teams. Sin subtítulos activos, la extensión y la
              app Windows no tienen transcripción para capturar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3 rounded-md border bg-muted/40 p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground">
                En Teams vas a{" "}
                <span className="font-medium text-foreground">Configuración</span> →{" "}
                <span className="font-medium text-foreground">Accesibilidad</span> →{" "}
                <span className="font-medium text-foreground">Subtítulos</span> → activar{" "}
                <span className="font-medium text-foreground">
                  Siempre mostrar subtítulos en mis llamadas y reuniones
                </span>
                .
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Extensión de Chrome</CardTitle>
            <CardDescription>
              Descargá el paquete, descomprimilo en una carpeta fija y cargalo en{" "}
              <span className="font-mono">chrome://extensions</span> → Modo de
              desarrollador → Cargar descomprimida.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href="/minutix-extension.zip" download>
                <Download />
                Descargar extensión
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Aplicación Windows</CardTitle>
            <CardDescription>
              Instalá Minutix Desktop una sola vez: el instalador se encarga del resto y la app
              se actualiza sola en cada arranque. Captura subtítulos en vivo desde Teams Desktop,
              funciona con la ventana minimizada y no graba audio.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href="/desktop/Minutix.Desktop-win-Setup.exe" download>
                <Download />
                Descargar instalador
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Apariencia</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <Label htmlFor="theme-select" className="text-sm">
              Tema
            </Label>
            {mounted && (
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger id="theme-select" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Claro</SelectItem>
                  <SelectItem value="dark">Oscuro</SelectItem>
                  <SelectItem value="system">Sistema</SelectItem>
                </SelectContent>
              </Select>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Etiquetas</CardTitle>
            <CardDescription>
              Organizan tus reuniones en la barra lateral y los filtros.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {labels.map((label, i) => {
              const count = usage[label.name] ?? 0;
              return (
                <div
                  key={label.name}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
                >
                  <span>{label.emoji}</span>
                  <span className="text-sm">{label.name}</span>
                  {count > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {count}
                    </Badge>
                  )}
                  <div className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      onClick={() => setLabelDialog({ open: true, editIndex: i })}
                    >
                      <Pencil />
                      <span className="sr-only">Editar etiqueta</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => (count > 0 ? setLabelToDelete(label) : removeLabel(label))}
                    >
                      <Trash2 />
                      <span className="sr-only">Eliminar etiqueta</span>
                    </Button>
                  </div>
                </div>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={() => setLabelDialog({ open: true, editIndex: null })}
            >
              <Plus />
              Nueva etiqueta
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Tags de momento</CardTitle>
            <CardDescription>
              Marcan fragmentos puntuales de la transcripción al pasar el cursor. Los tags
              integrados también están disponibles en el widget en vivo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {BUILT_IN_TAGS.map((tag) => (
              <div key={tag.name} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <span>{tag.emoji}</span>
                <span className="text-sm">{tag.name}</span>
                <Badge variant="outline" className="ml-auto text-xs text-muted-foreground">
                  Integrado
                </Badge>
              </div>
            ))}
            {customTags.map((tag) => (
              <div
                key={tag.name}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
              >
                <span>{tag.emoji}</span>
                <span className="text-sm">{tag.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={() => {
                    const next = customTags.filter((t) => t.name !== tag.name);
                    setTags(next);
                    setCustomTags(next);
                  }}
                >
                  <Trash2 />
                  <span className="sr-only">Eliminar tag</span>
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={() => setTagDialogOpen(true)}
            >
              <Plus />
              Nuevo tag
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Datos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" onClick={exportAll} disabled={exporting}>
              {exporting ? <Spinner /> : <Download />}
              Exportar todas las reuniones (ZIP de Markdown)
            </Button>
            <p className="text-xs text-muted-foreground">
              Los datos viven en tu propia cuenta de AWS; no hay retención en servicios de
              terceros.
            </p>
          </CardContent>
        </Card>
      </div>

      <EmojiNameDialog
        open={labelDialog.open}
        onOpenChange={(open) => setLabelDialog((d) => ({ ...d, open }))}
        title={labelDialog.editIndex !== null ? "Editar etiqueta" : "Nueva etiqueta"}
        initial={labelDialog.editIndex !== null ? labels[labelDialog.editIndex] : null}
        onSave={(def) => {
          if (labelDialog.editIndex !== null) {
            const prev = labels[labelDialog.editIndex]!;
            persistLabels(labels.map((l, i) => (i === labelDialog.editIndex ? def : l)));
            if (prev.name !== def.name) {
              renameLabelInMeetings(prev.name, def.name);
              setUsage(labelUsage());
            }
          } else {
            persistLabels([...labels, def]);
          }
        }}
      />

      <EmojiNameDialog
        open={tagDialogOpen}
        onOpenChange={setTagDialogOpen}
        title="Nuevo tag"
        onSave={(def) => {
          const next = [...customTags, def];
          setTags(next);
          setCustomTags(next);
        }}
      />

      <AlertDialog
        open={labelToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setLabelToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar la etiqueta “{labelToDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Está asignada a {usage[labelToDelete?.name ?? ""] ?? 0} reuniones; van a perder la
              etiqueta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (labelToDelete) removeLabel(labelToDelete);
                setLabelToDelete(null);
              }}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
