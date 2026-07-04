"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LiveView } from "@/components/live/live-view";

function LivePageInner() {
  const id = useSearchParams().get("id");
  return <LiveView meetingId={id} />;
}

export default function LivePage() {
  return (
    <Suspense fallback={null}>
      <LivePageInner />
    </Suspense>
  );
}
