import { signIn, currentIdToken } from "./auth.js";

const $ = (id: string) => document.getElementById(id)!;
const status = (t: string) => ($("status").textContent = t);
const show = (id: string, on: boolean) => $(id).classList.toggle("hidden", !on);

function setCapturing(capturing: boolean) {
  show("start", !capturing);
  show("stop", capturing);
  show("cancel", capturing);
  if (!capturing) document.getElementById("captions-hint")?.remove();
}

// Non-blocking: capture runs fine without captions, but caption coverage is the
// cheapest speaker-fidelity signal, so nudge the user to turn them on.
function captionsHint(captionsDetected: boolean) {
  document.getElementById("captions-hint")?.remove();
  if (captionsDetected) return;
  const hint = document.createElement("div");
  hint.id = "captions-hint";
  hint.style.cssText = "margin-top:6px;padding:6px 8px;border-radius:6px;background:#fff4d6;color:#6b5200";
  hint.textContent = "Activá los subtítulos en vivo de Teams para mejorar la precisión de hablantes";
  $("capture").appendChild(hint);
}

async function enterCaptureView() {
  $("login").classList.add("hidden");
  $("capture").classList.remove("hidden");
  // Reflect whatever the background is actually doing — survives popup close / SW restart.
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  setCapturing(!!state?.capturing);
  if (state?.capturing) status("Capturing in progress…");
}

async function init() {
  const token = await currentIdToken();
  if (token) {
    await chrome.storage.session.set({ idToken: token });
    await enterCaptureView();
  }
}

$("signin").addEventListener("click", async () => {
  status("Signing in…");
  try {
    const email = ($("email") as HTMLInputElement).value;
    const password = ($("password") as HTMLInputElement).value;
    const idToken = await signIn(email, password);
    await chrome.storage.session.set({ idToken });
    status("");
    await enterCaptureView();
  } catch (e) {
    status(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// The mic permission can't be requested from the popup — the prompt steals focus, the
// popup closes, and the request aborts. So we check the current permission state and, if
// it isn't granted yet, open a dedicated extension tab that shows the prompt reliably.
// Once granted for the extension origin, the offscreen document inherits it.
async function micGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return p.state === "granted";
  } catch {
    return false;
  }
}

$("start").addEventListener("click", async () => {
  if (!(await micGranted())) {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    status("Habilitá el micrófono en la pestaña que se abrió y volvé a tocar Start.");
    return;
  }
  status("Starting capture…");
  const res = await chrome.runtime.sendMessage({ type: "POPUP_START" });
  if (res?.error) return status(`Error: ${res.error}`);
  setCapturing(true);
  captionsHint(!!res.captionsDetected);
  status("Capturing… keep the meeting tab open.");
});

$("stop").addEventListener("click", async () => {
  status("Processing…");
  const res = await chrome.runtime.sendMessage({ type: "POPUP_STOP" });
  setCapturing(false);
  status(res?.error ? `Error: ${res.error}` : `Done. Meeting ${res.meetingId ?? ""} saved.`);
});

$("cancel").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "POPUP_CANCEL" });
  setCapturing(false);
  status("Capture discarded.");
});

void init();
