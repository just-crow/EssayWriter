import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

export const NIM_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const OPENROUTER_MODEL = "openai/gpt-6-luna";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Upper bound for one model attempt. The hosted endpoint sometimes stalls
 * (accepts the request but sends nothing for minutes); without this the
 * call hangs until the SDK default timeout, looking dead to the user.
 * Healthy sources/structure calls answer in 20-60s in testing. */
export const NIM_TIMEOUT_MS = 60_000;

let cached: OpenAI | null = null;
let cachedRouter: OpenAI | null = null;
let routerKey = "";
let routerUnavailableUntil = 0;

/** Test hook: clear the OpenRouter cooldown so tests control routing. */
export function resetProviderCooldowns(): void {
  routerUnavailableUntil = 0;
}

export function openRouterClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY.");
  if (!cachedRouter || routerKey !== apiKey) {
    cachedRouter = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, maxRetries: 0 });
    routerKey = apiKey;
  }
  return cachedRouter;
}

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

function getRetryAfterMs(err: unknown): number {
  // The OpenAI SDK stores headers as a plain Record (not a Headers instance
  // with .get()), so the old `.headers?.get?.("retry-after")` never matched
  // and 429s retried on a fixed 2s/4s cadence, ignoring the server's signal.
  const headers = (err as { headers?: unknown })?.headers;
  let raw: string | null | undefined;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    try {
      raw = (headers as { get: (name: string) => string | null }).get("retry-after");
    } catch {
      raw = undefined;
    }
  } else if (headers && typeof headers === "object") {
    const record = headers as Record<string, string | string[] | null | undefined>;
    const key = Object.keys(record).find((k) => k.toLowerCase() === "retry-after");
    const value = key ? record[key] : undefined;
    raw = Array.isArray(value) ? value[0] : value;
    if (raw == null) {
      const msKey = Object.keys(record).find((k) => k.toLowerCase() === "retry-after-ms");
      const msValue = msKey ? record[msKey] : undefined;
      const ms = Number(Array.isArray(msValue) ? msValue[0] : msValue);
      if (Number.isFinite(ms) && ms > 0) return Math.min(60_000, ms);
    }
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, seconds * 1000);
  return 0;
}

function getStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryable(err: unknown): boolean {
  const status = getStatus(err);
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
      const retryAfterMs = getRetryAfterMs(err);
      const base = 2000 * 2 ** attempt;
      const delay = retryAfterMs > 0 ? Math.min(60_000, retryAfterMs) : Math.min(16_000, base);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

interface ChatParams {
  signal?: AbortSignal;
  timeoutMs?: number;
  provider?: "nvidia";
  onProvider?: (provider: "openrouter" | "nvidia") => void;
  model?: string;
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
  /** Short reasoning for source-grounded writing without unbounded traces. */
  lowEffort?: boolean;
  reasoningBudget?: number;
  responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
}

/** Provider-specific reasoning controls. */
type ExtraBody = {
  provider?: { require_parameters: boolean };
  reasoning?: { enabled?: boolean; effort?: "none" | "low" | "medium"; max_tokens?: number; exclude?: boolean };
  chat_template_kwargs?: { enable_thinking: boolean; low_effort?: boolean; reasoning_budget?: number };
  /** NVIDIA's current Nemotron API uses this OpenAI-compatible control. */
  reasoning_effort?: "none";
};

function requestBody(
  params: ChatParams,
  extra?: { stream?: false }, provider?: "nvidia" | "openrouter"
): ChatCompletionCreateParamsNonStreaming & ExtraBody;
function requestBody(
  params: ChatParams,
  extra: { stream: true }, provider?: "nvidia" | "openrouter"
): ChatCompletionCreateParamsStreaming & ExtraBody;
function requestBody(params: ChatParams, extra?: { stream?: boolean }, provider: "nvidia" | "openrouter" = "nvidia"): (
  | ChatCompletionCreateParamsNonStreaming
  | ChatCompletionCreateParamsStreaming
) & ExtraBody {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const routerModel = params.model ?? OPENROUTER_MODEL;
  const luna = provider === "openrouter" && routerModel === OPENROUTER_MODEL;
  const body = {
    model: provider === "openrouter" ? routerModel
      : params.model?.startsWith("nvidia/") && !params.model.endsWith(":free") ? params.model : NIM_MODEL,
    messages,
    // GPT-6 reasoning requests reject custom sampling values. They remain
    // available for the NVIDIA fallback and for Luna with reasoning off.
    ...(!luna || params.thinking === false ? { temperature: params.temperature ?? 0.6, top_p: 0.95 } : {}),
    max_tokens: params.maxTokens ?? 6000,
    ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    // Luna's JSON-object mode works, but its provider is excluded by
    // require_parameters. Reserve that strict filter for JSON Schema.
    ...(provider === "openrouter" && params.responseFormat &&
      (!luna || params.responseFormat.type === "json_schema")
      ? { provider: { require_parameters: true } } : {}),
    ...extra,
    ...(luna ? { reasoning: params.thinking === false
      ? { effort: "none" as const, exclude: true }
      : { effort: params.lowEffort ? "low" as const : "medium" as const, exclude: true } }
      : provider === "openrouter" ? { reasoning: params.thinking === false
      ? { enabled: false }
      : { enabled: true, exclude: true, ...(params.reasoningBudget !== undefined ? { max_tokens: params.reasoningBudget } : params.lowEffort ? { effort: "low" as const } : {}) } }
      : !(params.model ?? NIM_MODEL).includes("nemotron") ? {} : params.thinking === false
      ? { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" as const }
      : params.thinking === true
        ? { chat_template_kwargs: {
          enable_thinking: true,
          ...(params.lowEffort ? { low_effort: true } : {}),
          ...(params.reasoningBudget !== undefined ? { reasoning_budget: params.reasoningBudget } : {}),
        } }
        : {}),
  };
  // The installed OpenAI SDK predates NVIDIA's reasoning_effort extension.
  return body as (
    | ChatCompletionCreateParamsNonStreaming
    | ChatCompletionCreateParamsStreaming
  ) & ExtraBody;
}

/** Tag genuine provider transport/HTTP failures with the provider name so
 * errors name the culprit ("OpenRouter Luna error (503): ...") instead of a
 * bare provider message. Our own logic errors (output limits, empty
 * responses) pass through untouched. Status and headers are carried over so
 * rate-limit handling (retry-after, 429 hints) keeps working. */
export function tagProviderError(provider: "nvidia" | "openrouter", err: unknown): unknown {
  const status = getStatus(err);
  const name = (err as { constructor?: { name?: string } })?.constructor?.name;
  if (status === undefined && name !== "APIConnectionError" && name !== "APIConnectionTimeoutError") return err;
  const label = provider === "openrouter" ? "OpenRouter Luna" : "NVIDIA";
  const msg = err instanceof Error ? err.message : String(err ?? "request failed");
  const tagged = new Error(`${label} error${typeof status === "number" ? ` (${status})` : ""}: ${msg}`);
  (tagged as { status?: unknown }).status = status;
  (tagged as { headers?: unknown }).headers = (err as { headers?: unknown })?.headers;
  return tagged;
}

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "request failed");
}

