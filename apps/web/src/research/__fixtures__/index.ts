import { createMemoryStore } from "@/lib/store/memory";
import type { ResearchDeps, SerpapiGetJson } from "../types";
import mapsFountain from "./karakoy-serpapi-maps-fountain-monument.json";
import mapsLandmark from "./karakoy-serpapi-maps-historical-landmark.json";
import mapsLandmarkEvening from "./karakoy-evening-serpapi-maps-historical-landmark.json";
import searchArap from "./karakoy-serpapi-search-arap-mosque-istanbul-history.json";
import searchBereketzade from "./karakoy-serpapi-search-bereketzade-ali-efendi-mosque-istanbul-history.json";
import searchPeterPaul from "./karakoy-serpapi-search-church-of-saints-peter-and-paul-istanbul-history.json";
import searchGalataTower from "./karakoy-serpapi-search-galata-tower-istanbul-history.json";
import searchGalataWalls from "./karakoy-serpapi-search-galata-walls-istanbul-history.json";
import searchJewishMuseum from "./karakoy-serpapi-search-jewish-museum-of-turkey-istanbul-history.json";
import searchKamondo from "./karakoy-serpapi-search-kamondo-stairs-istanbul-history.json";
import searchMatbah from "./karakoy-serpapi-search-matbah-emini-hasan-aga-fountain-istanbul-history.json";
import wikiKarakoy from "./wikipedia-karakoy-en.json";

/**
 * Responses recorded for Karaköy, Istanbul (41.0247, 28.9744) by `scripts/research-smoke.ts
 * --record` on 2026-10-10: SerpApi responses slimmed to the fields the research step reads (no
 * request echo, no key), and one Wikipedia GeoSearch. One review-site result was removed from the
 * Kamondo Stairs recording by hand (the parser skips review sites anyway). Tests never use the network.
 *
 * `mapsLandmarkEvening` is the same Maps search recorded again at 22:40 Istanbul time on Saturday
 * 2026-10-10 (Galata Tower closed by then). It is used only by the opening-hours tests.
 */

export const KARAKOY = { lat: 41.0247, lng: 28.9744 };

type Recorded = { source: string; query: string; payload: unknown };

const SERPAPI: Recorded[] = [
  mapsFountain,
  mapsLandmark,
  searchArap,
  searchBereketzade,
  searchPeterPaul,
  searchGalataTower,
  searchGalataWalls,
  searchJewishMuseum,
  searchKamondo,
  searchMatbah,
];

export const fixtures = {
  mapsFountain: () => structuredClone(mapsFountain.payload),
  mapsLandmark: () => structuredClone(mapsLandmark.payload),
  mapsLandmarkEvening: () => structuredClone(mapsLandmarkEvening.payload),
  search: (query: string) => structuredClone(SERPAPI.find((r) => r.query === query)?.payload ?? null),
  wikipedia: () => structuredClone(wikiKarakoy.payload),
};

/** A SerpApi client that answers from the recordings (by `q`) and logs every call. */
export function fakeGetJson(): SerpapiGetJson & { calls: Array<Record<string, string | number>> } {
  const calls: Array<Record<string, string | number>> = [];
  const fn = (async (params: Record<string, string | number>) => {
    calls.push(params);
    const hit = SERPAPI.find((r) => r.query === params.q);
    if (!hit) return { error: "Google hasn't returned any results for this query." };
    return structuredClone(hit.payload) as Record<string, unknown>;
  }) as SerpapiGetJson & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/** A fetch that answers the Wikipedia GeoSearch from the recording, in the API's own shape. */
export function fakeFetch(): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (!url.includes("wikipedia.org/w/api.php")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ batchcomplete: true, query: wikiKarakoy.payload }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

/** Deps for one test: a fresh memory store, recorded SerpApi and Wikipedia, a fixed time. */
export function testDeps(over: Partial<ResearchDeps> = {}) {
  const getJson = fakeGetJson();
  const fetch = fakeFetch();
  const deps: ResearchDeps = {
    store: createMemoryStore(),
    env: env({ SERPAPI_API_KEY: "test-serpapi-key-123456", BUDGET_SERPAPI_PER_DAY: "40" }),
    getJson,
    fetch,
    // Saturday 2026-10-10, 14:00 in Istanbul.
    now: new Date("2026-10-10T11:00:00Z"),
    ...over,
  };
  return { deps, getJson, fetch };
}
