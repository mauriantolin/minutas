# UI-SPEC — Self-hosted Meeting Transcription Dashboard (Tactiq-style)

Target stack: Next.js 15 (`output: "export"`), React 19, Tailwind v4 (CSS-first, no config file), shadcn/ui (CSS variables mode, base color Zinc). App UI copy stays in **Spanish (voseo, matching current app)**; all code, identifiers, filenames in English. Product name is white-label: `APP_NAME` const in `web/lib/config.ts`, default `"Minutas"` — never hardcode a brand elsewhere.

---

## 1. Design language

### 1.1 Tactiq cues to copy (the checklist)

1. White-first surfaces, near-black ink, one indigo accent — no gradients, no colored section backgrounds.
2. Left sidebar nav on a slightly-off-white surface, 1px border, content pane pure white.
3. Card-based sections with medium radius, 1px `border` + `shadow-sm` max. Never heavier shadows.
4. Transcript = vertical speaker blocks: avatar + bold name + muted mono timestamp, regular-weight body below.
5. Pill-shaped emoji tags (`Badge` with emoji prefix) for highlights and labels.
6. Filter chips row above lists, not a dense toolbar.
7. Solid indigo primary button, ghost/outline everything else. One primary action per view.
8. Airy density: 14px UI base, generous `py`, thin gray dividers instead of boxes-in-boxes.

### 1.2 Tokens — paste into `web/app/globals.css`

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);                 /* #FFFFFF */
  --foreground: oklch(0.141 0.005 285.82);    /* ~#0B0B0E zinc-950 */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.82);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.82);
  --primary: oklch(0.545 0.245 277);          /* ~#5B53FE */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.38);     /* zinc-100 */
  --secondary-foreground: oklch(0.21 0.006 285.89);
  --muted: oklch(0.967 0.001 286.38);
  --muted-foreground: oklch(0.552 0.016 285.94); /* zinc-500 (more accessible than Tactiq's #A9A9BC) */
  --accent: oklch(0.962 0.018 272.31);        /* indigo-50 — hover/selected */
  --accent-foreground: oklch(0.457 0.24 277.02); /* indigo-700 */
  --destructive: oklch(0.577 0.245 27.33);    /* red-600 */
  --border: oklch(0.92 0.004 286.32);         /* zinc-200 ~#E4E4E7 */
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.545 0.245 277);
  --chart-1: oklch(0.545 0.245 277);   /* indigo — speaker 1 */
  --chart-2: oklch(0.715 0.143 215.22);/* cyan-500 — speaker 2 (Tactiq cyan pop) */
  --chart-3: oklch(0.606 0.25 292.72); /* violet-500 */
  --chart-4: oklch(0.769 0.188 70.08); /* amber-500 */
  --chart-5: oklch(0.696 0.17 162.48); /* emerald-500 */
  --sidebar: oklch(0.985 0 0);                /* zinc-50 ~#FAFAFA */
  --sidebar-foreground: oklch(0.141 0.005 285.82);
  --sidebar-primary: oklch(0.545 0.245 277);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.962 0.018 272.31);
  --sidebar-accent-foreground: oklch(0.457 0.24 277.02);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.545 0.245 277);
}

.dark {
  --background: oklch(0.141 0.005 285.82);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.89);           /* zinc-900 */
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.89);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.585 0.233 277.12);       /* indigo-500 */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.274 0.006 286.03);     /* zinc-800 */
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.03);
  --muted-foreground: oklch(0.705 0.015 286.07); /* zinc-400 */
  --accent: oklch(0.257 0.09 281.29);         /* indigo-950 — selected */
  --accent-foreground: oklch(0.785 0.115 274.71); /* indigo-300 */
  --destructive: oklch(0.637 0.237 25.33);
  --border: oklch(0.274 0.006 286.03);
  --input: oklch(0.274 0.006 286.03);
  --ring: oklch(0.585 0.233 277.12);
  --chart-1: oklch(0.673 0.182 276.94);
  --chart-2: oklch(0.789 0.154 211.53);
  --chart-3: oklch(0.702 0.183 293.54);
  --chart-4: oklch(0.828 0.189 84.43);
  --chart-5: oklch(0.765 0.177 163.22);
  --sidebar: oklch(0.21 0.006 285.89);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.585 0.233 277.12);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.257 0.09 281.29);
  --sidebar-accent-foreground: oklch(0.785 0.115 274.71);
  --sidebar-border: oklch(0.274 0.006 286.03);
  --sidebar-ring: oklch(0.585 0.233 277.12);
}

