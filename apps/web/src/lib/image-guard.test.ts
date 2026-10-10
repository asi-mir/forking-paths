import { describe, expect, it } from "vitest";
import { containsImage } from "./image-guard";

describe("containsImage", () => {
  it("finds image parts, data URLs, image media types and raw bytes", () => {
    expect(containsImage([{ role: "user", content: [{ type: "image", image: "x" }] }])).toBe(true);
    expect(containsImage({ messages: [{ content: "data:image/jpeg;base64,/9j/" }] })).toBe(true);
    expect(containsImage({ type: "file", mediaType: "image/webp", data: "x" })).toBe(true);
    expect(containsImage({ part: new Uint8Array([255, 216]) })).toBe(true);
  });

  it("ignores text and non-image files", () => {
    expect(containsImage([{ role: "user", content: "Write a clue about the fountain." }])).toBe(false);
    expect(containsImage({ type: "file", mediaType: "application/pdf", data: "x" })).toBe(false);
    expect(containsImage(undefined)).toBe(false);
  });

  it("survives cycles", () => {
    const a: Record<string, unknown> = { text: "hi" };
    a.self = a;
    expect(containsImage(a)).toBe(false);
  });

  it("fails closed on values too deep or too large to walk", () => {
    let deep: Record<string, unknown> = { text: "bottom" };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(containsImage(deep)).toBe(true);

    const history = Array.from({ length: 30000 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    history.push({ role: "user", content: [{ type: "image", image: "x" }] } as never);
    expect(containsImage(history)).toBe(true);
  });

  it("walks an ordinary message history in full", () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `turn ${i}` }],
    }));
    expect(containsImage(history)).toBe(false);
  });
});
