import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Gemma for each role, from env. The same Gemma 4 family runs on Google AI Studio or on
 * Ollama (your own machine), with no code change.
 *
 * - `writer`   plans and writes the quest (JSON, thinking on Google).
 * - `reader`   checks the player's photo (image in, JSON out).
 * - `narrator` short spoken lines and recaps.
 *
 * The returned model is an AI SDK language model. Use it with `generateText` from `ai`, or pass
 * it as `model` to a Mastra `Agent` (Mastra 1.x accepts AI SDK models directly).
 */
export type Role = "writer" | "reader" | "narrator";
export type Provider = "google" | "ollama";
export type ProviderSetting = Provider | "auto";
/**
 * Thinking depth. Gemma 4 on Google AI Studio accepts only `minimal` and `high` for
 * `thinkingLevel` ("low" and "medium" return HTTP 400 "Thinking level is not supported for this
 * model"), and it thinks when no level is sent. So every call sends one of the two.
 */
export type ThinkingLevel = "minimal" | "high";

export const ROLES: readonly Role[] = ["writer", "reader", "narrator"];

export interface ModelConfig {
  role: Role;
  provider: Provider;
  /** Provider model ID, e.g. `gemma-4-31b-it` (Google) or `gemma4:e4b` (Ollama). */
  modelId: string;
  /** Ollama only: the OpenAI-compatible base URL. */
  baseURL?: string;
  /** Thinking depth (`GEMMA_<ROLE>_THINKING`). */
  thinking: ThinkingLevel;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_MODELS = {
  google: { writer: "gemma-4-31b-it", reader: "gemma-4-26b-a4b-it", narrator: "gemma-4-26b-a4b-it" },
  ollama: "gemma4:e4b",
  ollamaBaseURL: "http://127.0.0.1:11434/v1",
} as const;

/** Default thinking per role. Only the writer plans; the others answer fast. */
export const DEFAULT_THINKING: Record<Role, ThinkingLevel> = {
  writer: "high",
  reader: "minimal",
  narrator: "minimal",
};

/** Per-attempt timeouts. Ollama on a laptop is several times slower than AI Studio. */
export const TIMEOUTS_MS: Record<Provider, Record<Role, number>> = {
  google: { writer: 90_000, reader: 30_000, narrator: 30_000 },
  ollama: { writer: 300_000, reader: 120_000, narrator: 120_000 },
};

export class ModelConfigError extends Error {
  override name = "ModelConfigError";
}

const PROVIDER_SETTINGS: readonly ProviderSetting[] = ["auto", "google", "ollama"];
/** Accepted spellings for GEMMA_<ROLE>_THINKING. */
const THINKING_ALIASES: Record<string, ThinkingLevel> = {
  minimal: "minimal",
  off: "minimal",
  none: "minimal",
  high: "high",
  on: "high",
};

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function parseProviderSetting(raw: string | undefined, name: string): ProviderSetting | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase() as ProviderSetting;
  if (!PROVIDER_SETTINGS.includes(v)) {
    throw new ModelConfigError(`${name} must be one of ${PROVIDER_SETTINGS.join(", ")}`);
  }
  return v;
}

/**
 * Open weights only. Google AI Studio also serves closed Gemini models, so its IDs must be
 * Gemma. Ollama "cloud" tags run on someone else's servers, so they are refused too.
 */
export function assertOpenWeight(provider: Provider, modelId: string): void {
  if (provider === "google" && !/^gemma-/i.test(modelId)) {
    throw new ModelConfigError(`Only Gemma models may run on Google AI Studio (got "${modelId}")`);
  }
  if (provider === "ollama" && /(^|[:-])cloud$/i.test(modelId)) {
    throw new ModelConfigError(`Ollama cloud models are not allowed (got "${modelId}")`);
  }
}

/** Which provider a role uses: the per-role override, then GEMMA_PROVIDER, then auto. */
export function resolveProvider(role: Role, env: Env = process.env): Provider {
  const roleName = `GEMMA_${role.toUpperCase()}_PROVIDER`;
  const setting =
    parseProviderSetting(value(env, roleName), roleName) ??
    parseProviderSetting(value(env, "GEMMA_PROVIDER"), "GEMMA_PROVIDER") ??
    "auto";
  if (setting !== "auto") return setting;
  return value(env, "GOOGLE_GENERATIVE_AI_API_KEY") ? "google" : "ollama";
}

