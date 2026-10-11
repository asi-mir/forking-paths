import { beforeEach, describe, expect, it } from "vitest";
import { aiTelemetry, currentTraceId, mastraTracing, setTraceTags, withSpan } from "./trace";
import { clearTraceState, rememberTrace, tagAttributes, traceState } from "./trace-state";

beforeEach(() => clearTraceState());

describe("withSpan without a Sentry client", () => {
  it("runs sync work and returns its value", () => {
    expect(withSpan("sync", { role: "writer" }, () => 42)).toBe(42);
  });

  it("runs async work and passes errors through", async () => {
    await expect(withSpan("ok", { role: "reader" }, async () => "done")).resolves.toBe("done");
    await expect(
      withSpan("fails", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("records tags under the request's root span", () => {
    withSpan("outer", { role: "writer" }, (outer) => {
      withSpan("inner", { questId: "q1" }, () => undefined);
      const { traceId, spanId } = outer.spanContext();
      expect(traceState({ traceId, segmentId: spanId })?.tags).toMatchObject({ role: "writer" });
    });
  });

  it("does not throw when there is no active span", () => {
    expect(() => setTraceTags({ questId: "q1" })).not.toThrow();
    expect(currentTraceId()).toBeUndefined();
  });
});

describe("trace state", () => {
  it("keeps only non-empty tags", () => {
    expect(tagAttributes({ role: "writer", questId: "", provider: "ollama" })).toEqual({
      role: "writer",
      provider: "ollama",
    });
  });

  it("merges tags and never turns the image flag off", () => {
    rememberTrace("t1", { role: "reader" }, true);
    rememberTrace("t1", { questId: "q1" });
    expect(traceState("t1")).toEqual({ tags: { role: "reader", questId: "q1" }, image: true });
  });

  it("keeps each request's state apart inside one trace", () => {
    rememberTrace({ traceId: "t1", segmentId: "s1" }, { role: "writer", questId: "q1" });
    rememberTrace({ traceId: "t1", segmentId: "s2" }, { role: "reader" }, true);
    expect(traceState({ traceId: "t1", segmentId: "s1" })).toEqual({
      tags: { role: "writer", questId: "q1" },
      image: false,
    });
    expect(traceState({ traceId: "t1", segmentId: "s2" })).toEqual({
      tags: { role: "reader" },
      image: true,
    });
    // Without a known segment, the trace's merged state applies (image flag on).
    expect(traceState({ traceId: "t1", segmentId: "s3" })?.image).toBe(true);
    expect(traceState("t1")?.image).toBe(true);
  });

  it("keeps at most 1000 entries, dropping the oldest", () => {
    for (let i = 0; i < 1010; i++) rememberTrace(`t${i}`, { runId: String(i) });
    expect(traceState("t0")).toBeUndefined();
    expect(traceState("t9")).toBeUndefined();
    expect(traceState("t10")?.tags.runId).toBe("10");
    expect(traceState("t1009")?.tags.runId).toBe("1009");
  });
});

describe("call options", () => {
  it("hides Mastra inputs and outputs only for image calls", () => {
    expect(mastraTracing({ role: "writer", questId: "q1" })).toEqual({
      metadata: { role: "writer", questId: "q1" },
      tags: ["writer"],
    });
    expect(mastraTracing({ role: "reader" }, { image: true })).toMatchObject({
      hideInput: true,
      hideOutput: true,
    });
  });

  it("turns AI SDK recording off only for image calls", () => {
    expect(aiTelemetry("writer")).toEqual({ functionId: "writer", recordInputs: true, recordOutputs: true });
    expect(aiTelemetry("reader", { image: true })).toEqual({
      functionId: "reader",
      recordInputs: false,
      recordOutputs: false,
    });
  });
});
