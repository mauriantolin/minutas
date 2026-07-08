# Captions de Teams como única fuente + auto-encendido + auto-arranque

**Fecha:** 2026-07-08
**Estado:** aprobado, en implementación

## Problema

El producto captura reuniones de Teams por dos caminos que interpretan el audio de
formas distintas:

1. **Captions-primary** (extensión y desktop): se leen los subtítulos en vivo de Teams
   y se sintetizan segmentos `source:"caption"`. $0 de ASR, nombre de hablante ya
   atribuido.
2. **Audio/Transcribe (raw fallback)**: solo en la extensión. El *Start* manual abre un
   offscreen document, hace `tabCapture` del audio de la pestaña y lo manda a Amazon
   Transcribe.

El usuario quiere **una sola forma de interpretar el audio: los live captions de Teams**.
Además, al entrar a una reunión los subtítulos deben **encenderse solos** y la
transcripción debe **arrancar sola**. Debe comportarse igual en la extensión (Teams web)
y en la app de escritorio `desktop/` (WPF, lee Teams de escritorio por UI Automation).

Estado medido antes del cambio:

| Requisito | Extensión | Desktop |
|---|---|---|
| A. Solo captions | ❌ raw fallback vivo (default del Start manual) | ✅ ya captions-only |
| B. Auto-encender captions | ✅ `enableCaptions()` | ❌ solo lee por UIA |
| C. Auto-arrancar al entrar | ✅ `observeMeetingPresence` | ❌ solo botón manual |

## Decisiones

- Raw fallback de audio en la extensión: **eliminar por completo** (archivos, permisos,
  consent tiers, micrófono).
- Si Teams no logra activar los subtítulos: **avisar y seguir intentando**, nunca caer a
  audio. Captions es la única fuente.
- Desktop auto-encendido: **UIA best-effort** (navegar Más → Idioma y voz → Activar
  subtítulos con `InvokePattern`) + aviso persistente de backstop.
- Botón *Start* manual: **se mantiene** en ambos, pero en modo captions (red de
  seguridad si el auto-detect no dispara).
- **Backend sin cambios.** Los segmentos caption ya fluyen; los endpoints de audio/tier-2
  quedan sin uso (fuera de scope removerlos).

## Parte A — Extensión (Chrome / Teams web)

### Borrar
- `extension/src/offscreen.ts`, `offscreen-creds.ts`, `transcribe.ts`, `audio-store.ts`,
  `permission.ts`
- `extension/public/offscreen.html`, `permission.html`, `pcm-worklet.js`

### Modificar
- **`background.ts`**: eliminar `CaptureMode "audio"` y toda su rama en `startCapture`
  (`ensureOffscreen`, `tabCapture.getMediaStreamId`, `sendToOffscreen`, `streamId`,
  `consentTier`, `captionsPrimary`/`crossCheck`, `settleAudio`, `putWithRetry`,
  `audioFinalizeFields`, `ASR_REARMED`, heartbeat→offscreen). `startCapture` queda
  captions-only. `POPUP_START` arranca en captions sin consentTier. Se quitan los imports
  de `audio-store`. `stopCapture`/`cancelCapture` dejan de mensajear/cerrar el offscreen.
  `signalHealth.asrMode` fijo `"captions-primary"`.
- **`popup.ts`**: quitar selector de consent, `micGranted()`, apertura de `permission.html`
  y la etiqueta "Audio (Transcribe)" (queda "Subtítulos de Teams"). Se conservan login,
  toggle "captura automática" (default ON), recientes, botón Empezar (modo captions).
- **`config.ts`**: quitar `captionsPrimaryEnabled`, `crossCheckFraction`, `sampleRate`,
  `transcribeLanguage`, `pcmRingSeconds`, `audioTimesliceMs`, `audioRetentionDays`.
- **`manifest.json`**: quitar permisos `tabCapture`, `offscreen`; se retiene `storage`,
  `scripting`, `activeTab`, `notifications`.
- **`build.mjs`**: quitar los entrypoints `offscreen` y `permission`.
- **`idb.ts`**: se conservan los checkpoints de segmentos/captions; se remueve solo lo
  ligado al audio store si aplica.

### Sin captions (backstop)
`widget.ts` gana una mini-API `setNotice(text|null)` para un banner persistente. En
`content.ts`, si tras `enableCaptions()` los captions siguen ausentes, se muestra
"Activá los subtítulos de Teams para transcribir" y se reintenta el enable en background
mientras la reunión siga viva.

## Parte B — Desktop (WPF / UIA / Teams de escritorio)

Ya es captions-only. Se agrega:

### Auto-encender captions (nuevo)
`TeamsCaptionEnabler` (o método en `TeamsCaptionWatcher`): ubica la ventana de la llamada
de Teams y navega **Más opciones → Idioma y voz → Activar subtítulos en vivo** clickeando
con `InvokePattern`/`LegacyIAccessible`, con reintentos (best-effort, espeja
`enableCaptions()` de la extensión). Si no lo logra, `StatusChanged` con aviso persistente
"Activá los subtítulos de Teams" y sigue reintentando + leyendo. Se dispara al iniciar la
captura.

### Auto-arranque por presencia (nuevo)
`MeetingPresenceWatcher`: poll UIA (~2 s) que detecta una llamada activa de Teams
(presencia del control **Leave**/hangup o de la ventana de llamada) con debounce
join≈3 s / leave≈8 s (espeja `observeMeetingPresence`). En *join* → si hay sesión, la
captura automática está ON y no hay captura en curso, invoca `CaptureSessionService.StartAsync`
+ el encendido de captions. En *leave* → `StopAsync` solo si la captura fue auto-iniciada.

### Setting + UI
`AppSettings.AutoCapture` (default ON) + toggle en `MainWindow`. Sin sesión al detectar
reunión → notificación en la bandeja (espeja la notificación de la extensión). El botón
*Iniciar captura* manual se mantiene.

## Parte C — Backend / telemetría
Sin cambios de backend. `signalHealth.asrMode`: extensión `"captions-primary"`, desktop
`"teams-desktop-uia"` — solo telemetría.

## Verificación
- **Extensión**: `npm run build -w @teams-agent-core/extension` (regenera el zip) +
  `tsc -b` (typecheck) localmente. Prueba funcional en una reunión real la hace el usuario.
- **Desktop**: WPF `net10.0-windows`; no hay `dotnet` en el entorno Linux de desarrollo.
  La compilación real es el **gate de CI** (`deploy.yml`, ubuntu + dotnet 10 +
  `EnableWindowsTargeting`, `Publish-MinutasDesktop.ps1 -Runtime win-x64`). La prueba de
  UIA (auto-encendido/auto-arranque) se corre en Windows.

## Deploy
Push a `main` dispara `.github/workflows/deploy.yml` (OIDC): CDK infra → build extensión
(zip) → publish desktop (zip win-x64) → build web → `s3 sync web/out` → invalidación de
CloudFront. Ambos downloads (extensión y desktop) se sirven desde la página Configuración.
