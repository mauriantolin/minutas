import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CognitoUserPool } from "amazon-cognito-identity-js";
import { Info, Play, SquareIcon } from "lucide-react";

import { signIn, currentSession, type AuthTokens } from "./auth.js";
import { CONFIG } from "./config.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Switch } from "./ui/switch";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import { cn } from "./lib/utils";

/** White-label product name — single popup-side definition (spec §0). */
const APP_NAME = "Minutix";

// Persist both tokens so the service worker can capture auto-detected meetings
// without the popup being open — including after a browser restart, when it
// refreshes the idToken from the refresh token on its own (see background.ts).
async function persistAuth(tokens: AuthTokens) {
  await chrome.storage.session.set({ idToken: tokens.idToken });
  await chrome.storage.local.set({
    authIdToken: tokens.idToken,
    authRefreshToken: tokens.refreshToken,
  });
}

function emailFromToken(token: string): string {
  const b64 = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(b64)).email as string | undefined) ?? "";
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function initials(value: string): string {
  const name = value.split("@")[0] ?? value;
  const parts = name.split(/[._\-\s]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface RecentMeeting {
  meetingId: string;
  title: string;
  startedAt: string;
}

type DotState = "off" | "ok" | "live";

function StatusDot({ state }: { state: DotState }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "ok" && "bg-chart-5",
        state === "live" && "animate-pulse bg-destructive",
        state === "off" && "bg-muted-foreground",
      )}
    />
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [accountEmail, setAccountEmail] = useState("");
  const [status, setStatus] = useState("");
  const [autoCapture, setAutoCapture] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [liveMeetingId, setLiveMeetingId] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState("00:00");
  const [captionsMissing, setCaptionsMissing] = useState(false);
  const [recent, setRecent] = useState<RecentMeeting[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const startEpoch = useRef<number>(0);
  const timer = useRef<number | undefined>(undefined);

  const dot: DotState = capturing ? "live" : signedIn ? "ok" : "off";

  function startElapsed(startedAt?: string) {
    stopElapsed();
    startEpoch.current = startedAt ? Date.parse(startedAt) : Date.now();
    const render = () => setElapsed(mmss(Date.now() - startEpoch.current));
    render();
    timer.current = window.setInterval(render, 1000);
  }
  function stopElapsed() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = undefined;
  }

  function applyCapturing(
    on: boolean,
    live?: { meetingId?: string; startedAt?: string },
  ) {
    setCapturing(on);
    if (on) {
      setLiveMeetingId(live?.meetingId);
      startElapsed(live?.startedAt);
    } else {
      setLiveMeetingId(undefined);
      setCaptionsMissing(false);
      stopElapsed();
    }
  }

  async function loadRecent(token: string) {
    const res = await fetch(`${CONFIG.apiUrl}/meetings`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!res?.ok) return;
    const { meetings } = (await res.json()) as { meetings: RecentMeeting[] };
    setRecent(
      [...meetings]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 3),
    );
  }

  async function enterCaptureView(token: string) {
    setSignedIn(true);
    setAccountEmail(emailFromToken(token));

    const { autoCapture: pref } = await chrome.storage.local.get("autoCapture");
    setAutoCapture(pref !== false); // default ON: absent means enabled

    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    applyCapturing(!!state?.capturing, state);
    if (state?.capturing)
      setStatus("Transcribiendo… mantené abierta la pestaña de la reunión.");
    void loadRecent(token);
  }

  useEffect(() => {
    void (async () => {
      const tokens = await currentSession();
      if (tokens) {
        await persistAuth(tokens);
        await enterCaptureView(tokens.idToken);
      }
    })();
    return () => stopElapsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onToggleAuto(next: boolean) {
    setAutoCapture(next);
    await chrome.storage.local.set({ autoCapture: next });
  }

  async function onSignIn() {
    setBusy(true);
    setStatus("Iniciando sesión…");
    try {
      const tokens = await signIn(email, password);
      await persistAuth(tokens);
      setStatus("");
      setPassword("");
      await enterCaptureView(tokens.idToken);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (state?.capturing) {
      setStatus("Detené la captura antes de salir.");
      return;
    }
    new CognitoUserPool({
      UserPoolId: CONFIG.userPoolId,
      ClientId: CONFIG.userPoolClientId,
    })
      .getCurrentUser()
      ?.signOut();
    await chrome.storage.session.remove("idToken");
    await chrome.storage.local.remove(["authIdToken", "authRefreshToken"]);
    setSignedIn(false);
    setRecent([]);
    setStatus("");
  }

  async function onStart() {
    setStatus("Iniciando captura…");
    const res = await chrome.runtime.sendMessage({ type: "POPUP_START" });
    if (res?.error) {
      setStatus(`Error: ${res.error}`);
      return;
    }
    applyCapturing(true, res);
    setCaptionsMissing(!res.captionsDetected);
    setStatus("Transcribiendo… mantené abierta la pestaña de la reunión.");
  }

  async function onStop() {
    setStatus("Procesando…");
    const res = await chrome.runtime.sendMessage({ type: "POPUP_STOP" });
    applyCapturing(false);
    setStatus(
      res?.error ? `Error: ${res.error}` : `Listo. Reunión ${res?.meetingId ?? ""} guardada.`,
    );
  }

  async function onCancel() {
    await chrome.runtime.sendMessage({ type: "POPUP_CANCEL" });
    applyCapturing(false);
    setStatus("Captura descartada.");
  }

  function onViewLive() {
    const url = liveMeetingId
      ? `${CONFIG.dashboardUrl}/live?id=${encodeURIComponent(liveMeetingId)}`
      : `${CONFIG.dashboardUrl}/meetings`;
    void chrome.tabs.create({ url });
  }

  function openMeeting(id: string) {
    void chrome.tabs.create({
      url: `${CONFIG.dashboardUrl}/meeting?id=${encodeURIComponent(id)}`,
    });
  }

  return (
    <div className="flex w-80 flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <img src="minutix-logo.png" alt={APP_NAME} className="h-7 w-auto max-w-[136px]" />
        <span className="flex-1" />
        <StatusDot state={dot} />
      </header>

      {!signedIn ? (
        <div className="flex flex-col gap-2">
          <Input
            type="email"
            placeholder="Email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Contraseña"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSignIn()}
          />
          <Button className="w-full" disabled={busy} onClick={onSignIn}>
            Entrar
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Avatar size="sm">
              <AvatarFallback>{initials(accountEmail)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-[13px]">{accountEmail}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onSignOut}
            >
              Salir
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Captura</CardTitle>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Cómo funciona"
                  >
                    <Info className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Transcribe desde los subtítulos en vivo de Teams. No graba audio.
                </TooltipContent>
              </Tooltip>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              {!capturing ? (
                <>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Automática</span>
                    <Switch checked={autoCapture} onCheckedChange={onToggleAuto} />
                  </label>
                  <Button className="w-full" onClick={onStart}>
                    <Play className="fill-current" /> Transcribir
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    <StatusDot state="live" />
                    <span>En vivo · {elapsed}</span>
                    <button
                      className="ml-auto text-xs text-accent-foreground hover:underline"
                      onClick={onViewLive}
                    >
                      Ver en vivo
                    </button>
                  </div>
                  {captionsMissing && (
                    <p className="rounded-md bg-chart-4/20 px-2 py-1.5 text-xs">
                      Activá los subtítulos en vivo de Teams para mejorar la precisión.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button variant="destructive" className="flex-1" onClick={onStop}>
                      <SquareIcon className="fill-current" /> Detener
                    </Button>
                    <Button variant="outline" onClick={onCancel}>
                      Descartar
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {recent.length > 0 && (
            <section className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">
                Últimas reuniones
              </div>
              {recent.map((m) => (
                <button
                  key={m.meetingId}
                  className="group flex items-center gap-2 rounded-md py-1.5 text-left hover:bg-accent"
                  onClick={() => openMeeting(m.meetingId)}
                  title="Abrir en el panel"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium group-hover:text-accent-foreground">
                    {m.title}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {new Date(m.startedAt).toLocaleString("es", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
              ))}
            </section>
          )}
        </>
      )}

      {status && <div className="text-xs text-muted-foreground">{status}</div>}

      <footer className="flex">
        <a
          href={CONFIG.dashboardUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs font-medium text-primary hover:underline"
        >
          Abrir panel →
        </a>
      </footer>
    </div>
  );
}

function boot() {
  document.documentElement.classList.toggle(
    "dark",
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
