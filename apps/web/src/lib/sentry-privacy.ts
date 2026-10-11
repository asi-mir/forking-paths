import type { NodeOptions } from "@sentry/nextjs";
import { IMAGE_ATTRIBUTE, traceState } from "./trace-state";

/**
 * Shared Sentry settings for the server, edge and browser SDKs: what we collect, and the span
 * hook that keeps photos out of traces. No SDK runtime import, so it is unit-tested directly.
 */

type BeforeSendSpan = NonNullable<NodeOptions["beforeSendSpan"]>;
export type StreamedSpan = Parameters<BeforeSendSpan>[0];
type DataCollection = NonNullable<NodeOptions["dataCollection"]>;

/** Every trace is kept: traffic is small and every walk matters. */
export const TRACES_SAMPLE_RATE = 1.0;

/** Paths whose requests are never traced: the host's health check, every few seconds. */
export const UNTRACED_PATHS: readonly string[] = ["/api/health"];

/** What `tracesSampler` reads from Sentry's sampling context (a subset, so tests can build one). */
export type SamplingInput = {
  name?: string;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string };
  inheritOrSampleWith?: (fallbackSampleRate: number) => number;
};

const PATH_ATTRIBUTES = ["url.path", "http.target", "http.route", "next.route", "url.full", "http.url"] as const;

function pathOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const bare = stripQuery(value);
  if (/^https?:\/\//i.test(bare)) {
    try {
      return new URL(bare).pathname;
    } catch {
      return undefined;
    }
  }
  return bare.startsWith("/") ? bare : undefined;
}

/** True when a span being sampled is a request to an untraced path (by URL, route or name). */
export function isUntracedRequest(ctx: SamplingInput): boolean {
  const paths = [pathOf(ctx.normalizedRequest?.url), ...PATH_ATTRIBUTES.map((k) => pathOf(ctx.attributes?.[k]))];
  const name = ctx.name?.trim() ?? "";
  return UNTRACED_PATHS.some(
    (p) => paths.some((x) => x === p || x === `${p}/`) || name === p || name.endsWith(` ${p}`),
  );
}

/**
 * The server's `tracesSampler`: drops the health check's traces (about six spans per ping, which
 * would bury the walks), and keeps every other trace at `TRACES_SAMPLE_RATE`. A name filter
 * (`ignoreSpans`) is not enough: the request's root span is still named "GET" when it is sampled.
 */
export function sampleTrace(ctx: SamplingInput): number {
  if (isUntracedRequest(ctx)) return 0;
  return ctx.inheritOrSampleWith ? ctx.inheritOrSampleWith(TRACES_SAMPLE_RATE) : TRACES_SAMPLE_RATE;
}

/**
 * No personal data: no user fields, cookies, headers, query strings, request or response bodies,
 * database payloads or local variables. Gen-AI prompts and outputs stay on (quest generation is
 * public text); `prepareSpan` drops them for any trace that carries a photo.
 */
export const DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
  genAI: { inputs: true, outputs: true },
};

/** Gen-AI attributes that hold message content (prompts, outputs, tool arguments and results). */
export const GEN_AI_CONTENT_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.prompt",
  "gen_ai.request.messages",
  "gen_ai.response.text",
  "gen_ai.response.object",
  "gen_ai.response.tool_calls",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.input",
  "gen_ai.tool.output",
  "gen_ai.tool.message",
  "gen_ai.system.message",
  "gen_ai.embeddings.input",
] as const;

export const REDACTED = "[redacted: image]";

/** Set by the SDK on every streamed span before `beforeSendSpan`: the id of its request's root span. */
export const SEGMENT_ID_ATTRIBUTE = "sentry.segment.id";

/** URL attributes whose query string is cut (a query can hold the player's position). */
export const URL_KEYS = ["http.target", "http.url", "url.full", "url"] as const;
/** Attributes that hold only a query string or fragment; dropped. */
export const QUERY_KEYS = ["http.query", "url.query", "http.fragment", "url.fragment"] as const;

/** `value` without its query string and fragment. */
export function stripQuery(value: string): string {
  return value.replace(/[?#][\s\S]*$/, "");
}

/**
 * True when a serialised value looks like it holds image bytes: a data URL, an AI SDK image part,
 * an image media type, or a long base64 run. The backstop for a photo call that forgot
 * `image: true`.
 */
export function looksLikeImage(value: string): boolean {
  if (value.includes("data:image/")) return true;
  if (/"type"\s*:\s*"image"/.test(value)) return true;
  if (/"(?:mediaType|mimeType|mime_type)"\s*:\s*"image\//.test(value)) return true;
  return /[A-Za-z0-9+/]{2000,}/.test(value);
}

/** An attribute's string value, raw or wrapped as `{ value }`. */
function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

/**
 * `beforeSendSpan` hook (span streaming format), used by the server, edge and browser SDKs.
 * - Cut query strings from URLs: a query can carry the player's position.
 * - In a request marked as carrying an image, drop every gen-AI content attribute.
 * - Anywhere else, replace a content attribute that still looks like image data.
 * - Copy our tags (role, questId, ...) onto spans of the request that lack them, so the Mastra and
 *   AI SDK spans can be filtered by quest and role.
 */
export function prepareSpan(span: StreamedSpan): StreamedSpan {
  const attributes: Record<string, unknown> = span.attributes ?? {};

  for (const key of QUERY_KEYS) delete attributes[key];
  for (const key of URL_KEYS) {
    const text = stringValue(attributes[key]);
    if (text !== undefined) attributes[key] = stripQuery(text);
  }
  if (span.name.includes("?") || span.name.includes("#")) span.name = stripQuery(span.name);

  // Look up by the span's request (segment): one trace can hold several requests.
  const state = traceState({
    traceId: span.trace_id,
    segmentId: stringValue(attributes[SEGMENT_ID_ATTRIBUTE]),
  });
  const imageTrace = state?.image === true || stringOrBool(attributes[IMAGE_ATTRIBUTE]) === true;

  for (const key of GEN_AI_CONTENT_KEYS) {
    if (!(key in attributes)) continue;
    if (imageTrace) {
      delete attributes[key];
      continue;
    }
    const text = stringValue(attributes[key]);
    if (text !== undefined && looksLikeImage(text)) attributes[key] = REDACTED;
  }

  if (state) {
    for (const [key, value] of Object.entries(state.tags)) {
      if (attributes[key] === undefined) attributes[key] = value;
    }
    if (state.image && attributes[IMAGE_ATTRIBUTE] === undefined) {
      attributes[IMAGE_ATTRIBUTE] = true;
    }
  }

  span.attributes = attributes as StreamedSpan["attributes"];
  return span;
}

function stringOrBool(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) return (value as { value: unknown }).value;
  return value;
}
