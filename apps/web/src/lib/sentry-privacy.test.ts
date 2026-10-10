import { beforeEach, describe, expect, it } from "vitest";
import {
  DATA_COLLECTION,
  GEN_AI_CONTENT_KEYS,
  REDACTED,
  SEGMENT_ID_ATTRIBUTE,
  TRACES_SAMPLE_RATE,
  looksLikeImage,
  prepareSpan,
  stripQuery,
  type StreamedSpan,
} from "./sentry-privacy";
import { IMAGE_ATTRIBUTE, clearTraceState, rememberTrace } from "./trace-state";

const TRACE = "a".repeat(32);
const OTHER = "b".repeat(32);

function span(attributes: Record<string, unknown>, traceId = TRACE): StreamedSpan {
  return {
    trace_id: traceId,
    span_id: "1".repeat(16),
    name: "chat gemma-4-26b-a4b-it",
    start_timestamp: 1,
    end_timestamp: 2,
    status: "ok",
    is_segment: false,
    attributes,
  } as StreamedSpan;
}

const textMessages = JSON.stringify([{ role: "user", content: "Write a clue about the fountain." }]);
const imageMessages = JSON.stringify([
  {
    role: "user",
    content: [
      { type: "text", text: "What detail is this?" },
      { type: "image", image: "data:image/jpeg;base64,/9j/4AAQSkZJRg" },
    ],
  },
]);

beforeEach(() => clearTraceState());

describe("privacy settings", () => {
  it("samples every trace and collects no personal data", () => {
    expect(TRACES_SAMPLE_RATE).toBe(1);
    expect(DATA_COLLECTION.userInfo).toBe(false);
    expect(DATA_COLLECTION.cookies).toBe(false);
    expect(DATA_COLLECTION.httpBodies).toEqual([]);
    expect(DATA_COLLECTION.httpHeaders).toEqual({ request: false, response: false });
    expect(DATA_COLLECTION.genAI).toEqual({ inputs: true, outputs: true });
  });
});

describe("looksLikeImage", () => {
  it("spots data URLs, image parts, image media types and long base64", () => {
    expect(looksLikeImage("see data:image/png;base64,iVBOR")).toBe(true);
    expect(looksLikeImage('{"type": "image", "image": "x"}')).toBe(true);
    expect(looksLikeImage('{"type":"file","mediaType":"image/jpeg","data":"x"}')).toBe(true);
    expect(looksLikeImage("A".repeat(2500))).toBe(true);
  });

  it("leaves ordinary prompts alone", () => {
    expect(looksLikeImage(textMessages)).toBe(false);
    expect(looksLikeImage("The image of the city changed after 1890.")).toBe(false);
  });
});

