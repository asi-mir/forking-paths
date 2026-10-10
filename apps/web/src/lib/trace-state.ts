/**
 * Per-request tags and the "carries an image" flag, shared by the tracing helpers (`trace.ts`) and
 * the Sentry span hook (`sentry-privacy.ts`). No SDK import.
 */

export type TraceRole = "writer" | "reader" | "narrator" | "research" | (string & {});

export interface TraceTags {
  /** Gemma provider: `google` or `ollama`. */
  provider?: string;
  /** Model id, e.g. `gemma-4-31b-it`. */
  model?: string;
  role?: TraceRole;
  questId?: string;
  runId?: string;
  placeId?: string;
}

export const TAG_KEYS = ["provider", "model", "role", "questId", "runId", "placeId"] as const;

/** Span attribute that marks a trace whose model calls carry an image. */
export const IMAGE_ATTRIBUTE = "has_image";

export type TagAttributes = Record<string, string | boolean>;

export interface TraceState {
  tags: TagAttributes;
  image: boolean;
}

/** One entry per request (segment) and one per trace; the newest 1000 entries are kept. */
const MAX_ENTRIES = 1000;

/**
 * Where a span belongs: its trace, and the segment (the request's root span) inside it. One
 * trace can hold several requests (a browser page view that continues into each API call), so
 * state is kept per segment, with the trace as a fallback for spans whose segment is unknown.
 */
export interface TraceKey {
  traceId: string;
  segmentId?: string;
}

/**
 * Segment or trace key -> state. Kept on `globalThis` because Next.js loads the Sentry config
 * (instrumentation) and the route handlers in separate bundles, which would otherwise each get
 * their own copy of this module.
 */
function store(): Map<string, TraceState> {
  const key = Symbol.for("forking-paths.trace-state");
  const g = globalThis as unknown as Record<symbol, Map<string, TraceState> | undefined>;
  return (g[key] ??= new Map());
}

function normalise(key: string | TraceKey): TraceKey {
  return typeof key === "string" ? { traceId: key } : key;
}

/** Tags without empty values, as span attributes. */
export function tagAttributes(tags: TraceTags): TagAttributes {
  const out: TagAttributes = {};
  for (const key of TAG_KEYS) {
    const value = tags[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

function merge(storeKey: string, tags: TraceTags, image: boolean): void {
  const entries = store();
  const prev = entries.get(storeKey);
  entries.delete(storeKey);
  entries.set(storeKey, {
    tags: { ...prev?.tags, ...tagAttributes(tags) },
    image: Boolean(prev?.image || image),
  });
}

/**
 * Record tags (and the image flag) for a request's segment and its trace. Newer tag values win;
 * the image flag only turns on.
 */
export function rememberTrace(key: string | TraceKey, tags: TraceTags, image = false): void {
  const { traceId, segmentId } = normalise(key);
  if (!traceId) return;
  if (segmentId) merge(`s:${segmentId}`, tags, image);
  merge(`t:${traceId}`, tags, image);
  const entries = store();
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * What we know about a span's request: its segment's state when the segment was recorded,
 * otherwise its trace's state, if anything.
 */
export function traceState(key: string | TraceKey): Readonly<TraceState> | undefined {
  const { traceId, segmentId } = normalise(key);
  const entries = store();
  if (segmentId) {
    const segment = entries.get(`s:${segmentId}`);
    if (segment) return segment;
  }
  return traceId ? entries.get(`t:${traceId}`) : undefined;
}

/** Test helper: forget every trace. */
export function clearTraceState(): void {
  store().clear();
}
