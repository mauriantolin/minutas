import type { SignalHealth } from "@teams-agent-core/shared";

// In-meeting caption widget (ui-spec §4.2). Mounted in a CLOSED ShadowRoot so
// Teams CSS can't bleed in and none of ours leaks out; styles attach via a
// constructable stylesheet (never a <style>/<link> in the page document) and
// the §1.2 tokens are declared on :host — never :root.

export type TagId = "decision" | "action" | "question" | "highlight";

export interface WidgetOptions {
  startEpoch: number;
  onTag: (tag: TagId) => void;
}

export interface LiveWidget {
  /** Mirror one Teams caption line, keyed by id, refined in place. */
  upsertCaption(id: number, label: string, text: string): void;
  /** Persistent banner above the lines (e.g. "turn on captions"); null hides it. */
  setNotice(text: string | null): void;
  updateHealth(health: SignalHealth): void;
  destroy(): void;
}

const MAX_VISIBLE_LINES = 3;
const POS_KEY = "tac-widget-pos";

const TAGS: ReadonlyArray<{ id: TagId; emoji: string; label: string }> = [
  { id: "decision", emoji: "📌", label: "Decisión" },
  { id: "action", emoji: "✅", label: "Acción" },
  { id: "question", emoji: "❓", label: "Pregunta" },
  { id: "highlight", emoji: "⭐", label: "Destacado" },
];

const CHART_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

const CSS = `
:host {
  all: initial;
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.82);
  --muted-foreground: oklch(0.552 0.016 285.94);
  --accent: oklch(0.962 0.018 272.31);
  --destructive: oklch(0.577 0.245 27.33);
  --border: oklch(0.92 0.004 286.32);
  --ring: oklch(0.545 0.245 277);
  --chart-1: oklch(0.545 0.245 277);
  --chart-2: oklch(0.715 0.143 215.22);
  --chart-3: oklch(0.606 0.25 292.72);
  --chart-4: oklch(0.769 0.188 70.08);
  --chart-5: oklch(0.696 0.17 162.48);
}
@media (prefers-color-scheme: dark) {
  :host {
    --background: oklch(0.21 0.006 285.89);
    --foreground: oklch(0.985 0 0);
    --muted-foreground: oklch(0.705 0.015 286.07);
    --accent: oklch(0.257 0.09 281.29);
    --destructive: oklch(0.637 0.237 25.33);
    --border: oklch(0.274 0.006 286.03);
    --ring: oklch(0.585 0.233 277.12);
    --chart-1: oklch(0.673 0.182 276.94);
    --chart-2: oklch(0.789 0.154 211.53);
    --chart-3: oklch(0.702 0.183 293.54);
    --chart-4: oklch(0.828 0.189 84.43);
    --chart-5: oklch(0.765 0.177 163.22);
  }
}
* { box-sizing: border-box; }
.panel {
  width: 340px;
  height: 60vh;
  max-height: 520px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 1.4);
  background: color-mix(in oklab, var(--background) 95%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  overflow: hidden;
  color: var(--foreground);
  font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
}
.header {
  height: 40px;
  flex: none;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
}
.title { font-size: 12px; font-weight: 500; }
.elapsed {
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
}
.spacer { flex: 1; }
.dot { width: 8px; height: 8px; border-radius: 9999px; flex: none; }
.rec { background: var(--destructive); animation: pulse 1.2s ease-in-out infinite; }
.rec.off { background: var(--muted-foreground); animation: none; }
@keyframes pulse { 50% { opacity: 0.3; } }
.health { width: 8px; height: 8px; border-radius: 9999px; flex: none; background: var(--muted-foreground); }
.h-green { background: var(--chart-5); }
.h-amber { background: var(--chart-4); }
.h-indigo { background: var(--chart-1); }
.iconbtn, .tagbtn {
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  border-radius: calc(var(--radius) * 0.8);
  cursor: pointer;
  display: grid;
  place-items: center;
  font: inherit;
}
.iconbtn { width: 26px; height: 26px; font-size: 13px; flex: none; }
.tagbtn { width: 32px; height: 32px; font-size: 16px; flex: none; }
.iconbtn:hover, .tagbtn:hover { background: var(--accent); color: var(--foreground); }
.lines {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
}
.notice {
  flex: none;
  margin: 8px 12px 0;
  padding: 6px 8px;
  border-radius: calc(var(--radius) * 0.6);
  font-size: 12px;
  color: var(--foreground);
  background: color-mix(in oklab, var(--chart-4) 22%, transparent);
}
.line { font-size: 14px; line-height: 20px; border-radius: 6px; }
.line .name { display: block; font-size: 12px; font-weight: 600; }
.line.interim { color: var(--muted-foreground); font-style: italic; }
.line.flash { outline: 1px solid var(--ring); outline-offset: 3px; }
.footer {
  height: 44px;
  flex: none;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  border-top: 1px solid var(--border);
}
.fab {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  border: 1px solid var(--border);
  background: color-mix(in oklab, var(--background) 95%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.hidden { display: none !important; }
`;

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// Keep at least a grabbable corner inside the viewport, so a position saved on
// a larger screen can't strand the widget off-screen on a smaller one.
const clampPos = (x: number, y: number): { x: number; y: number } => ({
  x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 60)),
  y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 40)),
});

