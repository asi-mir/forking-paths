import { describe, expect, it } from "vitest";
import { budgetStatus } from "@/lib/budget";
import { CandidateSchema, FactSchema } from "@/quest/schema";
import { env, KARAKOY, testDeps } from "./__fixtures__";
import { mergePlaces, research, samePlace, searchPicks } from "./index";
import type { FoundPlace } from "./types";

const place = (over: Partial<FoundPlace>): FoundPlace => ({
  key: "k",
  name: "Place",
  altNames: [],
  location: KARAKOY,
  distanceM: 0,
  sourceUrl: "https://example.org/p",
  sources: ["serpapi-maps"],
  types: [],
  gated: false,
  ...over,
});

describe("research (recorded Karaköy responses)", () => {
  it("returns ≥ 6 candidates within 900 m, each with a fact that has its query and link, using ≤ 6 searches", async () => {
    const { deps, getJson } = testDeps();
    const r = await research({ ...KARAKOY, timeZone: "Europe/Istanbul" }, deps);

    expect(r.candidates.length).toBeGreaterThanOrEqual(6);
    expect(r.candidates.length).toBeLessThanOrEqual(8);
    const facts = new Map(r.facts.map((f) => [f.id, f]));
    for (const c of r.candidates) {
      expect(CandidateSchema.safeParse(c).success).toBe(true);
      expect(c.distanceM).toBeLessThanOrEqual(900);
      expect(c.factIds.length).toBeGreaterThan(0);
      for (const id of c.factIds) {
        const f = facts.get(id)!;
        expect(f.placeId).toBe(c.id);
        expect(f.query.length).toBeGreaterThan(0);
        expect(f.sourceUrl).toMatch(/^https?:\/\//);
      }
    }
    expect(r.stats.serpapiSearches).toBe(6);
    expect(getJson.calls).toHaveLength(6);
    expect(getJson.calls.filter((c) => c.engine === "google_maps")).toHaveLength(2);
    expect(getJson.calls.filter((c) => c.engine === "google")).toHaveLength(4);
    expect(r.lookups.filter((l) => l.outcome === "fetched")).toHaveLength(7); // + Wikipedia
  });

  it("numbers places P1…Pn and facts F1…Fn, and every fact passes the schema", async () => {
    const r = await research(KARAKOY, testDeps().deps);
    expect(r.candidates.map((c) => c.id)).toEqual(r.candidates.map((_, i) => `P${i + 1}`));
    expect(r.facts.map((f) => f.id)).toEqual(r.facts.map((_, i) => `F${i + 1}`));
    for (const f of r.facts) expect(FactSchema.safeParse(f).success).toBe(true);
    // No fact is given twice (search snippets often copy the Wikipedia sentence).
    expect(new Set(r.facts.map((f) => f.text)).size).toBe(r.facts.length);
  });

  it("finds places Wikipedia does not have, and counts them", async () => {
    const r = await research(KARAKOY, testDeps().deps);
    const names = r.candidates.map((c) => c.name);
    expect(names).toContain("Galata Tower"); // not in the English GeoSearch result
    expect(r.stats.serpapiOnlyCandidates).toBe(r.candidates.filter((c) => !c.sources.includes("wikipedia")).length);
    expect(r.stats.serpapiOnlyCandidates).toBeGreaterThan(0);
    expect(r.stats.placesFound.wikipedia).toBeGreaterThan(0);
    expect(r.stats.placesFound.maps).toBeGreaterThan(0);
  });

  it("searches the places with the fewest facts, never generic names", async () => {
    const { deps, getJson } = testDeps();
    await research(KARAKOY, deps);
    const searched = getJson.calls.filter((c) => c.engine === "google").map((c) => String(c.q));
    expect(searched).toContain("Galata Tower İstanbul history");
    expect(searched.some((q) => q.startsWith("Tarihi"))).toBe(false);
  });

  it("a second quest nearby makes no SerpApi search: everything comes from the cache", async () => {
    const { deps, getJson } = testDeps();
    await research(KARAKOY, deps);
    const again = await research({ lat: 41.0248, lng: 28.9743 }, deps); // same ~100 m cell
    expect(again.stats).toMatchObject({ serpapiSearches: 0, serpapiCacheHits: 6 });
    expect(getJson.calls).toHaveLength(6);
    expect((await budgetStatus("serpapi", { store: deps.store, env: deps.env, now: deps.now })).used).toBe(6);
  });

  it("takes searches from the daily budget and stops cleanly over the cap", async () => {
    const { deps, getJson } = testDeps({ env: env({ SERPAPI_API_KEY: "test-serpapi-key-123456", BUDGET_SERPAPI_PER_DAY: "3" }) });
    const r = await research(KARAKOY, deps);
    expect(getJson.calls).toHaveLength(3);
    expect(r.stats).toMatchObject({ serpapiSearches: 3, serpapiLimited: "budget" });
    expect(r.candidates.length).toBeGreaterThan(0); // Wikipedia still answers
  });

  it("honours a lower per-quest cap", async () => {
    const { deps, getJson } = testDeps();
    const r = await research({ ...KARAKOY, maxSerpapiSearches: 2 }, deps);
    expect(getJson.calls).toHaveLength(2);
    expect(r.stats).toMatchObject({ serpapiSearches: 2, serpapiLimited: "cap" });
  });

  it("works without a SerpApi key (Wikipedia only) and makes no SerpApi request", async () => {
    const { deps, getJson } = testDeps({ env: env({}) });
    const r = await research(KARAKOY, deps);
    expect(getJson.calls).toHaveLength(0);
    expect(r.stats).toMatchObject({ serpapiSearches: 0, serpapiLimited: "no-key" });
    expect(r.candidates.length).toBeGreaterThanOrEqual(6);
    expect(r.candidates.every((c) => c.sources.includes("wikipedia"))).toBe(true);
  });

  it("'maps' mode searches Maps only; 'off' uses Wikipedia only (coverage evals)", async () => {
    const maps = testDeps();
    const rm = await research({ ...KARAKOY, serpapi: "maps" }, maps.deps);
    expect(maps.getJson.calls.map((c) => c.engine)).toEqual(["google_maps", "google_maps"]);
    expect(rm.stats.serpapiSearches).toBe(2);

    const off = testDeps();
    const ro = await research({ ...KARAKOY, serpapi: "off" }, off.deps);
    expect(off.getJson.calls).toHaveLength(0);
    expect(ro.stats.serpapiLimited).toBe("off");
  });

  it("goes on with Maps when Wikipedia is down", async () => {
    const { deps } = testDeps({ fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
    const r = await research(KARAKOY, deps);
    expect(r.warnings.some((w) => w.includes("wikipedia"))).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.sources.includes("serpapi-maps"))).toBe(true);
  });
});

describe("merging", () => {
  it("merges the same place from two sources (similar names, < 40 m) and keeps both names", () => {
    const maps = place({ key: "maps:1", name: "Galata Kulesi", location: { lat: 41.02557, lng: 28.97413 } });
    const wiki = place({
      key: "wiki:en:1",
      name: "Galata Tower",
      location: { lat: 41.02568, lng: 28.97415 },
      sources: ["wikipedia"],
      sourceUrl: "https://en.wikipedia.org/wiki/Galata_Tower",
    });
    expect(samePlace(maps, wiki)).toBe(true);
    const { places, keyOf } = mergePlaces([maps, wiki]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      name: "Galata Kulesi",
      altNames: ["Galata Tower"],
      sources: ["serpapi-maps", "wikipedia"],
      sourceUrl: "https://en.wikipedia.org/wiki/Galata_Tower",
    });
    expect(keyOf.get("wiki:en:1")).toBe("maps:1");
  });

  it("keeps two kinds of place apart, and two far-apart places with a shared name", () => {
    const mosque = place({ key: "a", name: "Kılıç Ali Paşa Mosque", location: { lat: 41.0267, lng: 28.9819 } });
    const bath = place({ key: "b", name: "Kılıç Ali Paşa Hamamı", location: { lat: 41.0268, lng: 28.9821 } });
    expect(samePlace(mosque, bath)).toBe(false);
    const f1 = place({ key: "c", name: "Tarihi Çeşme", location: { lat: 41.0305, lng: 28.9737 } });
    const f2 = place({ key: "d", name: "Tarihi Çeşme", location: { lat: 41.0291, lng: 28.9844 } });
    expect(samePlace(f1, f2)).toBe(false);
  });

  it("merges pins on the same spot whatever their names (a museum in a former synagogue)", () => {
    const museum = place({ key: "a", name: "Jewish Museum of Turkey", location: { lat: 41.026749, lng: 28.972734 } });
    const synagogue = place({ key: "b", name: "Zülfaris Synagogue", location: { lat: 41.026772, lng: 28.972733 } });
    expect(samePlace(museum, synagogue)).toBe(true);
  });

  it("does not rank by rating: search picks ignore everything but place, facts and distance", () => {
    const near = place({ key: "near", name: "Near Fountain", types: ["Fountain"], distanceM: 50 });
    const far = place({ key: "far", name: "Far Fountain", types: ["Fountain"], distanceM: 800 });
    const picks = searchPicks([far, near], new Map(), 900, 1);
    expect(picks.map((p) => p.key)).toEqual(["near"]);
  });
});
