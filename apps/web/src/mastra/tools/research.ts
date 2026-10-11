import { createTool } from "@mastra/core/tools";
import { getJson as serpapiGetJson } from "serpapi";
import { z } from "zod";
import { getStore } from "@/lib/store";
import { LangSchema } from "@/quest/schema";
import { placeFacts as searchPlaceFacts } from "@/research/facts";
import { placesNearby as mapsPlaces } from "@/research/places";
import { newSerpapiSession } from "@/research/serpapi";
import type { FoundFact, FoundPlace, ResearchDeps, SerpapiGetJson } from "@/research/types";
import { wikiNearby as wikiPlaces } from "@/research/wikipedia";

/**
 * The research functions as Mastra tools, for a writer that looks things up itself (a stretch
 * goal; the generate-quest workflow calls `research()` in code). Each call is cached and takes
 * its SerpApi searches from the daily budget: placesNearby ≤ 2, placeFacts ≤ 1, wikiNearby 0.
 * The tools return facts without IDs; the caller numbers them before the validator sees them.
 */

function deps(): ResearchDeps {
  return {
    store: getStore(),
    env: process.env,
    getJson: serpapiGetJson as unknown as SerpapiGetJson,
    fetch: globalThis.fetch,
    now: new Date(),
  };
}

const LatLngInput = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

const FactOut = z.object({
  text: z.string(),
  sourceUrl: z.string(),
  sourceTitle: z.string(),
  query: z.string(),
  source: z.enum(["serpapi-maps", "serpapi-search", "wikipedia"]),
  placeKey: z.string().optional(),
});

const PlaceOut = z.object({
  key: z.string(),
  name: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  distanceM: z.number(),
  sourceUrl: z.string(),
  types: z.array(z.string()),
  description: z.string().optional(),
  gated: z.boolean(),
  openNow: z.boolean().optional(),
});

const LookupsOut = z.object({ serpapiSearches: z.number(), warnings: z.array(z.string()) });

const placeOut = (p: FoundPlace): z.infer<typeof PlaceOut> => ({
  key: p.key,
  name: p.name,
  location: p.location,
  distanceM: p.distanceM,
  sourceUrl: p.sourceUrl,
  types: p.types,
  ...(p.description ? { description: p.description } : {}),
  gated: p.gated,
  ...(p.openNow !== undefined ? { openNow: p.openNow } : {}),
});
const factOut = (f: FoundFact): z.infer<typeof FactOut> => ({ ...f });

export const placesNearby = createTool({
  id: "placesNearby",
  description:
    "Google Maps places (via SerpApi) near a point: historical landmarks, fountains and monuments within a radius. At most 2 searches; cached.",
  inputSchema: z.object({
    ...LatLngInput,
    lang: LangSchema.default("en"),
    radiusM: z.number().int().min(100).max(2000).default(900),
    minutes: z.number().int().positive().default(25),
    timeZone: z.string().optional(),
  }),
  outputSchema: z.object({ places: z.array(PlaceOut), facts: z.array(FactOut), skippedClosed: z.array(z.string()) }).extend(LookupsOut.shape),
  execute: async ({ lat, lng, lang, radiusM, minutes, timeZone }) => {
    const d = deps();
    const session = newSerpapiSession(2);
    const r = await mapsPlaces(session, d, { center: { lat, lng }, lang, radiusM, play: { start: d.now, minutes, timeZone } });
    return {
      places: r.places.map(placeOut),
      facts: r.facts.map(factOut),
      skippedClosed: r.skippedClosed,
      serpapiSearches: session.made,
      warnings: session.warnings,
    };
  },
});

export const placeFacts = createTool({
  id: "placeFacts",
  description:
    'Facts about one place from Google Search (via SerpApi): "<place> <city> history". Each fact has its link and query. One search; cached.',
  inputSchema: z.object({
    ...LatLngInput,
    name: z.string().min(2),
    city: z.string().optional(),
    lang: LangSchema.default("en"),
  }),
  outputSchema: z.object({ facts: z.array(FactOut) }).extend(LookupsOut.shape),
  execute: async ({ lat, lng, name, city, lang }) => {
    const session = newSerpapiSession(1);
    const facts = await searchPlaceFacts(session, deps(), { placeKey: `search:${name}`, name, location: { lat, lng }, city, lang });
    return { facts: facts.map(factOut), serpapiSearches: session.made, warnings: session.warnings };
  },
});

export const wikiNearby = createTool({
  id: "wikiNearby",
  description:
    "Wikipedia pages near a point (GeoSearch with intros): places with coordinates and facts from their first sentences, each with the page link. Free; cached.",
  inputSchema: z.object({
    ...LatLngInput,
    lang: LangSchema.default("en"),
    radiusM: z.number().int().min(10).max(10_000).default(900),
  }),
  outputSchema: z.object({ places: z.array(PlaceOut), facts: z.array(FactOut) }).extend(LookupsOut.shape),
  execute: async ({ lat, lng, lang, radiusM }) => {
    const log = { lookups: [], warnings: [] as string[] };
    const r = await wikiPlaces(deps(), { center: { lat, lng }, lang, radiusM }, log);
    return {
      places: (r?.places ?? []).map(placeOut),
      facts: (r?.facts ?? []).map(factOut),
      serpapiSearches: 0,
      warnings: log.warnings,
    };
  },
});

export const researchTools = { placesNearby, placeFacts, wikiNearby };