async function withProviderFallback(params: ChatParams, run: (client: OpenAI, provider: "nvidia" | "openrouter") => Promise<string>) {
  params.signal?.throwIfAborted();
  let primaryError: unknown = null;
  let primaryAttempts = 0;
  if (params.provider !== "nvidia" && process.env.OPENROUTER_API_KEY && Date.now() >= routerUnavailableUntil) {
    params.onProvider?.("openrouter");
    try {
      // The paid primary gets its own retries (honoring retry-after) before
      // any fallback: a transient Luna 503 must not burn NVIDIA quota or
      // surface as a fallback error. Non-retryable errors fall through fast.
      return await withRetry(
        () => { params.signal?.throwIfAborted(); return run(openRouterClient(), "openrouter"); },
        params.tries ?? 2,
        (n) => { primaryAttempts = Math.max(primaryAttempts, n); params.onAttempt?.(n); }
      );
    } catch (err) {
      params.signal?.throwIfAborted();
      if (params.signal?.aborted) throw err;
      // Discard any partial output, and avoid repeatedly probing an
      // unavailable provider during the same essay.
      primaryError = err;
      routerUnavailableUntil = Date.now() + 60_000;
    }
  }
  params.onProvider?.("nvidia");
  try {
    return await withRetry(() => { params.signal?.throwIfAborted(); return run(nimClient(), "nvidia"); }, params.tries ?? 3, n => params.onAttempt?.(primaryAttempts + n));
  } catch (err) {
    // Never swallow the primary failure: when both providers fail, the user
    // must see both (a paid-Luna outage currently surfaces as a bare
    // NVIDIA error, sending debugging in the wrong direction).
    if (primaryError) throw new Error(`${describeFailure(primaryError)}; NVIDIA fallback failed: ${describeFailure(err)}`);
    throw err;
  }
}

export async function nimChat(params: ChatParams): Promise<string> {
  return withProviderFallback(params,
    async (client, provider) => {
      try {
        const completion = await client.chat.completions.create(
          requestBody(params, undefined, provider),
          { timeout: params.timeoutMs ?? NIM_TIMEOUT_MS, signal: params.signal }
        );
        const choice = completion.choices?.[0];
        if (choice?.finish_reason === "length") {
          throw new Error("The model reached its output limit before finishing the JSON. Use a shorter word target.");
        }
        if (!choice?.message?.content) throw new Error("Model returned an empty response.");
        return choice.message.content;
      } catch (err) {
        throw tagProviderError(provider, err);
      }
    }
  );
}

/** Streaming variant for long generations (full essay drafts).
 * The hosted NIM gateway resets buffered connections past ~100s, so we
 * stream chunks and accumulate. Use this for draft and refine calls. */
