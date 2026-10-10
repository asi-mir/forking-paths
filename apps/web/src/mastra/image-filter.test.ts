import type { AnySpan } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import { IMAGE_REDACTED, imageFilter } from "./image-filter";

function fakeSpan(input: unknown, output: unknown): AnySpan {
  return { id: "s1", traceId: "t1", name: "agent run", input, output } as unknown as AnySpan;
}

describe("imageFilter", () => {
  it("redacts an input that holds an image file part", () => {
    const span = fakeSpan(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Which detail is this?" },
            { type: "file", mediaType: "image/jpeg", data: "/9j/4AAQSkZJRg" },
          ],
        },
      ],
      { text: "The lion's head." },
    );
    const out = imageFilter.process(span) as unknown as { input: unknown; output: unknown };
    expect(out.input).toBe(IMAGE_REDACTED);
    expect(out.output).toEqual({ text: "The lion's head." });
  });

  it("redacts an output that holds image data", () => {
    const span = fakeSpan("describe", { image: "data:image/png;base64,iVBOR" });
    const out = imageFilter.process(span) as unknown as { input: unknown; output: unknown };
    expect(out.input).toBe("describe");
    expect(out.output).toBe(IMAGE_REDACTED);
  });

  it("leaves a text span untouched", () => {
    const input = [{ role: "user", content: "Write a clue about the fountain." }];
    const output = { text: "Look for the stone lion." };
    const out = imageFilter.process(fakeSpan(input, output)) as unknown as {
      input: unknown;
      output: unknown;
    };
    expect(out.input).toBe(input);
    expect(out.output).toBe(output);
    expect(imageFilter.process(undefined)).toBeUndefined();
  });
});
