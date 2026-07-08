import { CognitoUserPool } from "amazon-cognito-identity-js";
import { signIn, currentSession, type AuthTokens } from "./auth.js";

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
import { CONFIG } from "./config.js";

/** White-label product name — single popup-side definition (spec §0). */
const APP_NAME = "Minutix";

const $ = (id: string) => document.getElementById(id)!;
const status = (t: string) => ($("status").textContent = t);
const show = (id: string, on: boolean) => $(id).classList.toggle("hidden", !on);

let signedIn = false;
let liveMeetingId: string | undefined;
let elapsedTimer: number | undefined;

// Header status dot (§4.1): gray = sin sesión, green = conectado, red = capturando.
function setDot(state: "off" | "ok" | "live") {
  $("dot").className =
    "dot" + (state === "ok" ? " ok" : state === "live" ? " live pulse" : "");
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// "Transcribiendo · mm:ss" (§4.1) — anchored to the capture start timestamp.
function startElapsed(startedAt: string | undefined) {
  stopElapsed();
  const startEpoch = startedAt ? Date.parse(startedAt) : Date.now();
  const render = () => ($("elapsed").textContent = mmss(Date.now() - startEpoch));
  render();
  elapsedTimer = window.setInterval(render, 1000);
}

function stopElapsed() {
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}

function setCapturing(
  capturing: boolean,
  live?: { meetingId?: string; startedAt?: string },
) {
  show("start", !capturing);
  show("stop", capturing);
  show("cancel", capturing);
  show("live-row", capturing);
  show("mode-row", capturing);
  if (capturing) {
    liveMeetingId = live?.meetingId;
    $("mode-label").textContent = "Subtítulos de Teams";
    startElapsed(live?.startedAt);
  } else {
    liveMeetingId = undefined;
    stopElapsed();
    document.getElementById("captions-hint")?.remove();
  }
  setDot(capturing ? "live" : signedIn ? "ok" : "off");
}

function emailFromToken(token: string): string {
  const b64 = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(b64)).email as string | undefined) ?? "";
}

// Non-blocking: capture runs fine without captions, but caption coverage is the
// cheapest speaker-fidelity signal, so nudge the user to turn them on.
function captionsHint(captionsDetected: boolean) {
  document.getElementById("captions-hint")?.remove();
  if (captionsDetected) return;
  const hint = document.createElement("div");
  hint.id = "captions-hint";
  hint.className = "hint";
  hint.textContent =
    "Activá los subtítulos en vivo de Teams para mejorar la precisión de hablantes";
  $("capture").appendChild(hint);
}

async function loadRecentMeetings(token: string) {
  const res = await fetch(`${CONFIG.apiUrl}/meetings`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return;
  const { meetings } = (await res.json()) as {
    meetings: { meetingId: string; title: string; startedAt: string }[];
  };
  const recent = meetings
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 3);
  if (recent.length === 0) return;
  const list = $("recent-list");
  list.textContent = "";
  for (const m of recent) {
    const row = document.createElement("div");
    row.className = "meeting clickable";
    row.title = "Abrir en el panel";
    row.addEventListener("click", () =>
      chrome.tabs.create({
        url: `${CONFIG.dashboardUrl}/meeting?id=${encodeURIComponent(m.meetingId)}`,
      }),
    );
    const title = document.createElement("div");
    title.className = "meeting-title";
    title.textContent = m.title;
    const date = document.createElement("div");
    date.className = "meeting-date";
    date.textContent = new Date(m.startedAt).toLocaleString("es", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    row.append(title, date);
    list.appendChild(row);
  }
  show("recent", true);
}

async function enterCaptureView(token: string) {
  signedIn = true;
  show("login", false);
  show("account", true);
  show("capture", true);
  const email = emailFromToken(token);
  $("user-email").textContent = email;
  $("avatar").textContent = email.slice(0, 2).toUpperCase();

  const { autoCapture } = await chrome.storage.local.get("autoCapture");
  // Default ON: absent means enabled.
  ($("autostart") as HTMLInputElement).checked = autoCapture !== false;

  // Reflect whatever the background is actually doing — survives popup close / SW restart.
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  setCapturing(!!state?.capturing, state);
  if (state?.capturing) status("Transcribiendo… mantené abierta la pestaña de la reunión.");
  void loadRecentMeetings(token);
}

async function init() {
  $("wordmark").textContent = APP_NAME;
  document.title = APP_NAME;
  ($("open-dashboard") as HTMLAnchorElement).href = CONFIG.dashboardUrl;
  setDot("off");
  const tokens = await currentSession();
  if (tokens) {
    await persistAuth(tokens);
    await enterCaptureView(tokens.idToken);
  }
}

// Read by the service worker on MEETING_DETECTED: ON = every detected meeting is
// captured automatically from the Teams live captions.
$("autostart").addEventListener("change", (e) =>
  void chrome.storage.local.set({ autoCapture: (e.target as HTMLInputElement).checked }),
);

$("signin").addEventListener("click", async () => {
  status("Iniciando sesión…");
  try {
    const email = ($("email") as HTMLInputElement).value;
    const password = ($("password") as HTMLInputElement).value;
    const tokens = await signIn(email, password);
    await persistAuth(tokens);
    status("");
    await enterCaptureView(tokens.idToken);
  } catch (e) {
    status(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

$("signout").addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (state?.capturing) return status("Detené la captura antes de salir.");
  new CognitoUserPool({ UserPoolId: CONFIG.userPoolId, ClientId: CONFIG.userPoolClientId })
    .getCurrentUser()
    ?.signOut();
  await chrome.storage.session.remove("idToken");
  await chrome.storage.local.remove(["authIdToken", "authRefreshToken"]);
  signedIn = false;
  show("account", false);
  show("capture", false);
  show("recent", false);
  show("login", true);
  setDot("off");
  status("");
});

$("start").addEventListener("click", async () => {
  status("Iniciando captura…");
  const res = await chrome.runtime.sendMessage({ type: "POPUP_START" });
  if (res?.error) return status(`Error: ${res.error}`);
  setCapturing(true, res);
  captionsHint(!!res.captionsDetected);
  status("Transcribiendo… mantené abierta la pestaña de la reunión.");
});

$("stop").addEventListener("click", async () => {
  status("Procesando…");
  const res = await chrome.runtime.sendMessage({ type: "POPUP_STOP" });
  setCapturing(false);
  if (res?.error) return status(`Error: ${res.error}`);
  status(`Listo. Reunión ${res.meetingId ?? ""} guardada.`);
});

$("cancel").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "POPUP_CANCEL" });
  setCapturing(false);
  status("Captura descartada.");
});

// Live transcript entry point (§4.1); without a meetingId (offline start) the
// live view can't be addressed, so fall back to the meetings list.
$("view-live").addEventListener("click", () => {
  const url = liveMeetingId
    ? `${CONFIG.dashboardUrl}/live?id=${encodeURIComponent(liveMeetingId)}`
    : `${CONFIG.dashboardUrl}/meetings`;
  void chrome.tabs.create({ url });
});

void init();
