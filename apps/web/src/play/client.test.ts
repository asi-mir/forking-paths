import { describe, expect, it } from "vitest";
import { mockRequested } from "./client";

describe("mockRequested", () => {
  it("honours ?mock=1 in development", () => {
    expect(mockRequested("?mock=1", { nodeEnv: "development" })).toBe(true);
    expect(mockRequested("", { nodeEnv: "development" })).toBe(false);
  });

  it("ignores ?mock=1 in a production build", () => {
    expect(mockRequested("?mock=1", { nodeEnv: "production" })).toBe(false);
  });

  it("plays the mock in production only when NEXT_PUBLIC_MOCK_API=1 at build time", () => {
    expect(mockRequested("", { nodeEnv: "production", mockApi: "1" })).toBe(true);
    expect(mockRequested("?mock=1", { nodeEnv: "production", mockApi: "0" })).toBe(false);
  });
});
