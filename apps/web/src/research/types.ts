import type { LatLng } from "@/lib/geo";
import type { Store } from "@/lib/store";
import type { Candidate, Fact, FactSource, Lang } from "@/quest/schema";
import type { OperatingHours } from "./hours";

/** Where a place came from. */
export type PlaceSource = "serpapi-maps" | "wikipedia";

/** A place one source found, before merging. `key` is stable per source ("maps:<place_id>"). */
export interface FoundPlace {
  key: string;
  name: string;
  /** Other names for the same place (from the other source, after merging). */
  altNames: string[];
  location: LatLng;
  distanceM: number;
  sourceUrl: string;
  sources: PlaceSource[];
  /** Google Maps types ("Historical landmark") or the Wikipedia short description. */
  types: string[];
  description?: string;
  address?: string;
  /** A courtyard, garden or park that may have gates: used only when open at play time. */
  gated: boolean;
  /** Open for the whole walk, when the hours say so. Undefined: unknown. */
  openNow?: boolean;
  operatingHours?: OperatingHours;
  openState?: string;
}

/** A fact one source gave, before IDs are assigned. */
export interface FoundFact {
  text: string;
  sourceUrl: string;
  sourceTitle: string;
  query: string;
  source: FactSource;
  /** The FoundPlace.key the fact is about; none for an area fact (the neighbourhood). */
  placeKey?: string;
}

/** One external lookup the research step asked for. */
export interface LookupLog {
  source: FactSource;
  query: string;
  /** "fetched": a real request; "cached": served from the cache (a cached SerpApi search is free). */
  outcome: "fetched" | "cached" | "skipped" | "failed";
  /** Why it was skipped or failed (never holds a key). */
  reason?: string;
}

/** A candidate place handed to the writer: the schema's Candidate plus what helps it choose. */
export interface ResearchCandidate extends Candidate {
  distanceM: number;
  types: string[];
  description?: string;
  sources: PlaceSource[];
  altNames: string[];
  factIds: string[];
}

export interface ResearchStats {
  /** Real SerpApi searches made for this call (cached results do not count). Never more than 6. */
  serpapiSearches: number;
  /** SerpApi searches served from the cache. */
  serpapiCacheHits: number;
  /** Places within the radius from each source, before merging and trimming. */
  placesFound: { maps: number; wikipedia: number; merged: number; serpapiOnly: number };
  /** Kept candidates that only SerpApi found (Wikipedia had no page within the radius). */
  serpapiOnlyCandidates: number;
  /** Gated places dropped because their hours say they are closed during the walk. */
  skippedClosed: string[];
  /** Why SerpApi was not (fully) used: no key, today's budget is used up, or the per-quest cap. */
  serpapiLimited?: "no-key" | "budget" | "cap" | "off";
  researchMs: number;
}

export interface ResearchResult {
  center: LatLng;
  lang: Lang;
  radiusM: number;
  /** P1…Pn, best first. */
  candidates: ResearchCandidate[];
  /** F1…Fn. A fact with `placeId` is about that candidate; one without is about the area. */
  facts: Fact[];
  lookups: LookupLog[];
  stats: ResearchStats;
  /** Problems that did not stop the research (a source that failed), without secrets. */
  warnings: string[];
}

/** SerpApi's client call (`getJson` from "serpapi"); injected in tests. */
export type SerpapiGetJson = (params: Record<string, string | number>) => Promise<Record<string, unknown>>;

/** A slimmed external response, as cached and as recorded in fixtures. */
export interface ExternalResponse {
  source: FactSource;
  query: string;
  cacheKey: string;
  payload: unknown;
  cached: boolean;
}

export interface ResearchDeps {
  store: Store;
  env: NodeJS.ProcessEnv;
  getJson: SerpapiGetJson;
  fetch: typeof fetch;
  now: Date;
  /** Called for each response (the smoke script records fixtures from it). */
  onResponse?: (r: ExternalResponse) => void;
}
