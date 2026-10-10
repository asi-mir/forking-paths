import * as Sentry from "@sentry/nextjs";
import type { TracingOptions } from "@mastra/core/observability";
import {
  IMAGE_ATTRIBUTE,
  rememberTrace,
  tagAttributes,
  type TagAttributes,
  type TraceKey,
  type TraceRole,
  type TraceTags,
} from "./trace-state";

export type { TraceRole, TraceTags } from "./trace-state";

/**
 * Small tracing helpers on top of Sentry. Without a DSN the SDK is never initialised and every
 * helper here is a cheap no-op: the work still runs, nothing is recorded or sent.
 *
 * Tags set here go on our own span and are copied onto the Mastra / AI SDK spans of the same
 * trace (`prepareSpan` in `sentry-privacy.ts`), so agent runs can be filtered by quest or role.
 */

export interface SpanOptions {
  /** Sentry span op. Defaults to `function`. */
  op?: string;
  /**
   * The work sends an image (the photo check). Prompts and outputs of every gen-AI span in this
   * request are then dropped before they leave the server.
   */
  image?: boolean;
}

/** The span's trace and its request's root span, the key for tags and the image flag. */
function keyOf(span: Sentry.Span): TraceKey {
  return {
    traceId: span.spanContext().traceId,
    segmentId: Sentry.getRootSpan(span).spanContext().spanId,
  };
}

function attributesFor(tags: TraceTags, image?: boolean): TagAttributes {
  const attributes = tagAttributes(tags);
  if (image) attributes[IMAGE_ATTRIBUTE] = true;
  return attributes;
}

/**
 * Run `fn` inside a named span tagged with `tags`. Works with sync and async work; the span ends
 * when the returned promise settles, and a thrown error marks it as failed.
 *
 *   await withSpan("quest.generate", { role: "writer", provider, model }, () => generate(...));
 */
export function withSpan<T>(
  name: string,
  tags: TraceTags,
  fn: (span: Sentry.Span) => T,
  options: SpanOptions = {},
): T {
  return Sentry.startSpan(
    { name, op: options.op ?? "function", attributes: attributesFor(tags, options.image) },
    (span) => {
      rememberTrace(keyOf(span), tags, options.image);
      return fn(span);
    },
  );
}

/** Add tags to the active span and its request (e.g. once the quest id is known). */
export function setTraceTags(tags: TraceTags, options: Pick<SpanOptions, "image"> = {}): void {
  const span = Sentry.getActiveSpan();
  if (!span) return;
  span.setAttributes(attributesFor(tags, options.image));
  rememberTrace(keyOf(span), tags, options.image);
}

/** The active trace id, to log next to a run so a walk can be matched with its trace. */
export function currentTraceId(): string | undefined {
  const traceId = Sentry.getActiveSpan()?.spanContext().traceId;
  return traceId && !/^0+$/.test(traceId) ? traceId : undefined;
}

/**
 * `tracingOptions` for a Mastra agent or workflow call. With `image`, Mastra hides inputs and
 * outputs on every span of the call, so the photo never reaches an exporter.
 *
 *   await reader.generate(messages, {
 *     tracingOptions: mastraTracing({ role: "reader", questId }, { image: true }),
 *   });
 */
export function mastraTracing(
  tags: TraceTags,
  options: Pick<SpanOptions, "image"> = {},
): TracingOptions {
  const tracing: TracingOptions = { metadata: tagAttributes(tags) };
  if (tags.role) tracing.tags = [tags.role];
  if (options.image) {
    tracing.hideInput = true;
    tracing.hideOutput = true;
  }
  return tracing;
}

/**
 * `telemetry` settings for a direct AI SDK call (`generateText`, `streamText`, ...). Text calls
 * record prompts and outputs; a call that carries an image records neither.
 */
export function aiTelemetry(
  role: TraceRole,
  options: Pick<SpanOptions, "image"> = {},
): { functionId: string; recordInputs: boolean; recordOutputs: boolean } {
  return { functionId: role, recordInputs: !options.image, recordOutputs: !options.image };
}
