# teams-agent-core

Transcripción, resúmenes y Q&A de reuniones de Microsoft Teams, self-hosted en AWS.
Estilo Tactiq: una extensión de Chrome captura el audio de la PWA de Teams, lo transcribe
con Amazon Transcribe (identificando al hablante por nombre real), y un dashboard muestra
transcripciones, resúmenes y action items generados por un agente Claude en Bedrock.

## Arquitectura

```
Extensión Chrome (MV3)                 AWS (sandbox 471446759294 / us-east-1)
 ├ tabCapture (otros) ─┐               ┌ API Gateway (JWT authorizer)
 ├ getUserMedia (vos) ─┼─► Transcribe  │   POST /meetings      → ingest Lambda
 │   (creds Identity Pool, directo)    │     · correlación Speaker↔nombre
 ├ content script ─────► timeline      │     · Bedrock (Claude) → resumen
 │   (hablante activo del DOM)         │   GET  /meetings[/id]  → lectura
 └ POST transcript ────────────────────►  POST /meetings/{id}/ask → Q&A
                                        ├ DynamoDB (multitenant PK/SK) + S3
                                        └ S3 + CloudFront → dashboard Next.js
```

El **audio nunca toca el backend**: la extensión habla directo con Transcribe usando
credenciales temporales de un Cognito Identity Pool scoped solo a `StartStreamTranscription`.
Solo el texto del transcript llega a AWS.

## Workspaces

| Path | Qué es |
|------|--------|
| `packages/shared` | Tipos + `correlateSpeakers` (núcleo: mapea diarización → nombres). Tests: `npm test -w @teams-agent-core/shared` |
| `backend` | Lambdas: ingest (correlación + resumen), lectura, Q&A. Agente en `src/lib/agent.ts` (Bedrock Converse) |
| `infra` | CDK: Cognito, API Gateway, DynamoDB, S3, CloudFront, Lambdas |
| `extension` | Chrome MV3: captura + `teams-dom-adapter` + Transcribe + auth. Build: `npm run build -w @teams-agent-core/extension` |
| `web` | Dashboard Next.js (static export) |

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
