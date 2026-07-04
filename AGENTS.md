# teams-agent-core

{{Descripción corta del proyecto — qué es y qué resuelve.}}

## Stack

{{Stack aún sin detectar — el repo está vacío. Completar cuando se agregue el manifest
(package.json / pyproject.toml / etc.). Ej: TypeScript / Node.js, Python, AWS CDK.}}

## Comandos

| Acción | Comando |
|--------|---------|
| Instalar deps | `{{...}}` |
| Dev | `{{...}}` |
| Build | `{{...}}` |
| Test | `{{...}}` |
| Lint | `{{...}}` |

## Estructura

{{Describir la estructura de carpetas principal cuando exista.}}

## Convenciones

- Código, identificadores y mensajes de commit en **inglés**; respuestas en español.
- No comentarios que expliquen *qué* hace el código — solo *por qué* si no es obvio.
- Sin manejo de errores defensivo en código interno; validar solo en bordes (input de usuario, APIs externas).

## MCPs activos en este proyecto

Configurados en `.mcp.json` (project scope):

| MCP | Nombre | Auth |
|-----|--------|------|
| GitHub | `github-teams-agent-core` | PAT vía header (`GITHUB_PAT_MAURIANTOLIN`), ya seteado en env |
| AWS Knowledge | `aws-knowledge` | Sin auth |
| Context7 | `context7` | Sin auth |

> GitHub usa un PAT por variable de entorno — no requiere `/mcp`. AWS Knowledge y Context7 no
> tienen auth. Ningún server de este repo necesita login OAuth por ahora.

## Plugins habilitados

En `.claude/settings.json`:

- **Superpowers** — metodología (TDD, brainstorm, plans, debug).
- **Everything Claude Code** — 48 agentes especializados + skills.
- **Context7** — docs actualizadas de frameworks.
