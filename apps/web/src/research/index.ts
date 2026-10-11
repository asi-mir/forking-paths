import { getJson as serpapiGetJson } from "serpapi";
import { distanceM, type LatLng } from "@/lib/geo";
import { getStore } from "@/lib/store";
import { withSpan } from "@/lib/trace";
import { FactSchema, type Fact, type Lang } from "@/quest/schema";
import { cityFromAddresses, placeFacts } from "./facts";
import { isVisible } from "./kinds";
import { placesNearby, type PlayTime } from "./places";
import { MAX_SERPAPI_PER_QUEST, newSerpapiSession } from "./serpapi";
import { fold, nameParts, sameName } from "./text";
import type {
  FoundFact,
  FoundPlace,
  ResearchCandidate,
  ResearchDeps,
  ResearchResult,
  SerpapiGetJson,
} from "./types";
import { wikiNearby } from "./wikipedia";

export type * from "./types";
export { MAX_SERPAPI_PER_QUEST } from "./serpapi";
export { MAPS_QUERIES, placesNearby } from "./places";
export { placeFacts, searchQuery } from "./facts";
export { wikiNearby } from "./wikipedia";

/**
 * The research step: places and cited facts near the player, in code (the writer never
 * searches). SerpApi Google Maps finds places (≤ 2 searches), Wikipedia GeoSearch adds places
 * and open facts (free), SerpApi Google Search adds facts for the top 4 places (≤ 4 searches).
 * At most 6 real SerpApi searches per call; each is taken from the daily budget, and cached
 * results are free. Every fact keeps its source, query and link.
 */

export const RESEARCH_DEFAULTS = {
  radiusM: 900,
  minutes: 25,
  /** A quest uses 4–6 places; the writer gets a few more to choose from. */
  maxCandidates: 8,
  /** Places searched with SerpApi Google Search. */
  searchPlaces: 4,
  /** Facts kept per candidate (keeps the writer's prompt small). */
  factsPerPlace: 6,
  /** Area facts (the neighbourhood) kept, for the briefing and the mystery. */
  areaFacts: 4,
} as const;

/** Same place: similar names this close (metres). */
export const DEDUP_M = 40;
/** Same place: the same distinctive name this close (a big building's Maps pin and Wikipedia pin differ). */
export const DEDUP_SAME_NAME_M = 150;
/** Same place, whatever the names: pins this close (a museum inside a former synagogue). */
export const DEDUP_SAME_SPOT_M = 10;

export interface ResearchInput extends LatLng {
  lang?: Lang;
  /** Walk length; gated places must be open for all of it. */
  minutes?: number;
  radiusM?: number;
  /** The player's IANA time zone (the phone knows it); without it, opening hours are not used. */
  timeZone?: string;
  /** The city for Search queries; default: the most common city in the Maps addresses. */
  city?: string;
  /** "maps": Maps only, no Search (coverage evals); "off": Wikipedia only. Default "all". */
  serpapi?: "all" | "maps" | "off";
  /** Lower than 6 to save searches; never above 6. */
  maxSerpapiSearches?: number;
  maxCandidates?: number;
}

function defaultDeps(partial: Partial<ResearchDeps>): ResearchDeps {
  return {
    store: partial.store ?? getStore(partial.env),
    env: partial.env ?? process.env,
    getJson: partial.getJson ?? (serpapiGetJson as unknown as SerpapiGetJson),
    fetch: partial.fetch ?? globalThis.fetch,
    now: partial.now ?? new Date(),
    onResponse: partial.onResponse,
  };
}

// ---------------------------------------------------------------------------
// Merge and rank

/** True when two found places are the same place. */
export function samePlace(a: FoundPlace, b: FoundPlace): boolean {
  const d = distanceM(a.location, b.location);
  if (d < DEDUP_SAME_SPOT_M) return true;
  const names = [a.name, ...a.altNames];
  const others = [b.name, ...b.altNames];
  const similar = names.some((x) => others.some((y) => sameName(x, y)));
  if (similar && d < DEDUP_M) return true;
  const identical = names.some((x) => others.some((y) => fold(x) === fold(y)));
  return identical && d < DEDUP_SAME_NAME_M;
}

/**
 * Merges places found twice (Maps and Wikipedia, or two Maps results). The first one found is
 * kept (Maps first: its pin and hours); the other's name, sources and types are added.
 * Returns the merged places and a map from every original key to its merged key.
 */
