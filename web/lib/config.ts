export const CONFIG = {
  region: "us-east-1",
  apiUrl: "https://rv3wzr5llg.execute-api.us-east-1.amazonaws.com",
  userPoolId: "us-east-1_8iPeU4V78",
  userPoolClientId: "18m3lcii9uq8qd3k3f59kplgns",
};

/** White-label product name — never hardcode a brand elsewhere (spec §0). */
export const APP_NAME = "Minutix";

/** Spanish display labels for the coarse status machine (spec §2). */
export const STATUS_LABELS: Record<string, string> = {
  capturing: "En vivo",
  processing: "Procesando",
  ready: "Lista",
  needs_review: "Revisar",
  failed: "Error",
};

/** Spanish labels for `pipeline.phase` shown while `processing` (spec §3.2). */
export const PHASE_LABELS: Record<string, string> = {
  INGESTED: "Ingesta",
  CORRELATED: "Hablantes",
  ASR_SCORED: "Calidad de audio",
  CLEANED: "Limpieza",
  EXTRACTED: "Extracción",
  DRAFTED: "Resumen",
  VERIFIED: "Verificación",
  PUBLISHED: "Publicación",
};
