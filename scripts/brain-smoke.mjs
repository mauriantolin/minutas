#!/usr/bin/env node
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// End-to-end smoke test for the second brain API: login, admin backfill,
// note creation + listing, grounded questions with citations, thread listing.
//
// Usage:
//   API_URL=<https://api…> USER_EMAIL=<email> USER_PASSWORD=<pass> \
//   USER_POOL_CLIENT_ID=<client id> node scripts/brain-smoke.mjs ["pregunta 1" "pregunta 2" …]

const { API_URL, USER_EMAIL, USER_PASSWORD, USER_POOL_CLIENT_ID } = process.env;
if (!API_URL || !USER_EMAIL || !USER_PASSWORD || !USER_POOL_CLIENT_ID) {
  console.error(
    "Faltan variables de entorno. Uso:\n" +
      "  API_URL=<url> USER_EMAIL=<email> USER_PASSWORD=<pass> USER_POOL_CLIENT_ID=<id> \\\n" +
      '  node scripts/brain-smoke.mjs ["pregunta 1" "pregunta 2" …]',
  );
  process.exit(2);
}

const questions =
  process.argv.slice(2).filter((q) => q.trim()).length > 0
    ? process.argv.slice(2).filter((q) => q.trim())
    : [
        "¿Qué decisiones se tomaron recientemente?",
        "¿Qué dice mi nota sobre el proyecto Fénix?",
        "¿Qué temas se trataron en las últimas reuniones?",
      ];

const CITATION_URL_RE = /^\/(meeting\?id=|notes\?id=)/;
const base = API_URL.replace(/\/+$/, "");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

console.log("Autenticando contra Cognito…");
const cognito = new CognitoIdentityProviderClient({});
const auth = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: USER_POOL_CLIENT_ID,
    AuthParameters: { USERNAME: USER_EMAIL, PASSWORD: USER_PASSWORD },
  }),
);
const idToken = auth.AuthenticationResult?.IdToken;
if (!idToken) {
  console.error(`No se obtuvo IdToken (challenge pendiente: ${auth.ChallengeName ?? "desconocido"}).`);
  process.exit(2);
}
console.log(`Sesión iniciada como ${USER_EMAIL}.\n`);

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

console.log("Paso 1: backfill del índice (POST /admin/reindex)…");
{
  let cursor;
  for (let page = 1; page <= 50; page++) {
    const res = await api("POST", "/admin/reindex", cursor ? { cursor } : {});
    if (res.status === 403) {
      console.log("El usuario no es admin: se omite el backfill y se continúa con el resto del smoke.");
      break;
    }
    if (
      !check(
        `reindex página ${page}`,
        res.status === 200,
        res.status === 200
          ? `procesados=${res.body.processed} indexados=${res.body.indexed} fallidos=${res.body.failed} salteados=${res.body.skipped} done=${res.body.done}`
          : `status ${res.status}: ${JSON.stringify(res.body)}`,
      )
    )
      break;
    if (res.body.done) break;
    cursor = res.body.cursor;
  }
}

console.log("\nPaso 2: crear nota tipeada (POST /notes)…");
const noteRes = await api("POST", "/notes", {
  rawText:
    "Nota de prueba del smoke test: el proyecto Fénix arranca el lunes con presupuesto de 50 mil dólares.",
  source: "typed",
});
const note = noteRes.body;
check(
  "crear nota",
  (noteRes.status === 201 || noteRes.status === 200) &&
    Boolean(note?.title?.trim()) &&
    Boolean(note?.cleanText?.trim()),
  noteRes.status === 201 || noteRes.status === 200
    ? undefined
    : `status ${noteRes.status}: ${JSON.stringify(noteRes.body)}`,
);
if (note?.noteId) {
  console.log(`  noteId: ${note.noteId}`);
  console.log(`  título: ${note.title}`);
  console.log(`  texto limpio: ${note.cleanText}`);
}

console.log("\nPaso 3: la nota aparece en el listado (GET /notes)…");
const listRes = await api("GET", "/notes");
check(
  "listar notas",
  listRes.status === 200 &&
    Boolean(note?.noteId) &&
    (listRes.body?.notes ?? []).some((n) => n.noteId === note.noteId),
  `status ${listRes.status}, ${listRes.body?.notes?.length ?? 0} nota(s)`,
);

console.log("\nPaso 4: preguntas al segundo cerebro (POST /brain/ask)…");
let firstThreadId;
for (const [i, question] of questions.entries()) {
  const body = { message: question };
  if (i === 1 && firstThreadId) body.threadId = firstThreadId;
  console.log(`\nPregunta ${i + 1}${body.threadId ? ` (mismo hilo ${body.threadId})` : " (hilo nuevo)"}: ${question}`);
  const res = await api("POST", "/brain/ask", body);
  const answer = res.body?.answer;
  const citations = res.body?.citations ?? [];
  const ok = check(
    `respuesta ${i + 1}`,
    res.status === 200 && Boolean(answer?.trim()),
    res.status === 200 ? `${citations.length} cita(s)` : `status ${res.status}: ${JSON.stringify(res.body)}`,
  );
  if (!ok) continue;
  if (i === 0) firstThreadId = res.body.threadId;
  console.log(`  ${answer.replaceAll("\n", "\n  ")}`);
  for (const c of citations) {
    console.log(`  cita: [${c.ref}] ${c.title} → ${c.url}`);
  }
  check(
    `citas ${i + 1} con URLs válidas`,
    citations.every((c) => CITATION_URL_RE.test(c.url)),
    citations.length === 0 ? "sin citas" : undefined,
  );
}

console.log("\nPaso 5: el hilo aparece en el listado (GET /brain/threads)…");
const threadsRes = await api("GET", "/brain/threads");
check(
  "listar hilos",
  threadsRes.status === 200 &&
    Boolean(firstThreadId) &&
    (threadsRes.body?.threads ?? []).some((t) => t.threadId === firstThreadId),
  `status ${threadsRes.status}, ${threadsRes.body?.threads?.length ?? 0} hilo(s)`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\nRESUMEN: ${results.length - failed.length}/${results.length} chequeos OK`);
if (failed.length > 0) {
  console.error(`RESULTADO: FALLÓ — ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
console.log("RESULTADO: OK — smoke test del segundo cerebro completo.");
