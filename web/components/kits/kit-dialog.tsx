"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Kit, KitPrompt } from "@/components/kits/kits-data";

export interface KitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing custom kit. */
  initial?: Kit | null;
  onSave: (kit: Kit) => void;
}

const EMPTY_PROMPT: KitPrompt = { name: "", prompt: "" };

/** Custom kit builder (spec §3.8 "Crear kit"). */
export function KitDialog({ open, onOpenChange, initial, onSave }: KitDialogProps) {
  const [emoji, setEmoji] = useState("✨");
  const [name, setName] = useState("");
  const [prompts, setPrompts] = useState<KitPrompt[]>([EMPTY_PROMPT]);

  useEffect(() => {
    if (!open) return;
    setEmoji(initial?.emoji ?? "✨");
    setName(initial?.name ?? "");
    setPrompts(initial?.prompts.length ? initial.prompts : [EMPTY_PROMPT]);
  }, [open, initial]);

  const setPrompt = (i: number, patch: Partial<KitPrompt>) =>
    setPrompts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const valid =
    name.trim().length > 0 &&
    prompts.some((p) => p.name.trim().length > 0 && p.prompt.trim().length > 0);

  const save = () => {
    onSave({
      id: initial?.id ?? `custom-${Date.now()}`,
      emoji: emoji.trim() || "✨",
      name: name.trim(),
      description: "Kit personalizado",
      prompts: prompts
        .filter((p) => p.name.trim() && p.prompt.trim())
        .map((p) => ({ name: p.name.trim(), prompt: p.prompt.trim() })),
      custom: true,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Editar kit" : "Crear kit"}</DialogTitle>
          <DialogDescription>
            Un kit agrupa prompts que podés ejecutar sobre cualquier reunión.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="kit-emoji">Emoji</Label>
              <Input
                id="kit-emoji"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                maxLength={2}
                className="w-16 text-center"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="kit-name">Nombre</Label>
              <Input
                id="kit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mi kit"
              />
            </div>
          </div>
          <div className="space-y-3">
            <Label>Prompts</Label>
            {prompts.map((p, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={p.name}
                    onChange={(e) => setPrompt(i, { name: e.target.value })}
                    placeholder="Nombre del prompt"
                    className="h-8"
                  />
                  {prompts.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      onClick={() => setPrompts((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X />
                      <span className="sr-only">Quitar prompt</span>
                    </Button>
                  )}
                </div>
                <Textarea
                  value={p.prompt}
                  onChange={(e) => setPrompt(i, { prompt: e.target.value })}
                  placeholder="Instrucción para la IA…"
                  rows={2}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrompts((prev) => [...prev, EMPTY_PROMPT])}
            >
              <Plus />
              Agregar prompt
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