export function mergePlaces(places: FoundPlace[]): { places: FoundPlace[]; keyOf: Map<string, string> } {
  const out: FoundPlace[] = [];
  const keyOf = new Map<string, string>();
  for (const p of places) {
    const into = out.find((q) => samePlace(q, p));
    if (!into) {
      out.push({ ...p, altNames: [...p.altNames], sources: [...p.sources], types: [...p.types] });
      keyOf.set(p.key, p.key);
      continue;
    }
    keyOf.set(p.key, into.key);
    for (const n of [p.name, ...p.altNames]) {
      if (fold(n) !== fold(into.name) && !into.altNames.some((a) => fold(a) === fold(n))) into.altNames.push(n);
    }
    for (const s of p.sources) if (!into.sources.includes(s)) into.sources.push(s);
    for (const t of p.types) if (!into.types.includes(t)) into.types.push(t);
    into.description ??= p.description;
    into.gated ||= p.gated;
    into.openNow ??= p.openNow;
    // A Wikipedia page is a readable source for the place; Maps keeps its pin.
    if (p.sources.includes("wikipedia") && !into.sourceUrl.includes("wikipedia.org")) into.sourceUrl = p.sourceUrl;
  }
  return { places: out, keyOf };
}

/**
 * Score without facts: public, visible, close, and signs that the place is notable (two sources,
 * a Google Maps summary, a "Tourist attraction" type). Ratings are never used. A gated place
 * counts as public only when its hours say it is open for the walk.
 */
export function placeScore(p: FoundPlace, radiusM: number): number {
  let s = p.gated ? (p.openNow ? 0.5 : 0.25) : 1;
  if (isVisible(`${p.name} ${p.types.join(" ")}`)) s += 1;
  if (p.sources.length > 1) s += 0.5;
  if (p.sources.includes("serpapi-maps") && p.description) s += 0.5;
  if (p.types.some((t) => /tourist attraction/i.test(t))) s += 0.5;
  // Close places make short hops (≤ 250 m) possible.
  s -= (2.5 * p.distanceM) / radiusM;
  return s;
}

/** Rank score: has facts (up to 4 count), then placeScore. A place with no fact cannot be a stop. */
export function rankScore(p: FoundPlace, factCount: number, radiusM: number): number {
  return Math.min(factCount, 4) - (factCount === 0 ? 5 : 0) + placeScore(p, radiusM);
}

function rank(places: FoundPlace[], factsByKey: Map<string, FoundFact[]>, radiusM: number): FoundPlace[] {
  const score = new Map(places.map((p) => [p.key, rankScore(p, factsByKey.get(p.key)?.length ?? 0, radiusM)]));
  return [...places].sort((a, b) => score.get(b.key)! - score.get(a.key)! || a.distanceM - b.distanceM);
}

/**
 * The places to search with Google Search: the best by placeScore, with a bonus for few facts so
 * far (a place only Maps knows has none; Wikipedia's places already have theirs). Names with
 * nothing distinctive ("Tarihi Çeşme", "historic fountain") are not searched.
 */
export function searchPicks(places: FoundPlace[], factsByKey: Map<string, FoundFact[]>, radiusM: number, n: number): FoundPlace[] {
  const need = (p: FoundPlace) => {
    const k = factsByKey.get(p.key)?.length ?? 0;
    return k === 0 ? 1.5 : k < 3 ? 0.75 : 0;
  };
  return places
    .filter((p) => nameParts(p.name).tokens.size > 0)
    .map((p) => ({ p, s: placeScore(p, radiusM) + need(p) }))
    .sort((a, b) => b.s - a.s || a.p.distanceM - b.p.distanceM)
    .slice(0, n)
    .map((x) => x.p);
}

/** Up to `n` facts, taking from each source in turn so one source does not crowd out the rest. */
function interleave(facts: FoundFact[], n: number): FoundFact[] {
  const bySource = new Map<string, FoundFact[]>();
  for (const f of facts) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);
  const queues = [...bySource.values()];
  const out: FoundFact[] = [];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      const f = q.shift();
      if (f && out.length < n) out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The research call

export async function research(input: ResearchInput, partialDeps: Partial<ResearchDeps> = {}): Promise<ResearchResult> {
  return withSpan("research", { role: "research" }, () => runResearch(input, defaultDeps(partialDeps)));
}

