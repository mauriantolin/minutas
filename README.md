# teams-agent-core

Transcripción, resúmenes y Q&A de reuniones de Microsoft Teams, self-hosted en AWS.
Estilo Tactiq: una extensión de Chrome captura el audio de la PWA de Teams, lo transcribe
con Amazon Transcribe (identificando al hablante por nombre real), y un dashboard muestra
transcripciones, resúmenes y action items generados por un agente Claude en Bedrock.
Minutix Desktop convive como alternativa Windows para Teams Desktop: lee subtítulos en vivo
por UI Automation y envía segmentos al mismo backend, sin grabar audio.

## Arquitectura

```
Extensión Chrome (MV3)                 AWS (sandbox 471446759294 / us-east-1)
 ├ tabCapture (otros) ─┐               ┌ API Gateway (JWT authorizer)
 ├ getUserMedia (vos) ─┼─► Transcribe  │  POST /meetings            → start (captura)
 │   (creds Identity Pool, directo)    │  POST /meetings/{id}/segments → checkpoint/live
 ├ captions + timeline (DOM) ──┐       │  POST /meetings/{id}/finalize → Step Function
 ├ widget in-meeting (tags) ───┤       │  POST /meetings/{id}/reprocess · /ask (Q&A)
 ├ audio opt-in → OPFS ────────┤       │  GET  /meetings[/id]        → lectura
 └ segmentos + finalize ───────┴──────►│
                                       ├ MeetingPipeline (SFN Standard):
                                       │   correlate → gates → clean → extract →
                                       │   synthesize → verify → (repair/escalate) → publish
                                       ├ Bedrock (Haiku default; Sonnet/Opus solo si un
                                       │   gate lo exige; prompt caching entre fases)
                                       ├ Transcribe batch re-ASR (solo consent tier 2)
                                       ├ DynamoDB + S3 (SSE-KMS) · CloudWatch alarms
                                       └ S3 + CloudFront → dashboard Next.js + shadcn/ui
```

Pipeline por fases con gates programáticos (ver `docs/architecture-pipeline.md`): cada
resumen se **verifica claim-por-claim** contra el transcript; si no verifica escala
(repair → Sonnet → Opus) y si aun así falla publica como `needs_review`, nunca como
verdad silenciosa. Estados: `capturing → processing → ready | needs_review`.

El **audio nunca toca el backend por default**: la extensión habla directo con Transcribe
con credenciales del Identity Pool. Grabación local (OPFS) y re-transcripción batch de
alta fidelidad solo con consentimiento explícito por reunión (escalera de 3 tiers,
lifecycle de 7 días, KMS).

**Diseño:** `docs/architecture-pipeline.md` (pipeline) · `docs/ui-spec.md` (UI).

## Workspaces

| Path | Qué es |
|------|--------|
| `packages/shared` | Tipos + `correlateSpeakersV2` (captions/anchors + votación por ventanas) + fuzzy quote matching. Tests: `npm test -w @teams-agent-core/shared` |
| `backend` | Lambdas: lifecycle API, worker de pipeline (`src/handlers/pipeline.ts`, fases P2–P8), Q&A. Cliente Bedrock tiered en `src/lib/agent.ts` |
| `infra` | CDK: Cognito, API GW, DynamoDB, S3 (KMS), CloudFront (+function de rutas), Step Function `MeetingPipeline`, EventBridge (Transcribe callback), alarms |
| `extension` | Chrome MV3: captura + captions + VAD + checkpoints IndexedDB + audio opt-in OPFS + widget in-meeting. Build: `npm run build -w @teams-agent-core/extension` |
| `desktop` | Minutix Desktop para Windows/Teams Desktop (WPF + UI Automation). Build: `powershell -File desktop/tools/Publish-MinutasDesktop.ps1` |
| `web` | Dashboard Next.js static export + Tailwind v4 + shadcn/ui (rutas: `/meetings`, `/meeting?id=`, `/live?id=`, `/kits`, `/settings`) |

## Recursos desplegados (sandbox)

| | |
|-|-|
| Dashboard | https://d50200vgx8fgw.cloudfront.net |
| API | https://rv3wzr5llg.execute-api.us-east-1.amazonaws.com |
| UserPoolId | `us-east-1_8iPeU4V78` |
| UserPoolClientId | `18m3lcii9uq8qd3k3f59kplgns` |
| IdentityPoolId | `us-east-1:846a80da-00b1-4db1-8ba5-206249505f29` |

## Deploy

```bash
export CDK_DEFAULT_ACCOUNT=471446759294 CDK_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1
npm install
npm run build -w @teams-agent-core/shared
cd infra && npx cdk deploy --require-approval never
# Dashboard:
cd ../web && npm run build
aws s3 sync out "s3://<WebBucketName>" --delete
```

El deploy de GitHub Actions genera automáticamente los descargables servidos desde
Configuración:

- `web/public/minutix-extension.zip`
- `web/public/minutix-desktop-win-x64.zip`

## Probar end-to-end — 2 prerequisitos

1. **Crear un usuario de Cognito** (para login en extensión y dashboard):
   ```bash
   aws cognito-idp admin-create-user --user-pool-id us-east-1_8iPeU4V78 \
     --username you@example.com --message-action SUPPRESS
   aws cognito-idp admin-set-user-password --user-pool-id us-east-1_8iPeU4V78 \
     --username you@example.com --password 'Str0ng!Pass' --permanent
   ```
2. **Habilitar acceso al modelo en Bedrock** (consola → Bedrock → Model access) para el
   modelo de `BEDROCK_MODEL_ID` (default `us.anthropic.claude-opus-4-8`). Sin esto, el ingest
   guarda el transcript pero marca la reunión `failed` en el resumen.

Después:
- **Extensión:** `npm run build -w @teams-agent-core/extension` → cargar `extension/dist`
  como *unpacked* en `chrome://extensions`. Abrir una reunión en la PWA de Teams, login en el
  popup, **Start**, y al terminar **Stop & summarize**.
- **Desktop:** `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/tools/Publish-MinutasDesktop.ps1`
  → ejecutar `desktop/publish/Minutix.Desktop-win-x64/Minutix.Desktop.exe`. Abrir Teams
  Desktop con subtítulos en vivo, login en la app, **Empezar a transcribir**, y al terminar
  **Detener y resumir**.
- **Dashboard:** entrar a la URL de CloudFront, login, ver la reunión con transcripción +
  resumen + Q&A.

## Limitaciones conocidas

- **`teams-dom-adapter`** depende del markup de la PWA de Teams (selectores de "hablante
  activo"). Si Microsoft lo cambia, ajustar `SELECTORS` en `extension/src/teams-dom-adapter.ts`
  y validar contra Teams real — es el único punto que hay que parchear.
- Diarización de Transcribe: óptima con **2–5 hablantes**; degrada por encima.
- Captura solo reuniones donde estás presente con el navegador abierto.
- Consentimiento de participantes: responsabilidad del uso, no resuelto por la app.
```