export function mountWidget(opts: WidgetOptions): LiveWidget {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:80px;right:16px;z-index:2147483647";
  const applyPos = (x: number, y: number) => {
    const p = clampPos(x, y);
    host.style.left = `${p.x}px`;
    host.style.top = `${p.y}px`;
    host.style.right = "auto";
  };
  let restored = false;
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) ?? "null") as {
      x: number;
      y: number;
    } | null;
    if (pos) {
      applyPos(pos.x, pos.y);
      restored = true;
    }
  } catch {}

  const onResize = () => {
    if (!restored && host.style.right !== "auto") return;
    const r = host.getBoundingClientRect();
    applyPos(r.left, r.top);
  };
  window.addEventListener("resize", onResize);

  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
    <div class="panel" id="panel">
      <div class="header" id="header">
        <span class="dot rec" id="recdot"></span>
        <span class="title" id="state">Transcribiendo</span>
        <span class="elapsed" id="elapsed">00:00</span>
        <span class="spacer"></span>
        <span class="health" id="health" title="Sin señal de la reunión"></span>
        <button class="iconbtn" id="pause" title="Pausar">⏸</button>
        <button class="iconbtn" id="minimize" title="Minimizar">—</button>
      </div>
      <div class="notice hidden" id="notice"></div>
      <div class="lines" id="lines"></div>
      <div class="footer">
        ${TAGS.map(
          (t) => `<button class="tagbtn" data-tag="${t.id}" title="${t.label}">${t.emoji}</button>`,
        ).join("")}
        <span class="spacer"></span>
        <button class="iconbtn" id="copy" title="Copiar transcripción">⧉</button>
        <button class="iconbtn" id="quiet" title="Pausar notificaciones">🔔</button>
      </div>
    </div>
    <button class="fab hidden" id="fab" title="Mostrar transcripción">
      <span class="dot rec"></span>
    </button>`;
  document.body.appendChild(host);

  const el = (id: string) => root.getElementById(id)!;
  const panel = el("panel");
  const linesEl = el("lines");
  const recdot = el("recdot");
  const stateEl = el("state");
  const pauseBtn = el("pause") as HTMLButtonElement;
  const quietBtn = el("quiet") as HTMLButtonElement;

  // A live mirror of the Teams caption pane, keyed by utterance id (insertion
  // order = Teams order), each line refined in place.
  const captionLines = new Map<number, { label: string; text: string; color: string }>();
  let paused = false;
  let quiet = false;
  const speakerColor = new Map<string, string>();

  const colorFor = (label: string): string => {
    let color = speakerColor.get(label);
    if (!color) {
      color = `var(${CHART_VARS[speakerColor.size % CHART_VARS.length]})`;
      speakerColor.set(label, color);
    }
    return color;
  };

  function lineDiv(label: string, text: string, color?: string): HTMLDivElement {
    const div = document.createElement("div");
    div.className = "line" + (color ? "" : " interim");
    const name = document.createElement("span");
    name.className = "name";
    if (color) name.style.color = color;
    name.textContent = label;
    div.appendChild(name);
    div.appendChild(document.createTextNode(text));
    return div;
  }

  function render() {
    if (paused) return;
    linesEl.textContent = "";
    for (const line of [...captionLines.values()].slice(-MAX_VISIBLE_LINES)) {
      linesEl.appendChild(lineDiv(line.label, line.text, line.color));
    }
    linesEl.scrollTop = linesEl.scrollHeight;
  }

  const timer = window.setInterval(() => {
    el("elapsed").textContent = mmss(Date.now() - opts.startEpoch);
  }, 1000);

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    recdot.classList.toggle("off", paused);
    stateEl.textContent = paused ? "En pausa" : "Transcribiendo";
    pauseBtn.textContent = paused ? "▶" : "⏸";
    pauseBtn.title = paused ? "Reanudar" : "Pausar";
    if (!paused) render();
  });

  el("minimize").addEventListener("click", () => {
    panel.classList.add("hidden");
    el("fab").classList.remove("hidden");
  });
  el("fab").addEventListener("click", () => {
    el("fab").classList.add("hidden");
    panel.classList.remove("hidden");
  });

  el("copy").addEventListener("click", () => {
    void navigator.clipboard.writeText(
      [...captionLines.values()].map((l) => `${l.label}: ${l.text}`).join("\n"),
    );
  });

  const applyQuiet = () => {
    quietBtn.textContent = quiet ? "🔕" : "🔔";
    quietBtn.title = quiet ? "Reactivar notificaciones" : "Pausar notificaciones";
  };
  void chrome.storage.local.get("quietModePref").then(({ quietModePref }) => {
    quiet = !!quietModePref;
    applyQuiet();
  });
  quietBtn.addEventListener("click", () => {
    quiet = !quiet;
    applyQuiet();
    void chrome.storage.local.set({ quietModePref: quiet });
  });

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".tagbtn")) {
    btn.addEventListener("click", () => {
      if (captionLines.size === 0) return;
      opts.onTag(btn.dataset.tag as TagId);
      const targets = linesEl.querySelectorAll<HTMLElement>(".line:not(.interim)");
      const target = targets[targets.length - 1];
      if (target) {
        target.classList.add("flash");
        window.setTimeout(() => target.classList.remove("flash"), 700);
      }
    });
  }

  // Drag by header; position persists across meetings.
  const header = el("header");
  header.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = host.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    host.style.right = "auto";
    const move = (ev: PointerEvent) => {
      applyPos(ev.clientX - dx, ev.clientY - dy);
      restored = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const r = host.getBoundingClientRect();
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(clampPos(r.left, r.top)));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  return {
    upsertCaption(id, label, text) {
      const prev = captionLines.get(id);
      captionLines.set(id, { label, text, color: prev?.color ?? colorFor(label) });
      // Bound memory; the render slice already caps what's visible.
      while (captionLines.size > MAX_VISIBLE_LINES * 4) {
        captionLines.delete(captionLines.keys().next().value!);
      }
      render();
    },
    setNotice(text) {
      const noticeEl = el("notice");
      noticeEl.textContent = text ?? "";
      noticeEl.classList.toggle("hidden", !text);
    },
    updateHealth(health) {
      const healthEl = el("health");
      const cls = health.captionsSeen ? "h-green" : "h-amber";
      healthEl.className = `health ${cls}`;
      healthEl.title = health.captionsSeen ? "Subtítulos de Teams" : "Esperando subtítulos";
    },
    destroy() {
      window.clearInterval(timer);
      window.removeEventListener("resize", onResize);
      host.remove();
    },
  };
}
