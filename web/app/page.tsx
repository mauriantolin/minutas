"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/components/auth-provider";

export default function Page() {
  const { token, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready) router.replace(token ? "/meetings" : "/login");
  }, [ready, token, router]);

  return (
    <div className="grid h-svh place-items-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}
