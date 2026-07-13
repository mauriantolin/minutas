import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({});

export const EMBED_VERSION = "titan-v2-1024";
export const EMBED_DIMENSIONS = 1024;

const RETRYABLE = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
]);

async function sendWithBackoff(
  input: InvokeModelCommandInput,
  maxRetries: number = 4,
) {
  for (let i = 0; ; i++) {
    try {
      return await bedrock.send(new InvokeModelCommand(input));
    } catch (err) {
      const e = err as Error & { $metadata?: { httpStatusCode?: number } };
      const throttled =
        RETRYABLE.has(e.name) || e.$metadata?.httpStatusCode === 429;
      if (!throttled || i >= maxRetries) throw err;
      await new Promise((r) =>
        setTimeout(r, 500 * 2 ** i + Math.random() * 250),
      );
    }
  }
}

export async function embedText(text: string): Promise<number[]> {
  const res = await sendWithBackoff({
    modelId: process.env.EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      inputText: text.slice(0, 40000),
      dimensions: EMBED_DIMENSIONS,
      normalize: true,
    }),
  });
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding: number[];
  };
  return parsed.embedding;
}

export async function embedAll(
  texts: string[],
  concurrency: number = 4,
): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < texts.length; i = next++) {
      out[i] = await embedText(texts[i] as string);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, texts.length) }, worker),
  );
  return out;
}