export async function nimChatLong(params: ChatParams): Promise<string> {
  return withProviderFallback(params, async (client, provider) => {
    // The SDK timeout only bounds stream setup. Bound the entire response as
    // well, so a provider that stops sending chunks cannot consume the whole
    // draft route's ten-minute budget before fallback gets a turn.
    const limit = params.timeoutMs ?? 120_000;
    const deadline = AbortSignal.timeout(limit);
    const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
    try {
      const stream = await client.chat.completions.create(
        requestBody(params, { stream: true }, provider),
        { timeout: limit, signal }
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
    } catch (error) {
      params.signal?.throwIfAborted();
      if (deadline.aborted) throw new Error(`Model stream timed out after ${Math.ceil(limit / 1000)} seconds.`);
      throw tagProviderError(provider, error);
    }
  });
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

/** Provider decoding requires all object fields. Defaults and optional
 * fields remain supported by the application parser for legacy responses. */
function requiredOutputSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodDefault) return requiredOutputSchema(schema.removeDefault());
  if (schema instanceof z.ZodOptional) return requiredOutputSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable) return requiredOutputSchema(schema.unwrap()).nullable();
  if (schema instanceof z.ZodEffects) return requiredOutputSchema(schema.innerType());
  if (schema instanceof z.ZodArray) {
    return new z.ZodArray({ ...schema._def, type: requiredOutputSchema(schema.element) });
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = requiredOutputSchema(value as z.ZodTypeAny);
    return z.object(shape).strict();
  }
  return schema;
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
    /** Use the verified, cleaned value as the basis of a domain repair. */
    repairResponse?: (v: z.output<T>) => string;
    /** Temperature shift on retry. Positive adds variety (good for refusals
     * and malformed output); negative cools down (good for verbatim
     * fidelity). Defaults to +0.2. */
    retryTempDelta?: number;
  },
  generate: (p: ChatParams) => Promise<string> = nimChat
): Promise<z.output<T>> {
  let last: unknown = new Error("The model didn't return usable data. Try again.");
  const tries = params.parseTries ?? 2;
  const tempDelta = params.retryTempDelta ?? 0.2;
  let seen = 0;
  let feedback = "";
  let priorRaw = "";
  let forceNvidia = params.provider === "nvidia";
  const responseFormat = params.responseFormat ?? zodResponseFormat(requiredOutputSchema(params.schema), "response");
  const report = (base: number) => (n: number) => {
    seen = Math.max(seen, base + n);
    params.onAttempt?.(seen);
  };
  for (let i = 0; i < tries; i++) {
    let raw: string;
    try {
      raw =
        i === 0
          ? await generate({ ...params, ...(forceNvidia ? { provider: "nvidia" as const } : {}), responseFormat, onAttempt: report(seen) })
        : await generate({
            ...params,
            ...(forceNvidia ? { provider: "nvidia" as const } : {}),
            responseFormat,
            user: feedback.toLowerCase().includes("malformed") || feedback.toLowerCase().includes("json")
              ? `${params.user}\n\nVALIDATION FAILURE:\n${feedback}\nThe previous output was malformed and could not be parsed as valid JSON. Return strictly valid RFC-8259 JSON matching the schema. Escape every quote inside prose strings (use \\") and ensure all brackets are properly closed.`
              : `${params.user}\n\nThe previous response is included below. Repair it instead of starting over. Preserve valid content and change only what is needed to pass validation.\n\nVALIDATION FAILURE:\n${feedback}\n\nPREVIOUS RESPONSE:\n${priorRaw.slice(0, 80_000)}\n\nReturn one complete corrected JSON object matching the required schema. Preserve source IDs and escape quotes and newlines inside JSON strings.`,
            temperature: Math.min(1, Math.max(0.1, (params.temperature ?? 0.6) + i * tempDelta)),
            onAttempt: report(seen),
          });
    } catch (e) {
      const m = e instanceof Error ? e.message : "request failed";
      // Transport retries already happen inside nimChat/Long. Repeating
      // them once per JSON repair can turn an outage into a very long wait.
      // A composite draft can contain several completeJson calls. Preserve
      // an already classified service error instead of wrapping it again.
      if (m.startsWith("Model service error (") || m.startsWith("Rate limit reached (")) throw e;
      if (getStatus(e) === 429 || /429/.test(m)) {
        const wait = getRetryAfterMs(e);
        const hint = wait > 0 ? ` Wait about ${Math.ceil(wait / 1000)}s, then try again.` : " Wait a bit, then try again.";
        throw new Error(`Rate limit reached (${m}).${hint}`);
      }
      throw new Error(`Model service error (${m}). Try again in a bit.`);
    }
    let value: z.output<T> | undefined;
    try {
      value = params.schema.parse(parseModelJson(raw));
      await params.validate?.(value);
      return value;
    } catch (e) {
      // A verifier can itself call the provider. An outage there is not
      // invalid essay content and must not restart the entire composition.
      if (e instanceof Error && e.message.startsWith("Model service error (")) throw e;
      if ((generate === nimChat || generate === nimChatLong) && process.env.OPENROUTER_API_KEY) forceNvidia = true;
      priorRaw = value !== undefined && params.repairResponse ? params.repairResponse(value) : raw;
      last = e instanceof z.ZodError
        ? new Error(`The model returned invalid fields: ${e.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}. Try again.`)
        : e;
      feedback = last instanceof Error ? last.message : "invalid JSON";
    }
  }
  throw last;
}
