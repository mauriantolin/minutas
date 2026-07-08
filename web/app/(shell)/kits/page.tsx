"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { KitDialog } from "@/components/kits/kit-dialog";
import { KitSheet } from "@/components/kits/kit-sheet";
import { MeetingPicker } from "@/components/kits/meeting-picker";
import {
  BUILT_IN_KITS,
  getCustomKits,
  saveCustomKits,
  type Kit,
  type KitPrompt,
} from "@/components/kits/kits-data";

export default function KitsPage() {
  const router = useRouter();
  const [customKits, setCustomKits] = useState<Kit[]>([]);
  const [openKit, setOpenKit] = useState<Kit | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKit, setEditingKit] = useState<Kit | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  useEffect(() => {
    setCustomKits(getCustomKits());
  }, []);

  const persist = (kits: Kit[]) => {
    setCustomKits(kits);
    saveCustomKits(kits);
  };

  const saveKit = (kit: Kit) => {
    const exists = customKits.some((k) => k.id === kit.id);
    persist(exists ? customKits.map((k) => (k.id === kit.id ? kit : k)) : [...customKits, kit]);
    if (openKit?.id === kit.id) setOpenKit(kit);
    toast("Kit guardado");
  };

  const deleteKit = (kit: Kit) => {
    persist(customKits.filter((k) => k.id !== kit.id));
    setOpenKit(null);
    toast("Kit eliminado");
  };

  const usePrompt = (prompt: KitPrompt) => {
    setOpenKit(null);
    setPendingPrompt(prompt.prompt);
  };

  const kits = [...BUILT_IN_KITS, ...customKits];

  return (
    <>
      <header className="flex h-14 items-center gap-3 border-b px-6">
        <SidebarTrigger />
        <h1 className="text-xl font-semibold tracking-tight">Kits de IA</h1>
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={() => {
              setEditingKit(null);
              setDialogOpen(true);
            }}
          >
            <Plus />
            Crear kit
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-6 py-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {kits.map((kit) => (
            <Card
              key={kit.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer transition-colors hover:bg-accent/30"
              onClick={() => setOpenKit(kit)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenKit(kit);
                }
              }}
            >
              <CardHeader>
                <div className="text-2xl">{kit.emoji}</div>
                <CardTitle className="text-sm font-medium">{kit.name}</CardTitle>
                <CardDescription>{kit.description}</CardDescription>
              </CardHeader>
              <CardFooter className="text-xs text-muted-foreground">
                {kit.prompts.length} prompts
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>

      <KitSheet
        kit={openKit}
        onOpenChange={(open) => {
          if (!open) setOpenKit(null);
        }}
        onUse={usePrompt}
        onEdit={(kit) => {
          setEditingKit(kit);
          setDialogOpen(true);
        }}
        onDelete={deleteKit}
      />

      <KitDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editingKit}
        onSave={saveKit}
      />

      <MeetingPicker
        open={pendingPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPrompt(null);
        }}
        onSelect={(meetingId) => {
          const prompt = pendingPrompt;
          setPendingPrompt(null);
          router.push(`/meeting?id=${encodeURIComponent(meetingId)}&prompt=${encodeURIComponent(prompt ?? "")}`);
        }}
      />
    </>
  );
}
