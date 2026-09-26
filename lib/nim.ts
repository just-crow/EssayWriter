import OpenAI from "openai";
import { z } from "zod";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

export const NIM_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Upper bound for one model attempt. The hosted endpoint sometimes stalls
 * (accepts the request but sends nothing for minutes); without this the
 * call hangs until the SDK default timeout, looking dead to the user.
 * Healthy sources/structure calls answer in 20-60s in testing. */
export const NIM_TIMEOUT_MS = 60_000;

let cached: OpenAI | null = null;

export function nimClient(): OpenAI {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing NVIDIA_NIM_API_KEY. Add it to .env.local (see .env.example)."
    );
  }
  if (!cached) {
    // maxRetries: 0 — our withRetry layer (visible attempts, backoff) is the
    // single source of retry truth. SDK-internal retries would be silent
    // and untracked in the UI.
    cached = new OpenAI({ apiKey, baseURL: NIM_BASE_URL, maxRetries: 0 });
  }
  return cached;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const name = (err as { constructor?: { name?: string } })?.constructor?.name;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /connection error|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|terminated|timed out|timeout|service temporarily overloaded|service unavailable/i.test(
    msg
  );
}

/** The hosted NIM endpoint throws transient 429/503s and connection resets.
 * Retry those with backoff so a first click doesn't die on a blip. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 3,
  onAttempt?: (n: number) => void
): Promise<T> {
  // Exported for unit testing; production callers use nimChat / nimChatLong.
  let last: unknown = new Error("Model request failed.");
  for (let attempt = 0; attempt < tries; attempt++) {
    onAttempt?.(attempt + 1);
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || attempt === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw last;
}

interface ChatParams {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  tries?: number;
  onAttempt?: (n: number) => void;
  /**
   * false disables the model's chain-of-thought. The Nemotron reasoning
   * model otherwise spends most of the token budget thinking (tens of
   * thousands of chars in `reasoning_content`) and can starve the actual
   * answer past max_tokens. Disable for long generations (draft/refine),
   * leave on for short structured ones where reasoning helps.
   */
  thinking?: boolean;
}

/** Provider extension field (Nemotron reasoning toggle). */
type ExtraBody = {
  chat_template_kwargs?: { enable_thinking: boolean };
  /** NVIDIA's current Nemotron API uses this OpenAI-compatible control. */
  reasoning_effort?: "none";
};

function requestBody(
  params: ChatParams,
  extra?: { stream?: false }
): ChatCompletionCreateParamsNonStreaming & ExtraBody;
function requestBody(
  params: ChatParams,
  extra: { stream: true }
): ChatCompletionCreateParamsStreaming & ExtraBody;
function requestBody(params: ChatParams, extra?: { stream?: boolean }): (
  | ChatCompletionCreateParamsNonStreaming
  | ChatCompletionCreateParamsStreaming
) & ExtraBody {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const body = {
    model: NIM_MODEL,
    messages,
    temperature: params.temperature ?? 0.6,
    max_tokens: params.maxTokens ?? 6000,
    ...extra,
    ...(params.thinking === false
      ? { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" as const }
      : {}),
  };
  // The installed OpenAI SDK predates NVIDIA's reasoning_effort extension.
  return body as (
    | ChatCompletionCreateParamsNonStreaming
    | ChatCompletionCreateParamsStreaming
  ) & ExtraBody;
}

export async function nimChat(params: ChatParams): Promise<string> {
  return withRetry(
    async () => {
      const client = nimClient();
      const completion = await client.chat.completions.create(
        requestBody(params),
        { timeout: NIM_TIMEOUT_MS }
      );
      const choice = completion.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new Error("The model reached its output limit before finishing the JSON. Use a shorter word target.");
      }
      if (!choice?.message?.content) throw new Error("Model returned an empty response.");
      return choice.message.content;
    },
    params.tries ?? 3,
    params.onAttempt
  );
}

/** Streaming variant for long generations (full essay drafts).
 * The hosted NIM gateway resets buffered connections past ~100s, so we
 * stream chunks and accumulate. Use this for draft and refine calls. */
export async function nimChatLong(params: ChatParams): Promise<string> {
  return withRetry(async () => {
    // Allow long generations but bound connection setup below the route limit.
    const client = nimClient();
    const stream = await client.chat.completions.create(
      requestBody(params, { stream: true }),
      { timeout: 240_000 }
    );
    let out = "";
    let finished = false;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      out += choice?.delta?.content ?? "";
      if (choice?.finish_reason === "length") {
        throw new Error("The model reached its output limit before finishing the JSON. Use a shorter word target.");
      }
      if (choice?.finish_reason === "stop") finished = true;
    }
    if (!finished) throw new Error("Model stream terminated before completing the response.");
    if (!out) throw new Error("Model returned an empty stream.");
    return out;
  }, params.tries ?? 3, params.onAttempt);
}