async function runResearch(input: ResearchInput, deps: ResearchDeps): Promise<ResearchResult> {
  const started = Date.now();
  const center: LatLng = { lat: input.lat, lng: input.lng };
  const lang: Lang = input.lang ?? "en";
  const radiusM = input.radiusM ?? RESEARCH_DEFAULTS.radiusM;
  const mode = input.serpapi ?? "all";
  const maxCandidates = input.maxCandidates ?? RESEARCH_DEFAULTS.maxCandidates;
  const play: PlayTime = { start: deps.now, minutes: input.minutes ?? RESEARCH_DEFAULTS.minutes, timeZone: input.timeZone };

  const session = newSerpapiSession(input.maxSerpapiSearches ?? MAX_SERPAPI_PER_QUEST);
  if (mode === "off") session.limited = "off";

  // 1. Maps and Wikipedia, in parallel.
  const [maps, wiki] = await Promise.all([
    mode === "off"
      ? Promise.resolve({ places: [], facts: [], skippedClosed: [] as string[] })
      : placesNearby(session, deps, { center, lang, radiusM, play }),
    wikiNearby(deps, { center, lang, radiusM }, session),
  ]);

  // 2. Merge (Maps first) and re-key the facts.
  const merged = mergePlaces([...maps.places, ...(wiki?.places ?? [])]);
  const allFacts: FoundFact[] = [...maps.facts, ...(wiki?.facts ?? [])].map((f) =>
    f.placeKey ? { ...f, placeKey: merged.keyOf.get(f.placeKey) ?? f.placeKey } : f,
  );
  // Facts by place, without repeats (a search snippet often copies the Wikipedia sentence;
  // two sites often share their opening line).
  const factsByKey = () => {
    const m = new Map<string, FoundFact[]>();
    const seen = new Set<string>();
    for (const f of allFacts) {
      const t = fold(f.text).slice(0, 60);
      if (!f.placeKey || seen.has(t)) continue;
      seen.add(t);
      m.set(f.placeKey, [...(m.get(f.placeKey) ?? []), f]);
    }
    return m;
  };

  // 3. Search facts for the top places, preferring the ones with the fewest facts so far.
  if (mode === "all") {
    const picks = searchPicks(merged.places, factsByKey(), radiusM, RESEARCH_DEFAULTS.searchPlaces);
    const city = input.city ?? cityFromAddresses(maps.places.map((p) => p.address).filter((a): a is string => !!a));
    const found = await Promise.all(
      picks.map((p) => placeFacts(session, deps, { placeKey: p.key, name: p.name, location: p.location, city, lang })),
    );
    for (const list of found) allFacts.push(...list);
  }

  // 4. Rank again, keep places that have facts, number everything.
  const byKey = factsByKey();
  const kept = rank(merged.places, byKey, radiusM)
    .filter((p) => (byKey.get(p.key)?.length ?? 0) > 0)
    .slice(0, maxCandidates);

  const facts: Fact[] = [];
  const candidates: ResearchCandidate[] = [];
  const push = (f: FoundFact, placeId?: string): string | null => {
    const parsed = FactSchema.safeParse({
      id: `F${facts.length + 1}`,
      text: f.text,
      sourceUrl: f.sourceUrl,
      sourceTitle: f.sourceTitle,
      query: f.query,
      source: f.source,
      ...(placeId ? { placeId } : {}),
    });
    if (!parsed.success) return null;
    facts.push(parsed.data);
    return parsed.data.id;
  };
  for (const p of kept) {
    const id = `P${candidates.length + 1}`;
    const factIds = interleave(byKey.get(p.key) ?? [], RESEARCH_DEFAULTS.factsPerPlace)
      .map((f) => push(f, id))
      .filter((x): x is string => !!x);
    if (!factIds.length) continue;
    candidates.push({
      id,
      name: p.name,
      location: p.location,
      sourceUrl: p.sourceUrl,
      ...(p.gated ? { gated: true } : {}),
      ...(p.openNow !== undefined ? { openNow: p.openNow } : {}),
      distanceM: p.distanceM,
      types: p.types,
      ...(p.description ? { description: p.description } : {}),
      sources: p.sources,
      altNames: p.altNames,
      factIds,
    });
  }
  for (const f of allFacts.filter((x) => !x.placeKey).slice(0, RESEARCH_DEFAULTS.areaFacts)) push(f);

  const serpapiOnly = (p: { sources: string[] }) => !p.sources.includes("wikipedia");
  return {
    center,
    lang,
    radiusM,
    candidates,
    facts,
    lookups: session.lookups,
    stats: {
      serpapiSearches: session.made,
      serpapiCacheHits: session.cacheHits,
      placesFound: {
        maps: maps.places.length,
        wikipedia: wiki?.places.length ?? 0,
        merged: merged.places.length,
        serpapiOnly: merged.places.filter(serpapiOnly).length,
      },
      serpapiOnlyCandidates: candidates.filter(serpapiOnly).length,
      skippedClosed: maps.skippedClosed,
      ...(session.limited ? { serpapiLimited: session.limited } : {}),
      researchMs: Date.now() - started,
    },
    warnings: session.warnings,
  };
}
