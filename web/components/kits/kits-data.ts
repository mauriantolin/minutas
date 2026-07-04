/**
 * AI prompt kits (spec §3.8): curated prompt collections run through the
 * existing POST /ask. Built-ins are const; custom kits persist to
 * localStorage (`kits:custom`) — zero backend.
 */

export interface KitPrompt {
  name: string;
  prompt: string;
}

export interface Kit {
  id: string;
  emoji: string;
  name: string;
  description: string;
  prompts: KitPrompt[];
  custom?: boolean;
}

export const BUILT_IN_KITS: Kit[] = [
  {
    id: "general",
    emoji: "📋",
    name: "Reuniones generales",
    description: "Resúmenes y minutas listos para compartir.",
    prompts: [
      {
        name: "Resumen corto",
        prompt: "Generá un resumen corto (máximo 5 líneas) de esta reunión.",
      },
      {
        name: "Minuta formal",
        prompt:
          "Redactá una minuta formal de la reunión con secciones: Asistentes, Temas tratados, Decisiones y Próximos pasos.",
      },
      {
        name: "Mail de seguimiento",
        prompt:
          "Redactá un mail de seguimiento breve y profesional con los puntos clave de la reunión y los próximos pasos acordados.",
      },
    ],
  },
  {
    id: "projects",
    emoji: "✅",
    name: "Gestión de proyectos",
    description: "Acciones, riesgos y estado del proyecto.",
    prompts: [
      {
        name: "Acciones con responsables y fechas",
        prompt:
          "Listá todas las acciones acordadas en formato de checklist, con responsable y fecha límite cuando se mencionen.",
      },
      {
        name: "Riesgos y bloqueos",
        prompt:
          "Identificá los riesgos, bloqueos o dependencias mencionados en la reunión y quién los tiene a cargo.",
      },
      {
        name: "Update de estado",
        prompt:
          "Redactá un update de estado del proyecto en tres secciones: Avances, En curso y Bloqueado.",
      },
    ],
  },
  {
    id: "sales",
    emoji: "💼",
    name: "Ventas",
    description: "Notas comerciales y próximos pasos.",
    prompts: [
      {
        name: "Resumen BANT",
        prompt:
          "Resumí la reunión en formato BANT: Presupuesto, Autoridad, Necesidad y Tiempos.",
      },
      {
        name: "Objeciones y respuestas",
        prompt: "Listá las objeciones que planteó el cliente y cómo se respondió cada una.",
      },
      {
        name: "Próximos pasos",
        prompt:
          "Listá los próximos pasos acordados con el cliente, con responsable y fecha si se mencionan.",
      },
    ],
  },
  {
    id: "one-on-one",
    emoji: "👥",
    name: "1:1 / RRHH",
    description: "Notas de conversaciones uno a uno.",
    prompts: [
      {
        name: "Notas de 1:1",
        prompt:
          "Generá notas de esta 1:1: temas tratados, acuerdos alcanzados y temas a seguir de cerca.",
      },
      {
        name: "Feedback dado y recibido",
        prompt: "Listá el feedback dado y recibido durante la conversación, separado por persona.",
      },
      {
        name: "Temas para próxima reunión",
        prompt: "Listá los temas que quedaron pendientes para tratar en la próxima reunión.",
      },
    ],
  },
  {
    id: "retro",
    emoji: "🔬",
    name: "Retro / Brainstorm",
    description: "Ideas, aprendizajes y experimentos.",
    prompts: [
      {
        name: "Ideas agrupadas por tema",
        prompt: "Agrupá todas las ideas propuestas por tema y listalas en bullets.",
      },
      {
        name: "Qué funcionó / qué no",
        prompt: "Resumí la retro en dos listas: qué funcionó y qué no funcionó.",
      },
      {
        name: "Experimentos propuestos",
        prompt:
          "Listá los experimentos o cambios propuestos, con responsable cuando se haya mencionado.",
      },
    ],
  },
];

const CUSTOM_KITS_KEY = "kits:custom";

export function getCustomKits(): Kit[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(CUSTOM_KITS_KEY);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as Kit[]).map((k) => ({ ...k, custom: true }));
  } catch {
    return [];
  }
}

export function saveCustomKits(kits: Kit[]): void {
  window.localStorage.setItem(CUSTOM_KITS_KEY, JSON.stringify(kits));
}

/** Appends a prompt to a custom kit (AskPanel "Guardar como prompt" hook). */
export function addPromptToKit(kitId: string, prompt: KitPrompt): void {
  saveCustomKits(
    getCustomKits().map((k) => (k.id === kitId ? { ...k, prompts: [...k.prompts, prompt] } : k)),
  );
}
