"use client";

import { useEffect, useState } from "react";
import { signIn, currentToken, signOut } from "../lib/auth";
import {
  listMeetings,
  getMeeting,
  askMeeting,
  deleteMeeting,
  type Meeting,
  type MeetingDetail,
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

function Dashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    listMeetings(token).then((r) => setMeetings(r.meetings)).catch(() => {});
  }, [token]);

  async function remove(id: string) {
    if (!confirm("¿Borrar esta reunión y su transcripción? No se puede deshacer.")) return;
    setMeetings((prev) => prev.filter((m) => m.meetingId !== id));
    if (selected === id) setSelected(null);
    await deleteMeeting(token, id).catch(() => {});
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside style={{ width: 300, background: "#fff", borderRight: "1px solid #e4e4ee", overflow: "auto" }}>
        <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Reuniones</strong>
          <button style={{ ...btn, width: "auto", padding: "4px 8px" }} onClick={onSignOut}>Salir</button>
        </div>
        {meetings.length === 0 && <p style={{ padding: 16, color: "#888" }}>Sin reuniones aún.</p>}
        {meetings.map((m) => (
          <div key={m.meetingId} onClick={() => setSelected(m.meetingId)}
            style={{ padding: "12px 16px", cursor: "pointer", background: selected === m.meetingId ? "#eef0fb" : "transparent", borderBottom: "1px solid #f0f0f5", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
              <div style={{ fontSize: 12, color: "#888" }}>
                {new Date(m.startedAt).toLocaleString()} · {m.status}
              </div>
            </div>
            <button title="Borrar" onClick={(e) => { e.stopPropagation(); void remove(m.meetingId); }}
              style={{ border: 0, background: "transparent", color: "#c74343", cursor: "pointer", fontSize: 16, padding: 4, flexShrink: 0 }}>×</button>
          </div>
        ))}
      </aside>
      <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {selected ? <Detail token={token} id={selected} /> : <p style={{ color: "#888" }}>Elegí una reunión.</p>}
      </main>
    </div>
  );
}

function Detail({ token, id }: { token: string; id: string }) {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");

  useEffect(() => { setM(null); setAnswer(""); getMeeting(token, id).then(setM).catch(() => {}); }, [token, id]);
  if (!m) return <p>Cargando…</p>;

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 style={{ fontSize: 22 }}>{m.title}</h1>
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
        <h2 style={h2}>Transcripción</h2>
        {m.segments.map((s, i) => (
          <p key={i} style={{ margin: "6px 0" }}>
            <strong>{s.speaker}:</strong> {s.text}
          </p>
        ))}
      </section>
    </div>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>{children}</div>
);

const card: React.CSSProperties = { background: "#fff", padding: 28, borderRadius: 12, width: 280, boxShadow: "0 2px 12px #0001" };
const panel: React.CSSProperties = { background: "#fff", padding: 20, borderRadius: 10, marginBottom: 16, boxShadow: "0 1px 4px #0001" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", margin: "6px 0", padding: 10, border: "1px solid #ddd", borderRadius: 6 };
const btn: React.CSSProperties = { padding: "10px 14px", border: 0, borderRadius: 6, background: "#5b5fc7", color: "#fff", cursor: "pointer", width: "100%" };
const h2: React.CSSProperties = { fontSize: 15, margin: "0 0 8px" };
const h3: React.CSSProperties = { fontSize: 13, margin: "12px 0 4px", color: "#555" };
