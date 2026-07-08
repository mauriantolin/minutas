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
2. Activar captura automatica al entrar a una reunion o iniciar captura manualmente.
3. Abrir o mantener una llamada de Teams Desktop con live captions.
4. Abrir el live dashboard desde la app.
5. Detener y finalizar para enviar la minuta.

La app guarda una copia local en:

```text
%LOCALAPPDATA%\Minutix\Desktop\captures
```

## Captura automatica de reuniones

La opcion **Captura automatica al entrar a una reunion** queda activada por defecto y se
guarda por usuario en:

```text
%LOCALAPPDATA%\Minutix\Desktop\preferences.json
```

Cuando esta activa, Minutix detecta ventanas de llamada de Teams Desktop y empieza a
capturar subtitulos automaticamente. Si el usuario detiene o descarta una captura en la
misma llamada, no vuelve a arrancar sola hasta que deje de ver esa reunion o cambie el
titulo detectado.

## Inicio con Windows

La app permite activar **Iniciar Minutix con Windows** desde la ventana principal. La
configuración es por usuario y usa:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

Cuando Windows la inicia automáticamente, Minutix arranca con `--minimized` y queda en la
bandeja hasta que el usuario la abra.

## Backend

Usa el mismo API que la extension:

- `POST /meetings`
- `POST /meetings/{id}/segments`
- `POST /meetings/{id}/finalize`

El modo se identifica como `signalHealth.asrMode = "teams-desktop-uia"`.

## Nota de auth

El MVP usa Cognito `USER_PASSWORD_AUTH` via REST para evitar dependencias NuGet externas. Si el App Client de Cognito no tiene habilitado ese flujo, hay que habilitarlo o reemplazar el login por SRP usando el SDK de AWS.
