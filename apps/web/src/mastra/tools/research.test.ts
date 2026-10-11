import { afterEach, describe, expect, it, vi } from "vitest";
import { setStore } from "@/lib/store";
import { createMemoryStore } from "@/lib/store/memory";
import { fakeFetch, KARAKOY } from "@/research/__fixtures__";
import { placeFacts, placesNearby, researchTools, wikiNearby } from "./index";

/** A tool's result, or a failure when it returned nothing or a validation error. */
function ok<T extends object>(out: T | void): Exclude<T, { error: unknown }> {
  if (!out || "error" in out) throw new Error("tool failed");
  return out as Exclude<T, { error: unknown }>;
}

afterEach(() => {
  setStore(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("research tools", () => {
  it("are Mastra tools with the ids the writer sees", () => {
    expect(Object.keys(researchTools)).toEqual(["placesNearby", "placeFacts", "wikiNearby"]);
    expect([placesNearby.id, placeFacts.id, wikiNearby.id]).toEqual(["placesNearby", "placeFacts", "wikiNearby"]);
  });

  it("wikiNearby returns places and cited facts (recorded response, no network)", async () => {
    setStore(createMemoryStore());
    vi.stubGlobal("fetch", fakeFetch());
    const out = ok(await wikiNearby.execute!({ ...KARAKOY, lang: "en", radiusM: 900 }, {} as never));
    expect(out.places.length).toBeGreaterThan(5);
    expect(out.facts.every((f) => f.sourceUrl.startsWith("https://en.wikipedia.org/") && f.query)).toBe(true);
    expect(out.serpapiSearches).toBe(0);
  });

  it("placesNearby without a SerpApi key makes no request and says why", async () => {
    setStore(createMemoryStore());
    vi.stubEnv("SERPAPI_API_KEY", "");
    const out = ok(await placesNearby.execute!({ ...KARAKOY, lang: "en", radiusM: 900, minutes: 25 }, {} as never));
    expect(out).toMatchObject({ places: [], facts: [], serpapiSearches: 0 });
  });
});
