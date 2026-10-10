import { describe, expect, it } from "vitest";
import { budgetStatus } from "@/lib/budget";
import { env, testDeps } from "./__fixtures__";
import { newSerpapiSession, safeMessage, scrub, serpapiSearch, slimMaps, slimSearch, type SerpapiRequest } from "./serpapi";

const KEY = "test-serpapi-key-123456";

/** A raw google_maps response in SerpApi's documented shape, request echo included. */
const rawMaps = () => ({
  search_metadata: {
    id: "abc",
    json_endpoint: "https://serpapi.com/searches/abc/x.json",
    google_maps_url: "https://www.google.com/maps/search/fountain/@41.025,28.974,16z",
  },
  search_parameters: { engine: "google_maps", q: "fountain", ll: "@41.025,28.974,16z", api_key: KEY },
  local_results: [
    {
      position: 1,
      title: "A Fountain",
      place_id: "ChIJ-test",
      gps_coordinates: { latitude: 41.0251, longitude: 28.9745 },
      type: "Historical landmark",
      rating: 4.7,
      reviews_link: `https://serpapi.com/search.json?engine=google_maps_reviews&api_key=${KEY}`,
      serpapi_thumbnail: "https://serpapi.com/x.jpg",
      description: "Old stone fountain.",
    },
  ],
});

const mapsReq = (q = "fountain"): SerpapiRequest => ({
  source: "serpapi-maps",
  at: { lat: 41.0247, lng: 28.9744 },
  query: q,
  variant: "hl=en z=16",
  params: { engine: "google_maps", type: "search", q, ll: "@41.025,28.974,16z", hl: "en" },
  slim: slimMaps,
});

describe("slimming and scrubbing", () => {
  it("keeps only the fields the research step reads, and never the request echo or a key", () => {
    const slim = scrub(slimMaps(rawMaps()), [KEY]);
    const text = JSON.stringify(slim);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("serpapi.com");
    expect(text).not.toContain("search_parameters");
    expect(text).not.toContain("rating");
    expect(slim).toEqual({
      local_results: [
        {
          position: 1,
          title: "A Fountain",
          place_id: "ChIJ-test",
          gps_coordinates: { latitude: 41.0251, longitude: 28.9745 },
          type: "Historical landmark",
          description: "Old stone fountain.",
        },
      ],
    });
  });

  it("drops knowledge-graph ids and links but keeps its string attributes, also when slimmed twice", () => {
    const raw = {
      knowledge_graph: {
        title: "Galata Tower",
        description: "A medieval tower.",
        source: { name: "Wikipedia", link: "https://en.wikipedia.org/wiki/Galata_Tower" },
        architect: "Unknown",
        architect_links: [{ link: "https://www.google.com/search?q=x" }],
        place_id: "ChIJ",
        people_also_search_for_stick: "H4sIAAAA",
        serpapi_knowledge_graph_search_link: `https://serpapi.com/search.json?api_key=${KEY}`,
      },
    };
    const once = slimSearch(raw);
    expect(once).toEqual({
      knowledge_graph: {
        title: "Galata Tower",
        description: "A medieval tower.",
        source: { name: "Wikipedia", link: "https://en.wikipedia.org/wiki/Galata_Tower" },
        attributes: { architect: "Unknown" },
      },
    });
    expect(slimSearch(once)).toEqual(once);
  });

  it("makes error messages safe to log", () => {
    const msg = safeMessage(new Error(`GET https://serpapi.com/search?api_key=${KEY}&q=x failed`), [KEY]);
    expect(msg).not.toContain(KEY);
    expect(msg).toContain("[url]");
    expect(safeMessage('{"error":"Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}', [KEY])).toBe(
      "Invalid API key. Your API key should be here: [url]",
    );
  });
});

describe("serpapiSearch", () => {
  it("caches the slimmed response: the second identical search is free", async () => {
    const { deps } = testDeps({ getJson: async () => rawMaps() });
    const s1 = newSerpapiSession();
    const first = await serpapiSearch(s1, deps, mapsReq());
    expect(first).not.toBeNull();
    expect(s1.made).toBe(1);

    const s2 = newSerpapiSession();
    const second = await serpapiSearch(s2, deps, mapsReq());
    expect(second).toEqual(first);
    expect(s2).toMatchObject({ made: 0, cacheHits: 1 });
    expect(s2.lookups).toEqual([{ source: "serpapi-maps", query: "fountain", outcome: "cached" }]);
    expect((await budgetStatus("serpapi", { store: deps.store, env: deps.env, now: deps.now })).used).toBe(1);
  });

  it("sends the key only to SerpApi and stores none of it", async () => {
    const { deps, getJson } = testDeps({});
    const calls: Array<Record<string, string | number>> = [];
    deps.getJson = async (p) => {
      calls.push(p);
      return rawMaps();
    };
    await serpapiSearch(newSerpapiSession(), deps, mapsReq());
    expect(calls[0]).toMatchObject({ engine: "google_maps", api_key: KEY });
    expect(getJson.calls).toHaveLength(0);
    const cached = await deps.store.cacheGet("serpapi-maps:41.025,28.974:hl=en z=16 fountain");
    expect(JSON.stringify(cached)).not.toContain(KEY);
  });

  it("skips without a key and makes no request", async () => {
    let called = false;
    const { deps } = testDeps({ env: env({}), getJson: async () => ((called = true), rawMaps()) });
    const s = newSerpapiSession();
    expect(await serpapiSearch(s, deps, mapsReq())).toBeNull();
    expect(called).toBe(false);
    expect(s.limited).toBe("no-key");
    expect(s.lookups[0]).toMatchObject({ outcome: "skipped", reason: "SERPAPI_API_KEY not set" });
  });

  it("never passes the per-quest cap, even with searches in parallel", async () => {
    let n = 0;
    const { deps } = testDeps({ getJson: async () => (n++, rawMaps()) });
    const s = newSerpapiSession(6);
    await Promise.all(Array.from({ length: 9 }, (_, i) => serpapiSearch(s, deps, mapsReq(`q${i}`))));
    expect(n).toBe(6);
    expect(s.made).toBe(6);
    expect(s.limited).toBe("cap");
    expect(newSerpapiSession(50).max).toBe(6);
  });

  it("refuses cleanly over the daily budget", async () => {
    let n = 0;
    const { deps } = testDeps({ env: env({ SERPAPI_API_KEY: KEY, BUDGET_SERPAPI_PER_DAY: "2" }), getJson: async () => (n++, rawMaps()) });
    const s = newSerpapiSession();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await serpapiSearch(s, deps, mapsReq(`q${i}`)));
    expect(results.map((r) => r !== null)).toEqual([true, true, false, false]);
    expect(n).toBe(2);
    expect(s).toMatchObject({ made: 2, limited: "budget" });
  });

  it("records a failed search without the key and goes on", async () => {
    const { deps } = testDeps({
      getJson: async () => {
        throw new Error(`socket hang up at https://serpapi.com/search.json?api_key=${KEY}`);
      },
    });
    const s = newSerpapiSession();
    expect(await serpapiSearch(s, deps, mapsReq())).toBeNull();
    expect(s.warnings.join(" ")).not.toContain(KEY);
    expect(s.lookups[0].outcome).toBe("failed");
  });

  it("treats 'no results' as an empty answer, cached", async () => {
    const { deps } = testDeps({ getJson: async () => ({ error: "Google hasn't returned any results for this query." }) });
    const s = newSerpapiSession();
    expect(await serpapiSearch(s, deps, mapsReq())).toEqual({ local_results: [] });
    expect(s.made).toBe(1);
  });
});
