import { Suspense } from "react";
import { NotesView } from "@/components/notes/notes-view";

export default function NotesPage() {
  return (
    <Suspense>
      <NotesView />
    </Suspense>
  );
}
