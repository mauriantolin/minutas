"use client";

import { useEffect, useState } from "react";
import { signIn, currentToken, signOut } from "../lib/auth";
import {
  listMeetings,
  getMeeting,
  askMeeting,
  deleteMeeting,
  reprocessMeeting,
  type Meeting,
  type MeetingDetail,
  type PipelinePhase,
  type PipelineState,
} from "../lib/api";

export default function Page() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    currentToken().then((t) => {
      setToken(t);
      setReady(true);
    });
  }, []);

  if (!ready) return <Center>Cargando…</Center>;
  if (!token) return <Login onLogin={setToken} />;
  return <Dashboard token={token} onSignOut={() => { signOut(); setToken(null); }} />;
}

function Login({ onLogin }: { onLogin: (t: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  return (
    <Center>
      <div style={card}>
        <h1 style={{ fontSize: 18 }}>Meeting Assistant</h1>
        <input style={input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={input} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button style={btn} onClick={async () => {
          try { onLogin(await signIn(email, password)); }
          catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
        }}>Iniciar sesión</button>
        {err && <p style={{ color: "#c74343" }}>{err}</p>}
      </div>
    </Center>
  );
}

const PHASES: PipelinePhase[] = [
  "INGESTED", "CORRELATED", "ASR_SCORED", "CLEANED", "EXTRACTED", "DRAFTED", "VERIFIED", "PUBLISHED",
];

const BADGES: Record<string, { label: string; bg: string; fg: string }> = {
  capturing: { label: "En vivo", bg: "#fdecec", fg: "#c74343" },
  processing: { label: "Procesando", bg: "#eef0fb", fg: "#5b5fc7" },
  ready: { label: "Lista", bg: "#e7f6ec", fg: "#1e7a3c" },
  needs_review: { label: "Revisar", bg: "#fbf0dc", fg: "#a06a1c" },
};
const ERROR_BADGE = { label: "Error", bg: "#fdecec", fg: "#c74343" };

function StatusBadge({ status, pipeline }: { status: string; pipeline?: PipelineState }) {
  const b = BADGES[status] ?? ERROR_BADGE;
  const phaseIdx = pipeline ? PHASES.indexOf(pipeline.phase) : -1;
  return (
    <span style={{ ...badge, background: b.bg, color: b.fg }}>
      {status === "capturing" && (
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: b.fg, animation: "pulse 1.2s ease-in-out infinite" }} />
      )}
      {b.label}
      {status === "processing" && phaseIdx >= 0 && ` · ${phaseIdx + 1}/${PHASES.length}`}
    </span>
  );
}

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);

  useEffect(() => {
    listMeetings(token).then((r) => setMeetings(r.meetings)).catch(() => {});
  }, [token]);

  function patchMeeting(d: Meeting) {
    setMeetings((prev) =>
      prev.map((m) => (m.meetingId === d.meetingId ? { ...m, status: d.status, pipeline: d.pipeline } : m)),
    );
  }

  async function remove(id: string) {
    if (!confirm("¿Borrar esta reunión y su transcripción? No se puede deshacer.")) return;
    setMeetings((prev) => prev.filter((m) => m.meetingId !== id));
    if (selected === id) setSelected(null);
    await deleteMeeting(token, id).catch(() => {});
  }

  const visible = reviewOnly ? meetings.filter((m) => m.status === "needs_review") : meetings;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }`}</style>
      <aside style={{ width: 300, background: "#fff", borderRight: "1px solid #e4e4ee", overflow: "auto" }}>
        <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Reuniones</strong>
          <button style={{ ...btn, width: "auto", padding: "4px 8px" }} onClick={onSignOut}>Salir</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 16px 12px", fontSize: 12, color: "#666", cursor: "pointer" }}>
          <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />
          Solo para revisar
        </label>
        {visible.length === 0 && <p style={{ padding: 16, color: "#888" }}>{reviewOnly ? "Nada para revisar." : "Sin reuniones aún."}</p>}
        {visible.map((m) => (
          <div key={m.meetingId} onClick={() => setSelected(m.meetingId)}
            style={{ padding: "12px 16px", cursor: "pointer", background: selected === m.meetingId ? "#eef0fb" : "transparent", borderBottom: "1px solid #f0f0f5", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
              <div style={{ fontSize: 12, color: "#888", display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                <StatusBadge status={m.status} pipeline={m.pipeline} />
                {new Date(m.startedAt).toLocaleString()}
              </div>
            </div>
            <button title="Borrar" onClick={(e) => { e.stopPropagation(); void remove(m.meetingId); }}
              style={{ border: 0, background: "transparent", color: "#c74343", cursor: "pointer", fontSize: 16, padding: 4, flexShrink: 0 }}>×</button>
          </div>
        ))}
      </aside>
      <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {selected
          ? <Detail token={token} id={selected} onMeeting={patchMeeting} />
          : <p style={{ color: "#888" }}>Elegí una reunión.</p>}
      </main>
    </div>
  );
}

// Doc §5 M2: 60 s while capturing; 20 s while processing.
const POLL_MS: Record<string, number> = { capturing: 60_000, processing: 20_000 };

function Detail({ token, id, onMeeting }: { token: string; id: string; onMeeting: (m: Meeting) => void }) {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => { setM(null); setAnswer(""); }, [id]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const d = await getMeeting(token, id).catch(() => null);
      if (cancelled || !d) return;
      setM(d);
      onMeeting(d);
      const ms = POLL_MS[d.status];
      if (ms) timer = setTimeout(load, ms);
    }
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, id, reloadKey]);

  if (!m) return <p>Cargando…</p>;

  const live = m.status === "capturing" || m.status === "processing";
  const retryable = m.status === "needs_review" || m.status === "failed";

  const talkTime = new Map<string, number>();
  for (const s of m.segments) {
    if (s.endTime !== undefined) talkTime.set(s.speaker, (talkTime.get(s.speaker) ?? 0) + s.endTime - s.startTime);
  }

  async function reprocess() {
    await reprocessMeeting(token, id).catch(() => {});
    setReloadKey((k) => k + 1);
  }

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ fontSize: 22 }}>{m.title}</h1>
        <StatusBadge status={m.status} pipeline={m.pipeline} />
      </div>
      {retryable && (
        <section style={{ ...panel, border: "1px solid #f0d9b0" }}>
          <h2 style={h2}>{m.status === "failed" ? "El procesamiento falló" : "Necesita revisión"}</h2>
          {m.pipeline?.lastError && <p style={{ color: "#a06a1c", whiteSpace: "pre-wrap" }}>{m.pipeline.lastError}</p>}
          <button style={{ ...btn, width: "auto" }} onClick={() => void reprocess()}>Reprocesar</button>
        </section>
      )}
      {m.summary && (
        <section style={panel}>
          <h2 style={h2}>Resumen</h2>
          <p>{m.summary.summary}</p>
          {m.summary.keyPoints.length > 0 && <>
            <h3 style={h3}>Puntos clave</h3>
            <ul>{m.summary.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
          </>}
          {m.summary.actionItems.length > 0 && <>
            <h3 style={h3}>Action items</h3>
            <ul>{m.summary.actionItems.map((a, i) => <li key={i}>{a.text}{a.owner ? ` — ${a.owner}` : ""}</li>)}</ul>
          </>}
        </section>
      )}
      <section style={panel}>
        <h2 style={h2}>Preguntá sobre la reunión</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...input, margin: 0 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Qué se decidió sobre…?" />
          <button style={{ ...btn, width: "auto" }} onClick={async () => {
            setAnswer("…"); setAnswer((await askMeeting(token, id, q)).answer);
          }}>Preguntar</button>
        </div>
        {answer && <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{answer}</p>}
      </section>
      <section style={panel}>
        <h2 style={h2}>
          Transcripción
          {live && <span style={{ fontWeight: 400, fontSize: 12, color: "#888" }}> — se actualiza automáticamente</span>}
        </h2>
        {talkTime.size > 0 && (
          <p style={{ fontSize: 12, color: "#888", margin: "0 0 10px" }}>
            Tiempo de palabra: {[...talkTime.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([speaker, sec]) => `${speaker} ${fmtDur(sec)}`)
              .join(" · ")}
          </p>
        )}
        {m.segments.length === 0 && live && <p style={{ color: "#888" }}>Esperando segmentos…</p>}
        {m.segments.map((s, i) => (
          <p key={s.segId ?? i} style={{ margin: "6px 0" }}>
            <strong>{s.speaker}:</strong> {s.text}
          </p>
        ))}
      </section>
    </div>
  );
}

const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

const Center = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>{children}</div>
);

const card: React.CSSProperties = { background: "#fff", padding: 28, borderRadius: 12, width: 280, boxShadow: "0 2px 12px #0001" };
const panel: React.CSSProperties = { background: "#fff", padding: 20, borderRadius: 10, marginBottom: 16, boxShadow: "0 1px 4px #0001" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", margin: "6px 0", padding: 10, border: "1px solid #ddd", borderRadius: 6 };
const btn: React.CSSProperties = { padding: "10px 14px", border: 0, borderRadius: 6, background: "#5b5fc7", color: "#fff", cursor: "pointer", width: "100%" };
const badge: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
const h2: React.CSSProperties = { fontSize: 15, margin: "0 0 8px" };
const h3: React.CSSProperties = { fontSize: 13, margin: "12px 0 4px", color: "#555" };
