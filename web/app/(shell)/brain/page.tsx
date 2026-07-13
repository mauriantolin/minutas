"use client";

import { Suspense } from "react";
import { Spinner } from "@/components/ui/spinner";
import { BrainView } from "@/components/brain/brain-view";

export default function BrainPage() {
  return (
    <Suspense
      fallback={
        <div className="grid h-svh place-items-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      }
    >
      <BrainView />
    </Suspense>
  );
}
