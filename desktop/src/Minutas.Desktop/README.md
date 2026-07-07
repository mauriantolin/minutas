# Minutix Desktop

Capturador Windows para Teams Desktop. Convive con la extension existente: la extension sigue capturando Teams Web y esta app captura Teams Desktop via UI Automation.

## Requisitos

- Windows 10/11
- .NET 10 SDK x64
- Teams Desktop con subtitulos en vivo activados

Instalar SDK:

```powershell
winget install Microsoft.DotNet.SDK.10
```

## Ejecutar

```powershell
dotnet run --project .\src\Minutas.Desktop\Minutas.Desktop.csproj
```

## Flujo

1. Login con la misma cuenta Cognito que usa la extension.
2. Iniciar captura.
3. Abrir o mantener una llamada de Teams Desktop con live captions.
4. Abrir el live dashboard desde la app.
5. Detener y finalizar para enviar la minuta.

La app guarda una copia local en:

```text
%LOCALAPPDATA%\Minutix\Desktop\captures
```

## Backend

Usa el mismo API que la extension:

- `POST /meetings`
- `POST /meetings/{id}/segments`
- `POST /meetings/{id}/finalize`

El modo se identifica como `signalHealth.asrMode = "teams-desktop-uia"`.

## Nota de auth

El MVP usa Cognito `USER_PASSWORD_AUTH` via REST para evitar dependencias NuGet externas. Si el App Client de Cognito no tiene habilitado ese flujo, hay que habilitarlo o reemplazar el login por SRP usando el SDK de AWS.