describe("prepareSpan", () => {
  it("keeps prompts and outputs of a text call", () => {
    const out = prepareSpan(
      span({ "gen_ai.input.messages": textMessages, "gen_ai.response.text": "Look for the lion." }),
    );
    expect(out.attributes["gen_ai.input.messages"]).toBe(textMessages);
    expect(out.attributes["gen_ai.response.text"]).toBe("Look for the lion.");
  });

  it("drops every content attribute in a trace marked as carrying an image", () => {
    rememberTrace(TRACE, { role: "reader" }, true);
    const attributes: Record<string, unknown> = {
      "gen_ai.request.model": "gemma-4-26b-a4b-it",
      "gen_ai.usage.input_tokens": 812,
      "gen_ai.usage.output_tokens": 40,
    };
    for (const key of GEN_AI_CONTENT_KEYS) attributes[key] = "plain text, no picture";
    const out = prepareSpan(span(attributes));
    for (const key of GEN_AI_CONTENT_KEYS) expect(out.attributes).not.toHaveProperty(key);
    expect(out.attributes["gen_ai.request.model"]).toBe("gemma-4-26b-a4b-it");
    expect(out.attributes["gen_ai.usage.input_tokens"]).toBe(812);
    expect(out.attributes[IMAGE_ATTRIBUTE]).toBe(true);
  });

  it("drops content when the span itself carries the image flag", () => {
    const out = prepareSpan(span({ [IMAGE_ATTRIBUTE]: true, "gen_ai.input.messages": textMessages }));
    expect(out.attributes).not.toHaveProperty("gen_ai.input.messages");
  });

  it("redacts image data that slipped into an unmarked trace", () => {
    const out = prepareSpan(
      span(
        { "gen_ai.input.messages": imageMessages, "gen_ai.tool.call.arguments": { value: imageMessages } },
        OTHER,
      ),
    );
    expect(out.attributes["gen_ai.input.messages"]).toBe(REDACTED);
    expect(out.attributes["gen_ai.tool.call.arguments"]).toBe(REDACTED);
  });

  it("copies the trace's tags onto spans that lack them", () => {
    rememberTrace(TRACE, { role: "writer", questId: "q1", provider: "google", model: "" });
    const out = prepareSpan(span({ role: "kept" }));
    expect(out.attributes.role).toBe("kept");
    expect(out.attributes.questId).toBe("q1");
    expect(out.attributes.provider).toBe("google");
    expect(out.attributes).not.toHaveProperty("model");
    expect(out.attributes).not.toHaveProperty(IMAGE_ATTRIBUTE);
  });

  it("cuts query strings from URLs and span names", () => {
    const s = span({
      "http.target": "/api/quest?lat=41.0256&lng=28.9744",
      "url.full": "http://localhost:3000/api/quest?lat=41.0256#x",
      "http.query": "lat=41.0256&lng=28.9744",
      "http.route": "/api/quest",
    });
    s.name = "GET /api/quest?lat=41.0256";
    const out = prepareSpan(s);
    expect(out.attributes["http.target"]).toBe("/api/quest");
    expect(out.attributes["url.full"]).toBe("http://localhost:3000/api/quest");
    expect(out.attributes).not.toHaveProperty("http.query");
    expect(out.attributes["http.route"]).toBe("/api/quest");
    expect(out.name).toBe("GET /api/quest");
    expect(stripQuery("/a/b")).toBe("/a/b");
  });

  it("does not leak tags or the image flag across traces", () => {
    rememberTrace(TRACE, { questId: "q1" }, true);
    const out = prepareSpan(span({ "gen_ai.input.messages": textMessages }, OTHER));
    expect(out.attributes["gen_ai.input.messages"]).toBe(textMessages);
    expect(out.attributes).not.toHaveProperty("questId");
  });

  it("keeps tags and the image flag to their own request when requests share a trace", () => {
    const writerRequest = "c".repeat(16);
    const checkRequest = "d".repeat(16);
    rememberTrace({ traceId: TRACE, segmentId: writerRequest }, { role: "writer", questId: "q1" });
    rememberTrace({ traceId: TRACE, segmentId: checkRequest }, { role: "reader", questId: "q2" }, true);

    const writer = prepareSpan(
      span({ [SEGMENT_ID_ATTRIBUTE]: writerRequest, "gen_ai.input.messages": textMessages }),
    );
    expect(writer.attributes["gen_ai.input.messages"]).toBe(textMessages);
    expect(writer.attributes.role).toBe("writer");
    expect(writer.attributes.questId).toBe("q1");
    expect(writer.attributes).not.toHaveProperty(IMAGE_ATTRIBUTE);

    const check = prepareSpan(
      span({ [SEGMENT_ID_ATTRIBUTE]: { value: checkRequest }, "gen_ai.input.messages": textMessages }),
    );
    expect(check.attributes).not.toHaveProperty("gen_ai.input.messages");
    expect(check.attributes.role).toBe("reader");
    expect(check.attributes.questId).toBe("q2");
    expect(check.attributes[IMAGE_ATTRIBUTE]).toBe(true);
  });

  it("falls back to the trace for a span whose request is unknown, keeping the image flag", () => {
    rememberTrace({ traceId: TRACE, segmentId: "e".repeat(16) }, { role: "reader" }, true);
    const out = prepareSpan(
      span({ [SEGMENT_ID_ATTRIBUTE]: "f".repeat(16), "gen_ai.input.messages": textMessages }),
    );
    expect(out.attributes).not.toHaveProperty("gen_ai.input.messages");
    expect(out.attributes.role).toBe("reader");
  });
});
