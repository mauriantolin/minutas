"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  CalendarDays,
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/components/auth-provider";
import { APP_NAME } from "@/lib/config";
import { initials } from "@/lib/format";
import { getLabelDefs, setLabelDefs, type LabelDef } from "@/lib/overrides";
import type { Meeting } from "@/lib/api";

const NAV = [
  { title: "Reuniones", href: "/meetings", icon: CalendarDays },
  { title: "Kits de IA", href: "/kits", icon: Sparkles },
  { title: "Configuración", href: "/settings", icon: Settings },
];

export function AppSidebar({ meetings }: { meetings: Meeting[] | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { email, isAdmin, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const [labels, setLabels] = useState<LabelDef[]>([]);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [newEmoji, setNewEmoji] = useState("🏷️");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const load = () => setLabels(getLabelDefs());
    load();
    window.addEventListener("app:labels-changed", load);
    return () => window.removeEventListener("app:labels-changed", load);
  }, []);

  const anyCapturing = (meetings ?? []).some((m) => m.status === "capturing");

  const createLabel = () => {
    const name = newName.trim();
    if (!name) return;
    setLabelDefs([...getLabelDefs(), { emoji: newEmoji.trim() || "🏷️", name }]);
    setNewName("");
    setLabelDialogOpen(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2 font-semibold tracking-tight group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src="/minutix-mark.png" alt="" className="size-6 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">{APP_NAME}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {[
                ...NAV,
                ...(isAdmin
                  ? [{ title: "Administración", href: "/admin", icon: ShieldCheck }]
                  : []),
              ].map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname.startsWith(item.href)}
                    tooltip={item.title}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  {item.href === "/meetings" && anyCapturing && (
                    <SidebarMenuBadge>
                      <Badge className="bg-destructive/10 text-destructive">
                        <span className="size-1.5 rounded-full bg-current animate-pulse" />
                        En vivo
                      </Badge>
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Etiquetas</SidebarGroupLabel>
          <SidebarGroupAction title="Nueva etiqueta" onClick={() => setLabelDialogOpen(true)}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {labels.map((l) => (
                <SidebarMenuItem key={l.name}>
                  <SidebarMenuButton asChild>
                    <Link href={`/meetings?label=${encodeURIComponent(l.name)}`}>
                      <span>{l.emoji}</span>
                      <span>{l.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip={email ?? "Cuenta"}>
                  <Avatar className="size-7">
                    <AvatarFallback className="text-xs">
                      {initials(email ?? "?")}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-xs">{email}</span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                  {email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <Sun className="mr-2 size-4" /> Tema claro
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon className="mr-2 size-4" /> Tema oscuro
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor className="mr-2 size-4" /> Sistema
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => router.push("/settings")}>
                  <Settings /> Configuración
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    signOut();
                    router.replace("/login");
                  }}
                >
                  <LogOut /> Salir
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Nueva etiqueta</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <div className="w-16 space-y-1.5">
              <Label htmlFor="label-emoji">Emoji</Label>
              <Input
                id="label-emoji"
                maxLength={2}
                value={newEmoji}
                onChange={(e) => setNewEmoji(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="label-name">Nombre</Label>
              <Input
                id="label-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createLabel()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLabelDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={createLabel}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
