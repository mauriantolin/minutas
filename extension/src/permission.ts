// Opened as a normal extension tab (NOT the popup) to request microphone access.
// A popup can't reliably show the permission prompt: the prompt steals focus, the popup
// closes, and the getUserMedia call is aborted. A regular tab stays open, so the prompt
// persists and the grant is remembered for the extension origin — which the offscreen
// document then inherits.

const status = document.getElementById("status")!;
const retry = document.getElementById("retry") as HTMLButtonElement;

async function request() {
  status.textContent = "Solicitando acceso…";
  status.className = "";
  retry.style.display = "none";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = "✓ Micrófono habilitado. Ya podés cerrar esta pestaña y grabar.";
    status.className = "ok";
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    status.textContent =
      "✗ No se pudo acceder al micrófono. Si lo bloqueaste, habilitálo desde el " +
      "candado de la barra de direcciones y reintentá. (" +
      (e instanceof Error ? e.name : String(e)) +
      ")";
    status.className = "err";
    retry.style.display = "inline-block";
  }
}

retry.addEventListener("click", request);
void request();
