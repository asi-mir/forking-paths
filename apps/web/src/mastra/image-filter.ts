import type { AnySpan, SpanOutputProcessor } from "@mastra/core/observability";
import { containsImage } from "../lib/image-guard";

export const IMAGE_REDACTED = "[redacted: image]";

/**
 * Span output processor: replaces any span input or output that holds an image before it
 * reaches an exporter (Mastra storage in MongoDB, Sentry). Photos are used for the check and
 * never stored. The photo check should still pass `mastraTracing(..., { image: true })`; this
 * is the backstop.
 */
export const imageFilter: SpanOutputProcessor = {
  name: "image-filter",
  process(span?: AnySpan) {
    if (!span) return span;
    const s = span as { input?: unknown; output?: unknown };
    if (s.input !== undefined && containsImage(s.input)) s.input = IMAGE_REDACTED;
    if (s.output !== undefined && containsImage(s.output)) s.output = IMAGE_REDACTED;
    return span;
  },
  async shutdown() {},
};
