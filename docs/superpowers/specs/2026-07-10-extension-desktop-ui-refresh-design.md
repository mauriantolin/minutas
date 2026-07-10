# UI refresh — extension + desktop (Orca/VS Code line, shadcn)

**Goal:** Rework the extension (popup + in-meeting widget) and the WPF desktop app to a
minimal, rounded, chrome-less look consistent with each other and with the web dashboard's
shadcn design. Concise copy, meaningful buttons, explanations moved to hover tooltips.

## Decisions (locked)

- **Extension popup → React + shadcn.** Real shadcn components reused from the web (copied,
  not shared package — shadcn philosophy, avoids refactoring the web). New toolchain: React +
  Tailwind v4 wired into the existing esbuild build.
- **Widget → stays vanilla in the closed ShadowRoot** (Radix can't mount cleanly there).
  Restyled to the same token line; already declares tokens on `:host` with `prefers-color-scheme`.
- **Theme: adaptive light/dark on all three surfaces**, following the OS, using the exact
  ui-spec §1.2 shadcn tokens (so popup == web).
- **Accent: Minutix indigo** (brand), not VS Code blue.
- **Desktop: chrome-less rounded window** (`WindowStyle=None`, transparency, rounded root
  Border + soft shadow, custom minimal title bar with drag + min/close). No global window
  scroll — layout fits; live transcript keeps an internal thin/overlay scroll.
- **Desktop theme adaptive**: two `ResourceDictionary` (light/dark) swapped at runtime from the
  Windows `AppsUseLightTheme` registry value + `SystemEvents.UserPreferenceChanged`; brushes
  referenced via `DynamicResource`.

## Copy simplification (transversal)

No on-screen help paragraphs — move to hover tooltips (on a `ⓘ`/`?` icon or the control itself).

| Before | After |
|---|---|
| ● Empezar a transcribir | ▶ Transcribir |
| ■ Detener y resumir | Detener |
| Descartar captura | Descartar |
| "Captura automática (subtítulos de Teams)" | Card **Captura** + row "Automática" + switch |
| paragraph "Lee subtítulos… No graba audio." | tooltip on card ⓘ |
| Buscar actualizaciones | row **Actualizaciones · v1.2 · Buscar** |
| Reiniciar Teams (paragraph) | row **Alta fidelidad · Reiniciar** + tooltip |

## Architecture

### Extension
- `extension/src/ui/*` — copied shadcn: button, input, card, switch, avatar, badge, tooltip,
  separator; `extension/src/lib/utils.ts` (`cn`).
- `extension/src/styles/globals.css` — ui-spec §1.2 `:root`/`.dark` tokens + Tailwind import,
  compiled by `@tailwindcss/cli` in `build.mjs` (JS bundled by esbuild with the automatic JSX runtime).
- `popup.tsx` + hooks preserve ALL current logic (auth, `GET_STATE`/`POPUP_START`/`STOP`/`CANCEL`,
  elapsed timer, recent meetings, dashboard deep links). `popup.html` becomes a thin React mount.
- Deps added: react, react-dom, tailwindcss, @tailwindcss/cli, radix-ui, class-variance-authority,
  clsx, tailwind-merge, lucide-react.
- Widget: restyle CSS in `widget.ts` only; behavior untouched.

### Desktop
- `UI/Theme.Light.xaml`, `UI/Theme.Dark.xaml` — brush tokens (BgBrush, SurfaceBrush, PanelBrush,
  BorderBrushSoft, TextBrush, MutedBrush, SubtleBrush, PrimaryBrush, PrimaryHoverBrush, AccentBrush,
  DangerBrush, OkBrush, InputBgBrush, HoverBrush) mapped to shadcn light/dark values.
- `Services/ThemeManager.cs` — reads registry, sets `Application.Current.Resources.MergedDictionaries`,
  live-swaps on `UserPreferenceChanged`. Applied in `Program.cs` before window creation.
- `MainWindow.xaml` — chrome-less window; brushes via `DynamicResource`; condensed layout, no
  ScrollViewer wrapping the whole grid; keep every `x:Name` + `OkBrush`/`SubtleBrush` keys the
  code-behind uses; custom title bar buttons wired in code-behind (drag/min/close).

## Verification
- Extension: `npm run build` in `extension/` must succeed and produce the zip; load unpacked to eye-check.
- Desktop: **cannot compile on Linux (WPF/net10-windows)** — verified by CI (windows-latest pack job)
  and eye-review of XAML/C#. Called out explicitly.

## Deploy
Commit on `ui-orca`, then merge/push to `main` → GitHub Actions OIDC deploys web (with refreshed
extension zip) and packs the desktop installer.
