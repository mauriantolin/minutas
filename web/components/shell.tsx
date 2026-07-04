"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { useAuth } from "@/components/auth-provider";
import { useMeetings, usePolling } from "@/lib/hooks";

/**
 * App shell for every route except /login (spec §2): auth guard, sidebar,
 * global ⌘K palette, and the shared 60 s meetings poll feeding the sidebar
 * live badge, the palette index, and the live-capture entry-point toast.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { token, ready } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { meetings, refetch } = useMeetings();
  usePolling(60_000, refetch);

  useEffect(() => {
    if (ready && !token) router.replace("/login");
  }, [ready, token, router]);

  // Live-view entry point (spec §3.7): one toast per capturing meeting id.
  const notifiedCapturing = useRef(new Set<string>());
  useEffect(() => {
    if (!meetings) return;
    for (const m of meetings) {
      if (m.status !== "capturing" || notifiedCapturing.current.has(m.meetingId)) continue;
      notifiedCapturing.current.add(m.meetingId);
      if (pathname === "/live") continue;
      toast("Se está transcribiendo una reunión", {
        action: {
          label: "Ver en vivo",
          onClick: () => router.push(`/live?id=${encodeURIComponent(m.meetingId)}`),
        },
      });
    }
  }, [meetings, pathname, router]);

  if (!ready || !token) {
    return (
      <div className="grid h-svh place-items-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar meetings={meetings} />
      <SidebarInset>{children}</SidebarInset>
      <CommandPalette meetings={meetings} />
    </SidebarProvider>
  );
}