/**
 * Extract the first balanced JSON object, repairing raw string controls
 * and structural trailing commas without changing quoted prose.
 */
export function parseModelJson(text: string): unknown {
  let t = (text ?? "").trim();
  try { return JSON.parse(t); } catch { /* unwrap model commentary below */ }
  t = t.replace(/^<think>[\s\S]*?<\/think>/, "").trim();
  const start = t.indexOf("{");
  if (start === -1) {
    throw new Error("The model didn't return usable data. Try again.");
  }
  let repaired = "";
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (ch.charCodeAt(0) < 32) {
        repaired += JSON.stringify(ch).slice(1, -1);
        escaped = false;
        continue;
      }
      repaired += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    // Only remove structural trailing commas. Quoted prose stays intact.
    if (ch === "," && /^\s*[}\]]/.test(t.slice(i + 1))) continue;
    repaired += ch;
    if (depth === 0) break;
  }
  try {
    return JSON.parse(repaired);
  } catch {
    throw new Error("The model returned malformed data. Try again.");
  }
}

/**
 * Full request cycle for JSON-returning stages: generate, lenient-parse,
 * schema-validate. A stochastic malformed answer gets one fresh retry at
 * slightly higher temperature before surfacing a friendly error.
 * Attempt numbers reported via onAttempt are CUMULATIVE across both phases
 * (1..6), so progress displays never reset backwards.
 */
export async function completeJson<T extends z.ZodTypeAny>(
  params: ChatParams & {
    schema: T;
    parseTries?: number;
    /** Extra domain check (e.g. non-empty). Throwing retries the generation. */
    validate?: (v: z.output<T>) => void | Promise<void>;
    /** Temperature shift on retry. Positive adds variety (good for refusals
     * and malformed output); negative cools down (good for verbatim
     * fidelity). Defaults to +0.2. */
    retryTempDelta?: number;
  },
  generate: (p: ChatParams) => Promise<string> = nimChat
): Promise<z.output<T>> {
  let last: unknown = new Error("The model didn't return usable data. Try again.");
  const tries = params.parseTries ?? 2;
  const perTry = params.tries ?? 3;
  const tempDelta = params.retryTempDelta ?? 0.2;
  let seen = 0;
  let feedback = "";
  let priorRaw = "";
  const report = (base: number) => (n: number) => {
    seen = Math.max(seen, base + n);
    params.onAttempt?.(seen);
  };
  for (let i = 0; i < tries; i++) {
    let raw: string;
    try {
      raw =
        i === 0
          ? await generate({ ...params, onAttempt: report(i * perTry) })
        : await generate({
            ...params,
            user: feedback.toLowerCase().includes("malformed") || feedback.toLowerCase().includes("json")
              ? `${params.user}\n\nVALIDATION FAILURE:\n${feedback}\nThe previous output was malformed and could not be parsed as valid JSON. Return strictly valid RFC-8259 JSON matching the schema. Escape every quote inside prose strings (use \\") and ensure all brackets are properly closed.`
              : `${params.user}\n\nThe previous response is included below. Repair it instead of starting over. Preserve valid essay content and change only what is needed to pass validation.\n\nVALIDATION FAILURE:\n${feedback}\n\nPREVIOUS RESPONSE:\n${priorRaw.slice(0, 80_000)}\n\nReturn one complete corrected JSON object with matching [^n] markers, footnotes, and evidence. Escape quotes and newlines inside JSON strings.`,
            temperature: Math.min(1, Math.max(0.1, (params.temperature ?? 0.6) + i * tempDelta)),
            onAttempt: report(i * perTry),
          });
    } catch (e) {
      const m = e instanceof Error ? e.message : "request failed";
      last = new Error(`Model service error (${m}). Try again in a bit.`);
      feedback = m;
      continue;
    }
    try {
      const value = params.schema.parse(parseModelJson(raw));
      await params.validate?.(value);
      return value;
    } catch (e) {
      priorRaw = raw;
      last = e instanceof z.ZodError
        ? new Error(`The model returned invalid fields: ${e.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}. Try again.`)
        : e;
      feedback = last instanceof Error ? last.message : "invalid JSON";
    }
  }
  throw last;
}
