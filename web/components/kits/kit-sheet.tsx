"use client";

import { Copy, Pencil, Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Kit, KitPrompt } from "@/components/kits/kits-data";

export interface KitSheetProps {
  kit: Kit | null;
  onOpenChange: (open: boolean) => void;
  onUse: (prompt: KitPrompt) => void;
  onEdit: (kit: Kit) => void;
  onDelete: (kit: Kit) => void;
}

/** Right-side kit drawer with prompt rows (spec §3.8). */
export function KitSheet({ kit, onOpenChange, onUse, onEdit, onDelete }: KitSheetProps) {
  return (
    <Sheet open={kit !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
        {kit && (
          <>
            <SheetHeader>
              <SheetTitle>
                <span className="mr-2">{kit.emoji}</span>
                {kit.name}
              </SheetTitle>
              <SheetDescription>{kit.description}</SheetDescription>
              {kit.custom && (
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => onEdit(kit)}>
                    <Pencil />
                    Editar
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 />
                        Eliminar
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>¿Eliminar este kit?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Se van a borrar el kit y todos sus prompts. Esta acción no se puede
                          deshacer.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(kit)}>
                          Eliminar
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </SheetHeader>
            <div className="space-y-3 overflow-y-auto px-4 pb-6">
              {kit.prompts.map((p, i) => (
                <div key={i} className="group rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{p.prompt}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground"
                        onClick={async () => {
                          await navigator.clipboard.writeText(p.prompt);
                          toast("Prompt copiado");
                        }}
                      >
                        <Copy />
                        <span className="sr-only">Copiar prompt</span>
                      </Button>
                      <Button size="sm" onClick={() => onUse(p)}>
                        Usar
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
