import { Suspense } from "react";
import { MeetingsScreen } from "@/components/meetings/meetings-screen";

export default function MeetingsPage() {
  return (
    <Suspense>
      <MeetingsScreen />
    </Suspense>
  );
}