function resolveThinking(role: Role, env: Env): ThinkingLevel {
  const name = `GEMMA_${role.toUpperCase()}_THINKING`;
  const raw = value(env, name)?.toLowerCase();
  if (raw === undefined) return DEFAULT_THINKING[role];
  const level = THINKING_ALIASES[raw];
  if (!level) throw new ModelConfigError(`${name} must be "minimal" or "high"`);
  return level;
}

/** The full model settings for a role, from env. Throws ModelConfigError on a bad setting. */
export function resolveModelConfig(role: Role, env: Env = process.env): ModelConfig {
  const provider = resolveProvider(role, env);
  const thinking = resolveThinking(role, env);
  const timeoutMs = TIMEOUTS_MS[provider][role];

  if (provider === "google") {
    const modelId =
      value(env, `GEMMA_${role.toUpperCase()}_MODEL`) ??
      (role === "narrator" ? value(env, "GEMMA_READER_MODEL") : undefined) ??
      DEFAULT_MODELS.google[role];
    assertOpenWeight(provider, modelId);
    return { role, provider, modelId, thinking, timeoutMs };
  }

  const modelId = value(env, "OLLAMA_MODEL") ?? DEFAULT_MODELS.ollama;
  assertOpenWeight(provider, modelId);
  const baseURL = (value(env, "OLLAMA_BASE_URL") ?? DEFAULT_MODELS.ollamaBaseURL).replace(/\/+$/, "");
  return { role, provider, modelId, baseURL, thinking, timeoutMs };
}

type GoogleProvider = ReturnType<typeof createGoogleGenerativeAI>;
type OllamaProvider = ReturnType<typeof createOpenAICompatible>;

/**
 * An AI SDK 7 language model (specification v4). Typed narrowly, not as `ai`'s `LanguageModel`
 * union, so it is assignable to a Mastra `Agent`'s `model` as well as to `generateText`.
 */
export type GemmaModel = ReturnType<GoogleProvider> | ReturnType<OllamaProvider["chatModel"]>;

const googleProviders = new Map<string, GoogleProvider>();
const ollamaProviders = new Map<string, OllamaProvider>();

/** Build the AI SDK model for a resolved config. */
export function modelFromConfig(config: ModelConfig, env: Env = process.env): GemmaModel {
  if (config.provider === "google") {
    const apiKey = value(env, "GOOGLE_GENERATIVE_AI_API_KEY");
    if (!apiKey) {
      throw new ModelConfigError(
        `GOOGLE_GENERATIVE_AI_API_KEY is not set (needed by the ${config.role} on google)`,
      );
    }
    let google = googleProviders.get(apiKey);
    if (!google) {
      google = createGoogleGenerativeAI({ apiKey });
      googleProviders.set(apiKey, google);
    }
    return google(config.modelId);
  }

  const baseURL = config.baseURL ?? DEFAULT_MODELS.ollamaBaseURL;
  let ollama = ollamaProviders.get(baseURL);
  if (!ollama) {
    ollama = createOpenAICompatible({
      name: "ollama",
      baseURL,
      supportsStructuredOutputs: true,
      includeUsage: true,
    });
    ollamaProviders.set(baseURL, ollama);
  }
  return ollama.chatModel(config.modelId);
}

/** The model for a role. Same object works for `generateText` and for a Mastra `Agent`. */
export function getModel(role: Role, env: Env = process.env): GemmaModel {
  return modelFromConfig(resolveModelConfig(role, env), env);
}

/** JSON-serialisable provider options (the shape of AI SDK `providerOptions`). */
export type ProviderOptions = Record<string, Record<string, JsonValue>>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Provider options for a role's thinking level. Google: `google.thinkingConfig.thinkingLevel`
 * (always sent, because Gemma thinks by default). Ollama: `reasoning_effort` ("none" turns
 * thinking off; a laptop model that thinks before every photo check is far too slow).
 * Pass the result as `providerOptions` to `generateText` or to `agent.generate`.
 */
export function providerOptionsFor(config: ModelConfig): ProviderOptions {
  if (config.provider === "google") {
    return { google: { thinkingConfig: { thinkingLevel: config.thinking } } };
  }
  return { ollama: { reasoningEffort: config.thinking === "minimal" ? "none" : "high" } };
}

/** A short label for logs and traces, e.g. `google/gemma-4-31b-it`. */
export function modelLabel(config: ModelConfig): string {
  return `${config.provider}/${config.modelId}`;
}
