import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import type { LabeledSegment, MeetingSummary } from "@teams-agent-core/shared";

const bedrock = new BedrockRuntimeClient({});

// Cross-region inference profile. Model access must be enabled in the Bedrock
// console; override per environment if a different model is provisioned.
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const SUMMARY_SYSTEM = `Sos un asistente que analiza transcripciones de reuniones de Microsoft Teams.
Devolvés SIEMPRE un único objeto JSON válido, sin texto adicional ni markdown, con esta forma:
{"summary": string, "keyPoints": string[], "actionItems": [{"text": string, "owner"?: string}]}
El resumen es ejecutivo (2-4 oraciones). Los puntos clave son concisos. Los action items
incluyen el responsable (owner) cuando la transcripción lo permite atribuir.`;

export async function summarizeMeeting(
  segments: LabeledSegment[],
): Promise<MeetingSummary> {
  const transcript = renderTranscript(segments);
  const text = await converse(SUMMARY_SYSTEM, [
    { role: "user", content: [{ text: `Transcripción:\n\n${transcript}` }] },
  ]);
  return parseSummary(text);
}

export async function askMeeting(
  segments: LabeledSegment[],
  question: string,
): Promise<string> {
  const transcript = renderTranscript(segments);
  const system = `Respondés preguntas sobre la reunión basándote SOLO en la transcripción provista.
Si la respuesta no está en la transcripción, decílo explícitamente. Sé conciso.`;
  return converse(system, [
    {
      role: "user",
      content: [{ text: `Transcripción:\n\n${transcript}\n\nPregunta: ${question}` }],
    },
  ]);
}

async function converse(system: string, messages: Message[]): Promise<string> {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: system }],
      messages,
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    }),
  );
  const block = res.output?.message?.content?.find((c) => "text" in c);
  return block && "text" in block ? (block.text ?? "") : "";
}

function renderTranscript(segments: LabeledSegment[]): string {
  return segments
    .map((s) => `[${fmt(s.startTime)}] ${s.speaker}: ${s.text}`)
    .join("\n");
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseSummary(text: string): MeetingSummary {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as MeetingSummary;
  return {
    summary: parsed.summary ?? "",
    keyPoints: parsed.keyPoints ?? [],
    actionItems: parsed.actionItems ?? [],
  };
}
