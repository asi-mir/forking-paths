import { APICallError, generateText, NoObjectGeneratedError, Output } from "ai";
import type { LanguageModel, LanguageModelUsage, ModelMessage, UserContent } from "ai";
import { z } from "zod";
import {
  modelFromConfig,
  providerOptionsFor,
  resolveModelConfig,
  type ModelConfig,
  type Provider,
  type Role,
} from "./model";

/** An image for the model: raw bytes (already re-encoded on the device) and its media type. */
export interface ImageInput {
  data: Uint8Array;
  mediaType: string;
}

/** What one `generateJson` call cost. Goes into traces and the evidence log. */
export interface ModelCallMeta {
  role: Role;
  provider: Provider;
  model: string;
  thinking: ModelConfig["thinking"];
  inputTokens: number;
  outputTokens: number;
  /** Thinking tokens, when the provider reports them (part of the output on Google). */
  reasoningTokens: number;
  latencyMs: number;
  /** Model requests made, including the repair attempt and backoff retries. */
  requests: number;
  /** True when the first answer failed validation and the repair attempt was used. */
  repaired: boolean;
}

export interface GenerateJsonResult<T> {
  data: T;
  meta: ModelCallMeta;
}

export interface GenerateJsonOptions {
  /** System text. For Gemma on Google it is moved into the first user message by the SDK. */
  instructions?: string;
  /** Cancel the call (combined with the per-attempt timeout). */
  signal?: AbortSignal;
  /** Override the role's per-attempt timeout. */
  timeoutMs?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Env to read model settings from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Test seam: use this model instead of the one from env (the config still names the role). */
  model?: LanguageModel;
  /** Test seam for the 429/503 backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * AI SDK telemetry for the call (see `aiTelemetry` in `trace.ts`). A call that carries a photo
   * passes `recordInputs: false` and `recordOutputs: false`.
   */
  telemetry?: { functionId?: string; recordInputs?: boolean; recordOutputs?: boolean };
}

/** The model answered, but never with JSON that matches the schema (after the repair attempt). */
export class ModelOutputError extends Error {
  override name = "ModelOutputError";
  constructor(
    message: string,
    readonly meta: ModelCallMeta,
    readonly lastText: string | undefined,
  ) {
    super(message);
  }
}

/** The request failed: timeout, network, or an HTTP error that retries did not fix. */
export class ModelCallError extends Error {
  override name = "ModelCallError";
  constructor(
    message: string,
    readonly meta: ModelCallMeta,
    readonly statusCode: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * HTTP statuses worth retrying with backoff: rate limit, "high demand" (503) and the transient
 * 500 "Internal error encountered" that AI Studio returns for Gemma under load.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 20_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pull the first JSON object or array out of model text: tolerates code fences, leading prose
 * and trailing chatter. Throws SyntaxError when no JSON value is found.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the tolerant scan
  }

  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // the fence may hold more than JSON; scan below
    }
  }

  for (let start = 0; start < trimmed.length; start++) {
    const ch = trimmed[start];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchingClose(trimmed, start);
    if (end === -1) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // not valid JSON from here; try the next opening bracket
    }
  }
  throw new SyntaxError("No JSON object found in the model's answer");
}