@theme inline {
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* … map every token above as --color-<name>: var(--<name>); plus sidebar-* group … */
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
}
```

Dark mode: `next-themes`, `<ThemeProvider attribute="class" defaultTheme="system" enableSystem>` in root layout, `suppressHydrationWarning` on `<html>`. Toggle lives in Settings and in the sidebar footer user menu.

### 1.3 Typography

Inter via `next/font/google` (self-hosted at build; works with static export): `Inter({ subsets: ["latin"], variable: "--font-inter" })` on `<html>`.

| Role | Classes |
|---|---|
| Page title | `text-xl font-semibold tracking-tight` |
| Card/section title | `text-sm font-medium` |
| UI body / list rows | `text-sm` (14px is the app base) |
| Transcript text | `text-sm leading-6` |
| Meta (timestamps, counts) | `text-xs text-muted-foreground`, timestamps add `font-mono tabular-nums` |
| Login headline | `text-2xl font-semibold tracking-tight` |

### 1.4 Spacing & density

4px scale. Sidebar `w-60` (fixed, collapsible to icon rail). Sticky headers `h-14 px-6`. Page content `px-6 py-5`, `max-w-5xl mx-auto` on list pages. Transcript column `max-w-3xl`. Card internals `p-4`/`p-6`. Vertical rhythm between transcript blocks `space-y-5`. Dividers: `border-b` only, never double borders.

### 1.5 shadcn setup

```bash
cd web
pnpm dlx shadcn@latest init   # style: default/base, baseColor: zinc, cssVariables: true
pnpm dlx shadcn@latest add button input textarea card badge avatar separator scroll-area \
  tabs dialog alert-dialog sheet dropdown-menu popover tooltip command skeleton sonner \
  switch checkbox select label progress toggle toggle-group sidebar breadcrumb calendar \
  collapsible kbd empty field alert spinner
