# CI/CD — Push a `minutas` + deploy automático a AWS

Fecha: 2026-07-07

## Objetivo

1. Publicar el monorepo en `https://github.com/mauriantolin/minutas.git` (repo público, hoy vacío).
2. CI/CD en GitHub Actions que despliega en la cuenta AWS sandbox `471446759294` / `us-east-1`.
3. Compilar la extensión Chrome en CI y dejar el zip descargable desde la página Configuración del dashboard.

## Contexto del repo

Monorepo npm workspaces: `packages/shared`, `backend`, `infra` (CDK), `extension` (MV3), `web` (Next static export).

Flujo de deploy manual actual (README): `cdk deploy` → build extensión → build web → `aws s3 sync web/out` → invalidar CloudFront.

La descarga de la extensión **ya está resuelta en código**: `extension/build.mjs` empaqueta `dist/` en `web/public/minutas-extension.zip`; el export estático de Next lo sirve desde Configuración. `*.zip` está en `.gitignore`, por lo que el zip se genera en cada build de CI.

Config de API/Cognito hardcodeada en `web/lib/config.ts` y `extension/src/config.ts` (matchea el stack ya desplegado y estable). No se inyecta en build.

## Decisiones

- **Auth CI → AWS**: OIDC (sin claves de larga duración en el repo público).
- **Trigger**: `push` a `main` + `workflow_dispatch` manual.
- **README**: sin cambios (los IDs de Cognito ya son públicos; el account id no es secreto crítico).

## Diseño

### Push inicial
Remote `origin` → repo, push de `main`. `.gitignore` ya excluye artefactos y no hay secretos trackeados.

### OIDC (creado una sola vez, vía CLI)
- OIDC provider `token.actions.githubusercontent.com`, audiencia `sts.amazonaws.com`.
- Rol IAM `minutas-github-deploy`, trust acotada a `repo:mauriantolin/minutas:*`. Permisos de mínimo privilegio:
  - `sts:AssumeRole` sobre `arn:aws:iam::471446759294:role/cdk-hnb659fds-*` (deploy de infra vía roles bootstrap de CDK).
  - `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` sobre el WebBucket + `cloudfront:CreateInvalidation` (+`GetInvalidation`) sobre la distribución.
  - `cloudformation:DescribeStacks` para leer outputs.
- ARN del rol como variable de repo `vars.AWS_DEPLOY_ROLE_ARN`.

### Cambio en infra
Agregar `CfnOutput` `WebDistributionId` al stack `TeamsAgentCore` (hoy solo expone el dominio, no el id para invalidar).

### Workflow `.github/workflows/deploy.yml`
Un job, `us-east-1`, permisos `id-token: write` + `contents: read`.

1. checkout · setup-node 20 · `npm ci`
2. `configure-aws-credentials` (OIDC, asume el rol)
3. `npm run build -w @teams-agent-core/shared`
4. `cdk deploy --require-approval never` (en `infra/`)
5. leer outputs `WebBucketName` y `WebDistributionId` vía `describe-stacks`
6. `npm run build -w @teams-agent-core/extension` (genera el zip en `web/public/`)
7. `npm run build -w @teams-agent-core/web` (export estático, incluye el zip)
8. `aws s3 sync web/out s3://<bucket> --delete`
9. `aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`

**Orden crítico**: extensión antes que web, para que el zip esté fresco al exportar.

## Fuera de alcance

- Inyección de config desde stack outputs (se mantiene hardcodeado como hoy).
- Tests/lint como gate de CI (se puede agregar después).
- Entornos múltiples (solo el sandbox).