/** Index of the bracket that closes the one at `start`, skipping string contents; -1 if none. */
function matchingClose(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** A short, model-readable list of what failed validation. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `- ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

function parseAnswer<T>(schema: z.ZodType<T>, text: string | undefined): ParseOutcome<T> {
  if (!text?.trim()) return { ok: false, error: "The answer was empty." };
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: `The JSON did not match the schema:\n${describeIssues(parsed.error)}` };
}

function backoffMs(error: APICallError, attempt: number): number {
  const retryAfter = Number(error.responseHeaders?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, BACKOFF_MAX_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

function addUsage(meta: ModelCallMeta, usage: LanguageModelUsage | undefined): void {
  meta.inputTokens += usage?.inputTokens ?? 0;
  meta.outputTokens += usage?.outputTokens ?? 0;
  meta.reasoningTokens += usage?.outputTokenDetails?.reasoningTokens ?? 0;
}

function userContent(prompt: string, images: readonly ImageInput[] | undefined): UserContent {
  if (!images?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mediaType })),
  ];
}

/**
 * Ollama, or a protected tunnel in front of it, refused the request: say what to check. Ollama
 * itself answers 403 to a Host header that is not its own, which a tunnel forwards unless told
 * to rewrite it.
 */
export function authHint(provider: Provider, statusCode: number): string {
  if (provider !== "ollama") return "";
  if (statusCode === 401 || statusCode === 407) return " (the tunnel refused the request: check OLLAMA_AUTH_HEADER)";
  if (statusCode === 403) {
    return " (refused: check OLLAMA_AUTH_HEADER, and that the tunnel rewrites the Host header to localhost:11434)";
  }
  return "";
}

/**
 * Ask Gemma for one JSON value that matches `schema`.
 *
 * - Sends the schema as the provider's structured-output format (Google `responseJsonSchema`,
 *   Ollama `response_format: json_schema`) and validates the answer with zod.
 * - Tolerant extraction: code fences, leading text and trailing text are ignored.
 * - One repair attempt that shows the model its answer and the validation errors.
 * - Per-attempt timeout (role and provider dependent), backoff on HTTP 429/5xx (max 3).
 *
 * `images` are bytes plus media type, for the photo reader.
 */
export async function generateJson<T>(
  role: Role,
  schema: z.ZodType<T>,
  prompt: string,
  images?: readonly ImageInput[],
  options: GenerateJsonOptions = {},
): Promise<GenerateJsonResult<T>> {
  const env = options.env ?? process.env;
  const config = resolveModelConfig(role, env);
  const model = options.model ?? modelFromConfig(config, env);
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const started = Date.now();

  const meta: ModelCallMeta = {
    role,
    provider: config.provider,
    model: config.modelId,
    thinking: config.thinking,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    requests: 0,
    repaired: false,
  };
  const finish = () => {
    meta.latencyMs = Date.now() - started;
    return meta;
  };

  const messages: ModelMessage[] = [{ role: "user", content: userContent(prompt, images) }];

  /** One model request with backoff. Returns the answer text (or the text of a failed parse). */
  async function request(): Promise<{ text: string | undefined; output?: T }> {
    for (let attempt = 0; ; attempt++) {
      meta.requests++;
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        const result = await generateText({
          model,
          instructions: options.instructions,
          messages,
          output: Output.object({ schema }),
          providerOptions: providerOptionsFor(config),
          maxOutputTokens: options.maxOutputTokens,
          temperature: options.temperature,
          maxRetries: 0,
          abortSignal: signal,
          ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        });
        addUsage(meta, result.usage);
        return { text: result.text, output: result.output as T };
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          addUsage(meta, error.usage);
          return { text: error.text };
        }
        if (
          APICallError.isInstance(error) &&
          error.statusCode !== undefined &&
          RETRY_STATUS.has(error.statusCode) &&
          attempt < MAX_BACKOFF_RETRIES &&
          !options.signal?.aborted
        ) {
          await sleep(backoffMs(error, attempt));
          continue;
        }
        const statusCode = APICallError.isInstance(error) ? error.statusCode : undefined;
        const timedOut = signal.aborted && !options.signal?.aborted;
        const reason = timedOut
          ? `timed out after ${timeoutMs} ms`
          : statusCode
            ? `HTTP ${statusCode}${authHint(config.provider, statusCode)}`
            : (error as Error).message;
        throw new ModelCallError(
          `${role} call to ${config.provider}/${config.modelId} failed: ${reason}`,
          finish(),
          statusCode,
          { cause: error },
        );
      }
    }
  }

  // When the SDK returns `output`, it has already been validated against `schema`.
  const first = await request();
  if (first.output !== undefined) return { data: first.output, meta: finish() };
  const firstParse = parseAnswer(schema, first.text);
  if (firstParse.ok) return { data: firstParse.data, meta: finish() };

  meta.repaired = true;
  messages.push(
    { role: "assistant", content: first.text?.trim() || "(empty answer)" },
    {
      role: "user",
      content:
        `Your answer could not be used.\n${firstParse.error}\n\n` +
        "Reply again with only the corrected JSON object. No prose, no code fences.",
    },
  );

  const second = await request();
  if (second.output !== undefined) return { data: second.output, meta: finish() };
  const secondParse = parseAnswer(schema, second.text);
  if (secondParse.ok) return { data: secondParse.data, meta: finish() };

  throw new ModelOutputError(
    `${role} answer from ${config.provider}/${config.modelId} failed validation twice: ${secondParse.error}`,
    finish(),
    second.text,
  );
}