```

(`alert` and `spinner` are required: `Spinner` is used in §3.1/3.2/3.4/3.5/3.7, `Alert` in §3.1/3.3/3.7 — note `alert-dialog` does **not** provide `Alert`.)

Icons: `lucide-react` only. No Recharts (talk-time bars are plain divs). No TanStack Table (single-team data volumes; client `useMemo` filtering).

---

## 2. Information architecture / routes

Static-export-safe routing: real top-level routes (each exports its own `index.html` with `trailingSlash: true`), **detail views use query params** (dynamic segments can't static-export). Add a 6-line CloudFront Function (viewer-request: rewrite `/x/` → `/x/index.html`) — see migration step 11; SPA 404-fallback remains as safety net.

```
/login                     Login card
/meetings                  Meeting list (default post-login redirect from /)
/meeting?id=<meetingId>    Meeting detail — tabs: Transcripción | Resumen | Preguntar | Estadísticas
/live?id=<meetingId>       Live transcript view (polling)
/kits                      AI prompt kits gallery
/settings                  Profile, appearance, labels/tags, data export, sign out
```

`app/page.tsx` = auth gate only: spinner → `router.replace(token ? "/meetings" : "/login")`.

**Meeting status model** (shared enum, matches the backend status machine — the UI never invents values): `"capturing" → "processing" → "ready" | "needs_review"`. Spanish labels: `capturing` = "En vivo", `processing` = "Procesando", `ready` = "Lista", `needs_review` = "Revisar". There is no `"live"` status value anywhere in code; "En vivo" is only display copy for `capturing`.

**Shell** (all routes except `/login`): `SidebarProvider` → `AppSidebar` + `SidebarInset`. Sidebar content:
- Header: `APP_NAME` wordmark (text, `font-semibold`) + `SidebarTrigger`.
- Menu (lucide icons): `Reuniones` (`CalendarDays`) → /meetings; `Kits de IA` (`Sparkles`) → /kits; `Configuración` (`Settings`) → /settings. A `Badge` "En vivo" with pulsing dot appears next to Reuniones when any meeting has `status === "capturing"`.
- Labels group (`SidebarGroup` "Etiquetas"): user labels as filter shortcuts → `/meetings?label=<x>`, `+` button opens create-label Dialog.
- Footer: user block (Avatar initials + email, `DropdownMenu`: Tema claro/oscuro/sistema, Configuración, Salir).

**Command palette** (`CommandDialog`, ⌘K / Ctrl+K, global keydown in shell): groups "Reuniones" (fuzzy over titles, navigates to `/meeting?id=`), "Acciones" (Nueva búsqueda, Kits, Configuración, Cambiar tema).

**State/data**: `AuthProvider` (React context wrapping shell; holds token from `currentToken()`, exposes `signOut`). Data fetching stays bare-`fetch` via existing `lib/api.ts` + a tiny `useMeetings()` / `useMeeting(id)` hook pair with manual `refetch` — no query lib.

**Turn references** (`components/turn-ref-text.tsx`): the pipeline's summary/Q&A citation contract emits inline turn anchors like `[T14]`. `TurnRefText` parses `\[T(\d+)\]` tokens in any rendered answer/summary text and renders each as a small clickable `Badge variant="outline"` ("T14"); click switches to the Transcripción tab and `scrollIntoView`s the segment whose stable `id` matches the anchor (brief `ring-1 ring-ring` flash). Unknown refs render as plain text. Used by the Summary tab (§3.5) and Q&A bubbles (§3.6) — raw `[T14]` strings must never reach the DOM.

### API deltas (backend additions this UI assumes; each screen notes its localStorage fallback)

| Delta | Used by |
|---|---|
| `POST /meetings` **at capture start** — extension calls it when capture begins; returns `meetingId`, creates the meeting row with `status: "capturing"` | live view (§3.7), popup "Ver en vivo" (§4.1), shell live badge |
| `POST /meetings/{id}/segments` — extension batch-appends **finalized** segments during the meeting (this doubles as free server-side checkpointing of the capture) | live view polling, incremental ingest, tag payload from widget |
| `POST /meetings/{id}/finalize` — the former single-shot stop-POST becomes a finalize call; flips `"capturing" → "processing"` and kicks the pipeline | stop flow |
| `PATCH /meetings/{id}` body `{title?, labels?, segments?[{id, text?, tags?}], actionItems?[{id, done}]}` — **keyed by stable segment `id`, never array index** | rename, transcript edit, highlights, labels, action-item checkboxes |
| `POST /meetings/{id}/reprocess` | "Reprocesar" action (§3.3), `needs_review` recovery |
| `GET /meetings/{id}` serves the **cleaned transcript artifact** (`transcript.clean.json`): merged turns each carrying stable `id`, `speaker`, `startTime`, **`endTime`**, `text`, `tags` | detail view, stats (§3.9), turn anchors |

**Stable segment ids are a hard requirement**: the pipeline assigns ids at speaker-correlation time and carries them through cleanup merges, batch-ASR merges, and `/reprocess` regeneration (clean turns reference their source ids). Index-keyed edits would be silently orphaned by every transcript rewrite — turn merging, batch-text replacement, and reprocessing all renumber positions. The `[Tn]` anchors in summaries and Q&A answers reference these same clean-turn ids, and the detail view is pinned to that one declared artifact.

These deltas (start/segments/finalize) must land as an explicit milestone in the architecture doc — they are the create-meeting-at-start counterpart the current stop-time-only ingest lacks; without them no meeting exists server-side mid-meeting and the entire live surface is unreachable.

Until deltas ship: edits/tags/labels/done-state persist to `localStorage` keyed `meeting:<id>:overrides` (an object keyed by segment `id`, not index) and merge client-side over API data; the live view and popup "Ver en vivo" stay hidden behind a capability check (`GET /meetings` response advertises `features.liveIngest`). UI is identical either way.

---

## 3. Screen-by-screen spec

### 3.1 Login (`/login`)

Centered `Card` `w-full max-w-sm` on `bg-muted/40` full-viewport grid. `CardHeader`: APP_NAME wordmark, `CardTitle` "Iniciá sesión", `CardDescription` "Accedé a tus transcripciones de reuniones". `CardContent`: `Field` ×2 (Email, Contraseña) with `Input`, full-width primary `Button` "Entrar" (Spinner inside while pending, disabled). Errors: `Alert variant="destructive"` above the button with the Cognito message. No signup UI (self-hosted team; users created in Cognito console — note this in a `text-xs text-muted-foreground` footer line).

### 3.2 Meeting list (`/meetings`)

Sticky header (`h-14 border-b px-6 flex items-center gap-3`): `SidebarTrigger`, title "Reuniones", right side: search `Input` w/ `Search` icon (`w-64`, placeholder "Buscar reuniones…  ⌘K" using `Kbd`), theme-agnostic.

Filter chip row (`px-6 py-3 flex gap-2 flex-wrap`):
- `Popover` + `Calendar mode="range"` chip "Fecha" (outline Button, `CalendarDays` icon; shows range when active with an `X` clear).
- `DropdownMenu` w/ `DropdownMenuCheckboxItem` chip "Participantes" (union of `participants[].name` from loaded meetings).
- Same pattern chip "Etiqueta" (user labels).
- Chip "Estado" (En vivo / Procesando / Lista / Revisar).
- Active filters render as removable `Badge variant="secondary"` pills after the chips.

List body: `ScrollArea` full-height, rows are `<Link>` blocks (not a `Table`): `px-6 py-4 border-b hover:bg-accent/50` — left: title `text-sm font-medium` + second line `text-xs text-muted-foreground` "{localized startedAt} · {n} participantes · {duration}"; label `Badge`s with emoji inline after title; center-right: overlapping `Avatar` group (max 4 + "+N", `size-6`, fallback initials colored by `chart-*` index); status `Badge` — "En vivo" (`capturing`: `bg-destructive/10 text-destructive` + pulsing dot, links to `/live?id=`), "Procesando" (`processing`: `secondary` + `Spinner` + current phase label, e.g. "Procesando · Resumen", from `pipeline.phase` mapped to Spanish labels in `lib/config.ts`), "Revisar" (`needs_review`: `outline` with `text-chart-4` amber tint + `TriangleAlert` icon), ready shows nothing; far right: `DropdownMenu` (`MoreHorizontal` ghost icon button): "Abrir", "Renombrar" (Dialog + Input → PATCH), "Etiquetas ▸" (checkbox submenu), "Exportar ▸" (TXT/Markdown/PDF, see 3.11), "Reprocesar" (only when `ready`/`needs_review` → confirm Dialog → `POST /meetings/{id}/reprocess`, row flips to Procesando), `DropdownMenuSeparator`, "Eliminar" in destructive style → **`AlertDialog`** ("¿Eliminar esta reunión? Esta acción no se puede deshacer." / Cancelar / Eliminar) → `DELETE`, optimistic removal + `toast` with "Deshacer"-less confirmation (API has no undo).

Search: client-side over title + participants; full-text over transcripts is deferred (would need a search endpoint) — command palette covers titles.

States: loading = 6 `Skeleton` rows; empty = `Empty` component, icon `Mic`, "Todavía no hay reuniones", subtitle "Instalá la extensión y unite a una reunión de Teams para empezar."; filtered-empty = "Sin resultados" + "Limpiar filtros" ghost button.

### 3.3 Meeting detail (`/meeting?id=`) — shell

Wrap `useSearchParams` usage in `<Suspense>`. Header: `SidebarTrigger`, `Breadcrumb` (Reuniones / {title}), title inline-editable (click → `Input` swap, Enter/blur saves via PATCH, `Pencil` icon on hover), right side: status Badge (same variants as §3.2, including the `pipeline.phase` progress badge while `processing`), "Exportar" outline Button (DropdownMenu), overflow menu (Renombrar, Etiquetas, **Reprocesar** → confirm Dialog → `POST /meetings/{id}/reprocess`, Eliminar).

When `status === "needs_review"`: an `Alert` (amber styling via `border-chart-4/50`) renders above the tabs — "Esta reunión quedó marcada para revisión: la verificación automática encontró afirmaciones sin respaldo en la transcripción." with an inline "Reprocesar" outline button and a link to the Resumen tab (unsupported bullets are flagged there, see §3.5).

Layout: `xl:` two columns — main column (Tabs) `flex-1 min-w-0` + right rail `w-[360px] border-l` hosting the **Q&A chat** permanently (3.6). Below `xl`: Q&A becomes a 4th tab "Preguntar".

Main `Tabs` (`variant` default, `px-6`): **Transcripción · Resumen · Estadísticas** (+ Preguntar on small).

### 3.4 Transcript tab (speaker colors, timestamps, search, highlights, edit)

Sticky sub-toolbar under tabs (`py-2 flex gap-2 items-center`): in-transcript search `Input` (icon `Search`, `w-56`) + match counter "3/12" + up/down ghost icon buttons (Enter/Shift-Enter also navigate); `Separator orientation="vertical"`; highlight-filter `ToggleGroup type="multiple"` of tag pills (📌 ✅ ❓ ⭐) that filters to tagged segments only; right-aligned: copy-all ghost button (`Copy`, copies Markdown), edit-mode `Switch` + label "Editar".

Body: `ScrollArea` (`max-w-3xl`, `px-6 py-6 space-y-5`). Segments come from the cleaned transcript artifact (§2) and are keyed/rendered by stable segment `id` (also used as the `[Tn]` anchor target and the React key). Each segment (component `TranscriptSegment`):
- Row: `Avatar size-7` fallback initials, `style={{backgroundColor: "var(--chart-N)"}}` where N = speaker index modulo 5 (map built once per meeting, stable order of first appearance); name `text-sm font-semibold` tinted `text-[var(--chart-N)]` in light — **keep body text `text-foreground`**, color only avatar+name (Tactiq restraint); timestamp `text-xs font-mono tabular-nums text-muted-foreground` formatted `mm:ss` from `startTime`, in a `Tooltip` with absolute time; assigned tags render as small emoji `Badge variant="outline"` pills after the timestamp.
- Text below, `pl-9 text-sm leading-6`. Search matches wrapped in `<mark class="bg-chart-4/30 rounded px-0.5">`; active match gets `ring-1 ring-ring` and `scrollIntoView`.
- Hover affordance (`opacity-0 group-hover:opacity-100`, right-aligned icon row): four emoji tag toggles (📌 Decisión, ✅ Acción, ❓ Pregunta, ⭐ Destacado — `Toggle size="sm"`, tooltip each; toggling PATCHes `{segments:[{id, tags}]}` /localStorage + optimistic), `Copy` (segment text), and in edit-mode a `Pencil`.
- Edit mode: clicking text (or Pencil) swaps to auto-growing `Textarea` with Guardar/Cancelar `size="sm"` buttons; save PATCHes `{segments:[{id, text}]}`. Deleting a segment: trash icon → `AlertDialog` "Eliminar este fragmento es irreversible." Edited segments show a subtle `text-xs text-muted-foreground` "(editado)".

Empty (status processing): `Empty` with `Spinner` "Transcripción en proceso…" + the current phase label under it + auto-refetch every 10 s while `status === "processing"`.

### 3.5 Summary tab (summary variants + action items)

Two stacked `Card`s, `max-w-3xl`.

**Card "Resumen"**: `CardAction` = `DropdownMenu` "Regenerar ▸" with variants — Corto, Detallado, Detallado con citas, Resumen + acciones. Backend has one stored summary; variants call existing `POST /ask` with canned prompts (from `lib/prompts.ts`, e.g. `"Generá un resumen corto (5 líneas) de esta reunión"`), result replaces the displayed text client-side with a "variante generada, no guardada" `text-xs` note + copy button. Content: `summary` paragraph, `Separator`, "Puntos clave" `<ul>` with `ChevronRight` markers (keyPoints). All summary text renders through `TurnRefText` (§2): the pipeline's inline `[Tn]` citations become clickable source chips that jump to the anchored transcript segment — this is the "sources" rendering the verification contract requires. When the meeting is `needs_review`, bullets whose claims the verification report marked unsupported get a small amber `TriangleAlert` icon + tooltip "Sin respaldo en la transcripción" (from `verification` data in `GET /meetings/{id}`). Loading: 3-line `Skeleton`; regenerating keeps old text with overlay `Spinner`.

**Card "Acciones"**: each actionItem = row with `Checkbox` (done state → PATCH `{actionItems:[{id, done}]}` /localStorage, checked = `line-through text-muted-foreground`), text (also `TurnRefText`-rendered), and owner as `Badge variant="secondary"` with `size-4` Avatar initials. Footer ghost button "Copiar como lista" (Markdown checklist to clipboard, `toast("Copiado")`). If summary absent and status ready: `Empty` + primary Button "Generar resumen" (runs the Detallado prompt via /ask).

### 3.6 Q&A chat (right rail / "Preguntar" tab)

Component `AskPanel`. Header row: `Sparkles` icon + "Preguntale a la reunión" `text-sm font-medium`.

- Message list: `ScrollArea flex-1 px-4`, session-only state (array of `{q, a}`; persisted per meeting in `sessionStorage`). User msg = right-aligned `bg-primary text-primary-foreground rounded-lg rounded-br-sm px-3 py-2 text-sm max-w-[85%]`; answer = left-aligned `bg-muted rounded-lg rounded-bl-sm`, rendered through `TurnRefText` (preserving line breaks) so `[Tn]` citations become clickable segment links instead of literal noise, with hover Copy icon. Pending = answer bubble with three-dot pulse (or `Skeleton` lines).
- Empty state: 3 suggested-question chips (`Button variant="outline" size="sm" rounded-full`): "¿Qué decisiones se tomaron?", "¿Qué quedó pendiente?", "Redactá un mail de seguimiento" — click sends immediately.
- Composer: bottom `border-t p-3`: auto-grow `Textarea rows=1` placeholder "Preguntá algo…", Enter sends / Shift+Enter newline, `Button size="icon"` `ArrowUp` primary; disabled while pending. Errors → destructive toast, question kept in composer.
- Kit prompts (3.8) deep-link here: `/meeting?id=X&prompt=<encoded>` auto-sends on mount.

### 3.7 Live transcript view (`/live?id=`)

Backed by the start/segments/finalize API deltas (§2): the extension creates the meeting at capture start (`POST /meetings` → `status: "capturing"`) and batch-appends finalized segments, so the meeting and its growing transcript exist server-side for the whole meeting. Full-width single column, no tabs.

- Header: pulsing red dot + "EN VIVO" `Badge` (shown while `status === "capturing"`), meeting title, elapsed time (`font-mono`), right: "Detener vista" ghost (back to /meetings). No pause control here (capture is controlled in the widget; this view is read-only mirror).
- Body: `ScrollArea` `max-w-3xl mx-auto py-6 space-y-4` of the same `TranscriptSegment` component (tags read-only live). Poll `GET /meetings/{id}` every 3 s, append-diff by segment `id`; auto-scroll pinned to bottom unless user scrolled up — then show floating pill Button "↓ Ir al final" (`fixed bottom-6`, `shadow-sm`).
- New segments animate in with `animate-in fade-in slide-in-from-bottom-1`.
- When status flips to `processing` (finalize): inline `Alert` "La reunión terminó. Generando resumen…" with Spinner + phase label; on `ready` (or `needs_review`) → toast + auto-redirect to `/meeting?id=`.
- Entry points: list-row "En vivo" badge, sidebar badge, and toast "Se está transcribiendo una reunión — Ver en vivo" (poll `GET /meetings` every 60 s in shell for any `capturing` meeting).

### 3.8 AI prompt kits (`/kits`)

Kits = curated prompt collections executed through existing `POST /ask`. Zero backend. Data: `lib/kits.ts` const (built-ins) + custom kits in `localStorage` (`kits:custom`).

- Header "Kits de IA" + primary Button "Crear kit".
- Grid `grid gap-4 sm:grid-cols-2 xl:grid-cols-3` of kit `Card`s: emoji `text-2xl`, `CardTitle`, `CardDescription`, footer `text-xs text-muted-foreground` "{n} prompts". Built-ins to ship: 📋 **Reuniones generales** (Resumen corto, Minuta formal, Mail de seguimiento), ✅ **Gestión de proyectos** (Acciones con responsables y fechas, Riesgos y bloqueos, Update de estado), 💼 **Ventas** (Resumen BANT, Objeciones y respuestas, Próximos pasos), 👥 **1:1 / RRHH** (Notas de 1:1, Feedback dado y recibido, Temas para próxima reunión), 🔬 **Retro/Brainstorm** (Ideas agrupadas por tema, Qué funcionó / qué no, Experimentos propuestos).
- Kit click → `Sheet side="right"` (`w-[420px]`): kit title, prompt rows (`text-sm font-medium` + preview `text-xs text-muted-foreground line-clamp-2`, hover: "Usar" primary `size="sm"` + Copy icon; custom kits also Edit/Delete). "Usar" → `CommandDialog` meeting picker ("¿Sobre qué reunión?", recent 20, searchable) → navigates `/meeting?id=X&prompt=…` (lands in AskPanel, auto-runs).
- "Crear kit" `Dialog`: emoji `Input` (plain text field, maxLength 2), name, then repeatable prompt rows (name + `Textarea`), "Agregar prompt" ghost, Guardar → localStorage. Saving an ad-hoc question from AskPanel: hover action "Guardar como prompt" on any sent question → mini-Dialog choosing kit.

### 3.9 Analytics — Speaker Stats ("Estadísticas" tab in meeting detail)

Computed 100% client-side from `segments`. Talk time per speaker = `Σ(endTime − startTime)` over that speaker's own segments (`endTime` is exposed by `GET /meetings/{id}`, see §2 — it already exists in the stored labeled segments and only needs surfacing in the web `Segment` type). Sort by `startTime` for display only. **Never** derive talk time from consecutive-segment deltas (`next.startTime − own.startTime`): that attributes silence to the previous speaker, and segments interleave two independent stream clocks (tab vs mic, interleaved by arrival), so deltas can be negative or meaningless. Fallback for legacy meetings whose segments lack `endTime`: estimate duration by word count / 2.5 wps. Also compute word count and interventions per speaker.

- `Card` "Participación": one row per speaker sorted desc — `Avatar` (chart color) + name + right-aligned `text-sm font-medium tabular-nums` "38 %"; below, a bar: `h-2 rounded-full bg-muted` track with inner `div` `style={{width: pct+"%", backgroundColor: "var(--chart-N)"}}`. Under the bar `text-xs text-muted-foreground` "12 min · 47 intervenciones".
- `Card` "Resumen de la sesión": 3 inline stat tiles (`grid grid-cols-3 divide-x`): Duración, Participantes, Palabras — value `text-xl font-semibold tabular-nums`, label `text-xs text-muted-foreground`.
- Balance hint: if top speaker > 60 %, muted footnote "⚖️ {name} habló más del 60 % del tiempo." No cross-meeting analytics page (dropped, §6).

### 3.10 Settings (`/settings`)

Single column `max-w-2xl`, stacked `Card`s:
1. **Cuenta**: Avatar + email (read-only), user pool region info `text-xs`; destructive-outline Button "Salir" (→ `signOut()` + redirect).
2. **Apariencia**: `Select` Tema (Claro/Oscuro/Sistema) via `useTheme`.
3. **Etiquetas**: list rows (emoji + name + count) with edit/delete icon buttons (delete = AlertDialog if in use); "Nueva etiqueta" ghost → Dialog (emoji text field + name). Defaults seeded: `1:1`, `Recurrente`, `Larga`, `Cliente`. Stored in `localStorage` (`labels:defs`) until PATCH delta persists per-meeting assignment server-side.
4. **Tags de momento**: the four built-ins (📌✅❓⭐) shown read-only + custom tag rows (emoji + name, add/delete) — merged into transcript hover toggles and widget buttons.
5. **Datos**: Button "Exportar todas las reuniones (ZIP de Markdown)" — client-side: fetch each meeting, build files, zip with `fflate` (only new dep, 8 kB), `toast` on done. `text-xs` note on retention: data lives in your own AWS account.
6. **Extensión**: install hint card with the extension id + "La extensión usa esta misma cuenta" copy.

### 3.11 Sharing / Export

No public share links (dropped — static-auth’d app, §6). Export per meeting via the "Exportar" DropdownMenu (list row + detail header):
- **Markdown (.md)** — title, metadata, Resumen, Acciones, Transcripción `**Speaker** (mm:ss): text`; Blob download.
- **Texto (.txt)** — plain transcript.
- **PDF** — `window.print()` on a print-only DOM (`hidden print:block` render of full meeting) + `@media print` styles (serif-free, black on white, no shell). Menu item label "PDF (imprimir)".
- **Copiar Markdown** — clipboard + toast.
"Compartir con el equipo" is implicit: single-team backend, everyone with a Cognito user sees all meetings (current behavior); state this in Settings copy.

---

## 4. Extension popup + in-meeting widget (plain Tailwind)

Both use a standalone Tailwind v4 build (`extension/src/styles.css`). Radius/type/palette identical to the app. No shadcn (no React requirement assumed; if extension is React, plain JSX + these classes). Dark via `prefers-color-scheme` fallback class.

**Popup** is an extension page (its own isolated document), so a normal Tailwind import with the §1.2 `:root`/`.dark` token blocks is fine there.

**Widget (content script) must never inject styles into the Teams DOM.** `@import "tailwindcss"` ships preflight — global element resets that would restyle the host app, while Teams' CSS would bleed into the widget and a page-level `:root` token block both leaks out and can be overridden. Instead:
- Mount the widget inside a **closed ShadowRoot** on a positioned host element (this is also what the extension architecture prescribes for overlays).
- Compile a widget-specific sheet with **preflight disabled** (or scoped via Tailwind v4 `@layer`/source scoping so resets only apply inside the shadow tree).
- Declare the §1.2 token blocks on **`:host`** (and `:host(.dark)`), never `:root`.
- Attach the compiled CSS via a **constructable stylesheet** (`shadowRoot.adoptedStyleSheets = [sheet]`) — no `<style>`/`<link>` in the page document.

### 4.1 Popup (`~320×auto`)

`w-80 p-4 bg-background text-foreground text-sm font-sans` column, `space-y-3`:
1. Header row: APP_NAME wordmark `font-semibold` + status dot (`size-2 rounded-full` — green `bg-chart-5` conectado / gray sin sesión / red `bg-destructive` capturando).
2. Auth block: signed-out → email/contraseña inputs (`h-9 rounded-md border border-input bg-background px-3`) + primary button (`h-9 rounded-md bg-primary text-primary-foreground font-medium`); signed-in → avatar initials circle + email + "Salir" text button `text-muted-foreground hover:text-foreground`.
3. Capture card (`rounded-lg border p-3`): "Transcripción automática" label + toggle (checkbox styled as `h-5 w-9 rounded-full bg-muted checked:bg-primary` switch). **Toggle behavior (specified)**: the content-script DOM adapter detects meeting join (Teams call-controls toolbar appearing) and messages the service worker. If the toggle is ON **and** mic permission was already granted (i.e., at least one prior successful manual capture — the pre-grant; `getUserMedia` can't be silently granted without a user gesture), the service worker starts capture automatically (same path as the manual popup flow: `POST /meetings` start call, widget shown). If the toggle is ON but permission is missing, it sets a badge on the extension icon + shows a notification "Reunión detectada — hacé clic para transcribir" prompting a one-click manual start. Toggle OFF = manual flow only. When a meeting is active: pulsing red dot + "Transcribiendo · {mm:ss}" + button "Ver en vivo" (opens `/live?id=` tab — the `meetingId` exists from capture start, §2).
4. "Últimas reuniones": 3 rows (title truncate + `text-xs text-muted-foreground` date), click opens dashboard detail.
5. Footer link "Abrir panel →" `text-primary text-xs font-medium`.

### 4.2 In-meeting widget (content-script overlay, inside the closed ShadowRoot per §4)

Low-chrome caption panel, visually quieter than the app:
- Container (shadow host is the fixed element; classes apply inside the shadow tree): `w-[340px] h-[60vh] flex flex-col rounded-xl border border-border bg-background/95 backdrop-blur shadow-lg font-sans text-sm`; host element `fixed top-20 right-4 z-[2147483647]` — draggable by header, position persisted; minimize collapses to a `size-10 rounded-full` floating button with pulsing dot.
- Header (`h-10 px-3 flex items-center gap-2 border-b cursor-move`): red pulsing dot, "Transcribiendo" `text-xs font-medium`, elapsed `text-xs font-mono text-muted-foreground`, right: pause/resume icon button (paused → dot gray, header text "En pausa"), minimize (`—`).
- Transcript area (`flex-1 overflow-y-auto px-3 py-2 space-y-2`): each caption = name `font-semibold text-xs` colored by same chart-1..5 speaker mapping + text `leading-5`; auto-scroll bottom with same "↓" pill-on-scroll-up behavior; interim (non-final) text `text-muted-foreground italic`.
- Footer tag bar (`h-11 border-t px-2 flex items-center gap-1`): four emoji buttons 📌 ✅ ❓ ⭐ (`size-8 rounded-md hover:bg-accent`, `title` tooltips: Decisión/Acción/Pregunta/Destacado) — tap tags the **most recent finalized segment** (brief indigo flash `ring-1 ring-ring` on that caption; tags ride the segments-append payload, §2); plus `Copy` icon (copies transcript so far) and a `⋯` menu (Ver en el panel, Pausar notificaciones = quiet mode toggling toasts off).
- No in-widget "ask AI / generate summary" action in v1 — see §6 (dropped with dependency stated).
- All widget copy Spanish; only the current user sees it (bot-free, same as Tactiq).

---

## 5. Migration plan (ordered; each step ships green)

1. **Toolchain**: in `web/` add `tailwindcss @tailwindcss/postcss postcss tw-animate-css next-themes lucide-react`; add `"paths": {"@/*": ["./*"]}` to `web/tsconfig.json`; create `app/globals.css` with §1.2 tokens; import it in `layout.tsx`; set `trailingSlash: true` in `next.config`.
2. **shadcn init + add** (commands in §1.5, including `alert spinner`) → `components.json`, `lib/utils.ts`, `components/ui/*`. Verify `next build` (static export) passes.
3. **Root layout rewrite**: drop inline `<body>` styles; Inter via `next/font`, `ThemeProvider`, `<Toaster />` (sonner), `<html lang="es" suppressHydrationWarning>`.
4. **Auth extraction**: `components/auth-provider.tsx` (context over existing `lib/auth.ts`, untouched), `app/login/page.tsx` per §3.1, `app/page.tsx` → gate/redirect. Old dashboard still renders behind the gate.
5. **Shell**: `components/app-sidebar.tsx` + `components/command-menu.tsx` per §2; move dashboard under `app/meetings/page.tsx` inside `SidebarInset`.
6. **Meeting list** per §3.2 (port fetch/delete logic from old `page.tsx`; `confirm()` → `AlertDialog`; add filters/search/skeletons/empty states; `needs_review` badge + phase badge render from whatever the API already returns).
7. **Meeting detail** at `app/meeting/page.tsx` per §3.3–3.6: `TranscriptSegment`, `TurnRefText`, Summary card, `AskPanel` — feature parity reached; **delete the old monolithic `page.tsx` styles/components**. `lib/api.ts`, `lib/auth.ts`, `lib/config.ts` remain untouched.
8. **Net-new client-only features**: highlights/edit/labels with localStorage overlay (keyed by segment `id`), kits (`/kits`, `lib/kits.ts`), Estadísticas tab (with word-count fallback until `endTime` ships), export (Markdown/TXT/print-PDF), settings page.
9. **API deltas — detail/edit** (backend/infra): `PATCH /meetings/{id}` keyed by stable segment ids, `POST /meetings/{id}/reprocess` wiring, `GET /meetings/{id}` serving clean-transcript turns with `id` + `endTime`, `needs_review`/`pipeline.phase`/verification fields in `lib/api.ts` types; swap localStorage overlay for PATCH (keep overlay code as offline fallback); switch talk-time math to `Σ(endTime − startTime)`.
10. **API deltas — live**: `POST /meetings` at capture start, `POST /meetings/{id}/segments`, `POST /meetings/{id}/finalize`, status `"capturing"` transitions (must land as an explicit architecture-doc milestone, §2); then `/live` view, shell live-poll, popup "Ver en vivo", and extension incremental posting.
11. **Infra routing**: add CloudFront Function (viewer-request) rewriting URIs without file extension to `${uri}index.html`; keep 403/404→/index.html fallback. Redeploy web bucket.
12. **Extension restyle**: widget-scoped Tailwind build (preflight-disabled, `:host` tokens) in `extension/`, popup §4.1 (incl. auto-start toggle behavior), widget §4.2 mounted in the closed ShadowRoot with constructable stylesheet, tag payload on the segments append.

Steps 1–8 need zero backend change. Verify each step in browser (dev server) before proceeding.

---

## 6. Tactiq feature coverage

**Covered**: bot-free live transcription (extension, Teams) · auto-start transcription on meeting join (toggle, §4.1 — permission-pre-grant caveat applies) · live in-meeting widget w/ rolling captions, pause, quiet mode · live transcript web view (via start/segments/finalize ingest, §2) · speaker identification + timestamps · in-meeting highlight tags (4 built-ins + custom) · AI summaries with 4 variants, with clickable `[Tn]` source citations into the transcript · verification surfacing (`needs_review` status, unsupported-claim flags, Reprocesar action) · action-item extraction w/ owners + done-state · custom AI prompts + save-as-reusable · AI Meeting Kits (5 built-in kits + custom kit builder) · Ask-anything Q&A per meeting w/ suggested questions + cited answers · speaker talk-time stats · search (titles/participants + in-transcript find w/ highlight) · labels (defaults + custom, filters) · transcript editing incl. irreversible segment delete (id-keyed, survives pipeline rewrites) · export PDF/TXT/Markdown + copy · dark mode · team-shared workspace (implicit: one Cognito pool = one team, all members see all meetings).

**Deferred (roadmap, dependency stated)**:
- **In-meeting AI (ask AI / generate summary live from the widget)** — requires server-side Q&A/summarization over a *partial* transcript. The incremental-ingest delta (§2) is the prerequisite and now exists in the spec, but mid-meeting synthesis over an uncleaned, incomplete transcript is a separate quality/product decision (no speaker correlation or cleanup has run yet). Roadmap: a "Preguntar" action in the widget footer gated on the segments endpoint + a partial-transcript ask mode.
- **Upload & transcribe files** — the batch-transcription infrastructure milestone (identity-scoped S3 upload, batch ASR job + async callback, merge/re-ingest into the summarization pipeline) builds almost everything this needs; post that milestone this is a thin presigned-upload UI over existing infra, **not** a separate workstream. The real remaining gap: uploaded media has no caption/participant timeline, so speakers get diarization-only labels ("Hablante 1/2/…") instead of names.
- **Cross-meeting AI search ("ask across all meetings")** — needs embeddings/index; per-meeting Ask ships now; highest-value future backend feature.

**Deliberately dropped — and why**:
- **Zoom/Meet support** — extension targets MS Teams only; UI is platform-agnostic if that changes.
- **Destination integrations (Slack/Notion/HubSpot/Zapier) & AI Workflows canvas** — each needs OAuth apps, secrets storage, and an automation runtime; disproportionate for self-hosted single-team v1. Export-to-Markdown covers the paste-anywhere path.
- **Spaces/folders + per-member permissions & roles** — single team, flat visibility; labels give grouping at ~5 % of the complexity (no membership model in the backend).
- **Public share links / share via email** — requires unauthenticated read endpoints + link tokens; conflicts with the private-by-default posture. PDF/Markdown export replaces it.
- **In-meeting screenshots & comments** — screenshots need media storage + inline pinning pipeline; comments need a per-line threading model. Highlights + Q&A cover the recall use case.
- **YouTube import tool** — depends on the upload path above plus source-fetch plumbing; not worth it self-hosted.
- **AI credits / pricing tiers / SSO / compliance badges** — SaaS monetization & enterprise IT concerns; meaningless self-hosted (LLM usage is pay-per-use in your own account).
- **Multi-language transcription config UI** — streaming-ASR language is set by the extension; a settings dropdown is trivial to add later, omitted until the extension exposes it.
- **Cross-meeting analytics dashboard** — per-meeting Speaker Stats ships; global trends need aggregation the API doesn't offer and single-team value is low.
- **MCP/assistant connector** — out of scope for the dashboard UI.

Key files: `/home/mauricio/repos/teams-agent-core/web/app/page.tsx` (to be decomposed), `/home/mauricio/repos/teams-agent-core/web/app/layout.tsx`, `/home/mauricio/repos/teams-agent-core/web/lib/{api,auth,config}.ts` (untouched through step 8), `/home/mauricio/repos/teams-agent-core/infra/lib/teams-agent-core-stack.ts` (steps 9–11).