import { APP_SLUG } from "@/lib/app";
import { distanceM, roundCenter, type LatLng } from "@/lib/geo";
import { cacheKey } from "@/lib/store";
import { withSpan } from "@/lib/trace";
import type { Lang } from "@/quest/schema";
import { isArea, isExcluded, isGated, isVisible } from "./kinds";
import { safeMessage } from "./serpapi";
import { clean, factSentences } from "./text";
import type { FoundFact, FoundPlace, LookupLog, ResearchDeps } from "./types";

/**
 * Wikipedia GeoSearch with extracts: one free call that returns up to 20 pages near the player,
 * each with its coordinates, short description and intro. Pages become places; sentences of
 * their intros become facts, each with the page link.
 */

export const WIKI_LIMIT = 20;
export const WIKI_TIMEOUT_MS = 15_000;
/** Sentences kept per page (the intro's first ones). */
export const WIKI_SENTENCES_PER_PAGE = 4;
/** Area pages (the neighbourhood) whose first sentences are kept as area facts. */
export const WIKI_AREA_PAGES = 3;

export function wikiUserAgent(env: NodeJS.ProcessEnv): string {
  return env.WIKIPEDIA_USER_AGENT?.trim() || `${APP_SLUG}/0.1 (https://github.com/asi-mir/forking-paths)`;
}

/** The GeoSearch request: pages within `radiusM` (10–10000) of a point, with coordinates and intros. */
export function wikiUrl(lang: Lang, at: LatLng, radiusM: number): string {
  const params = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggscoord: `${at.lat}|${at.lng}`,
    ggsradius: String(Math.max(10, Math.min(10_000, Math.round(radiusM)))),
    ggslimit: String(WIKI_LIMIT),
    prop: "coordinates|extracts|description|info",
    colimit: "max", // the default (10) leaves half the pages without coordinates
    exintro: "1",
    explaintext: "1",
    exlimit: String(WIKI_LIMIT),
    inprop: "url",
    format: "json",
    formatversion: "2",
  });
  return `https://${lang}.wikipedia.org/w/api.php?${params}`;
}

/** The "query" every Wikipedia fact keeps: what was searched, in words. */
export function wikiQuery(lang: Lang, at: LatLng, radiusM: number): string {
  return `${lang}.wikipedia.org pages within ${radiusM} m of ${at.lat},${at.lng}`;
}

type WikiPage = {
  pageid?: number;
  title?: string;
  description?: string;
  extract?: string;
  fullurl?: string;
  coordinates?: Array<{ lat?: number; lon?: number }>;
};

/** Keeps only what the research step reads. */
export function slimWiki(raw: unknown): { pages: WikiPage[] } {
  const pagesRaw = (raw as { query?: { pages?: unknown } })?.query?.pages;
  const list: unknown[] = Array.isArray(pagesRaw) ? pagesRaw : pagesRaw && typeof pagesRaw === "object" ? Object.values(pagesRaw) : [];
  const pages: WikiPage[] = [];
  for (const p of list as WikiPage[]) {
    if (!p || typeof p !== "object") continue;
    const c = p.coordinates?.[0];
    pages.push({
      pageid: p.pageid,
      title: p.title,
      description: p.description,
      extract: p.extract,
      fullurl: p.fullurl,
      ...(c && typeof c.lat === "number" && typeof c.lon === "number" ? { coordinates: [{ lat: c.lat, lon: c.lon }] } : {}),
    });
  }
  return { pages };
}

function pageUrl(lang: Lang, p: WikiPage): string | undefined {
  if (typeof p.fullurl === "string" && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(p.fullurl)) return p.fullurl;
  if (!p.title) return undefined;
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
}

/**
 * A page title as a place name, without Wikipedia's disambiguation:
 * "Italian Synagogue (Istanbul)" → "Italian Synagogue"; "Church of Saint Benoit, Istanbul" → "Church of Saint Benoit".
 */
export function placeName(title: string): string {
  const name = title.replace(/\s*\([^)]*\)$/, "").replace(/,\s*[^,]+$/, "").trim();
  return name || title;
}

/** Reads a GeoSearch response into places, place facts and area facts. */
export function parseWikipedia(
  payload: unknown,
  ctx: { center: LatLng; radiusM: number; lang: Lang; query: string },
): { places: FoundPlace[]; facts: FoundFact[] } {
  const { pages } = slimWiki({ query: { pages: (payload as { pages?: unknown })?.pages } });
  const places: FoundPlace[] = [];
  const facts: FoundFact[] = [];
  const areas: Array<{ d: number; facts: FoundFact[] }> = [];

  for (const p of pages) {
    const title = p.title ? clean(p.title) : "";
    const url = pageUrl(ctx.lang, p);
    if (!title || !url) continue;
    const description = p.description ? clean(p.description) : "";
    const extract = p.extract ?? "";
    const c = p.coordinates?.[0];
    const location = c && typeof c.lat === "number" && typeof c.lon === "number" ? { lat: c.lat, lng: c.lon } : null;
    const d = location ? distanceM(ctx.center, location) : Infinity;

    if (isArea(description) || isArea(title)) {
      const texts = factSentences(extract, 2);
      areas.push({
        d,
        facts: texts.map((text) => ({ text, sourceUrl: url, sourceTitle: `${title} (Wikipedia)`, query: ctx.query, source: "wikipedia" as const })),
      });
      continue;
    }
    if (!location || d > ctx.radiusM) continue;
    if (isExcluded(description) || isExcluded(title)) continue;
    // Only pages about a thing you can see: "Synagogue in Istanbul", "Clock tower in London".
    // Institutions, events and people that share a building's pin are left out.
    if (!isVisible(description || title)) continue;

    const key = `wiki:${ctx.lang}:${p.pageid ?? title}`;
    places.push({
      key,
      name: placeName(title),
      altNames: [],
      location,
      distanceM: Math.round(d),
      sourceUrl: url,
      sources: ["wikipedia"],
      types: description ? [description] : [],
      ...(description ? { description } : {}),
      gated: isGated(`${title} ${description}`),
    });
    for (const text of factSentences(extract, WIKI_SENTENCES_PER_PAGE)) {
      facts.push({ text, sourceUrl: url, sourceTitle: `${title} (Wikipedia)`, query: ctx.query, source: "wikipedia", placeKey: key });
    }
  }
  areas.sort((a, b) => a.d - b.d);
  for (const a of areas.slice(0, WIKI_AREA_PAGES)) facts.push(...a.facts);
  return { places, facts };
}

/** One GeoSearch call (cached for 7 days). Null when it failed; the reason goes to `warnings`. */
export async function wikiNearby(
  deps: ResearchDeps,
  opts: { center: LatLng; lang: Lang; radiusM: number },
  log: { lookups: LookupLog[]; warnings: string[] },
): Promise<{ places: FoundPlace[]; facts: FoundFact[] } | null> {
  const at = roundCenter(opts.center);
  const query = wikiQuery(opts.lang, at, opts.radiusM);
  const key = cacheKey("wikipedia", at, `${opts.lang} r=${opts.radiusM}`);
  const parse = (payload: unknown) => parseWikipedia(payload, { center: opts.center, radiusM: opts.radiusM, lang: opts.lang, query });

  try {
    const hit = await deps.store.cacheGet<{ pages: WikiPage[] }>(key);
    if (hit) {
      log.lookups.push({ source: "wikipedia", query, outcome: "cached" });
      deps.onResponse?.({ source: "wikipedia", query, cacheKey: key, payload: hit, cached: true });
      return parse(hit);
    }
  } catch (err) {
    log.warnings.push(`cache read failed: ${safeMessage(err, [])}`);
  }

  try {
    const ua = wikiUserAgent(deps.env);
    const payload = await withSpan(
      "research.wikipedia",
      { role: "research" },
      async () => {
        const res = await deps.fetch(wikiUrl(opts.lang, at, opts.radiusM), {
          headers: { "User-Agent": ua, "Api-User-Agent": ua, Accept: "application/json" },
          signal: AbortSignal.timeout(WIKI_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Wikipedia answered HTTP ${res.status}`);
        return slimWiki(await res.json());
      },
      { op: "http.client" },
    );
    await deps.store.cacheSet(key, "wikipedia", payload).catch((err: unknown) => {
      log.warnings.push(`cache write failed: ${safeMessage(err, [])}`);
    });
    log.lookups.push({ source: "wikipedia", query, outcome: "fetched" });
    deps.onResponse?.({ source: "wikipedia", query, cacheKey: key, payload, cached: false });
    return parse(payload);
  } catch (err) {
    const reason = safeMessage(err, []);
    log.warnings.push(`wikipedia failed: ${reason}`);
    log.lookups.push({ source: "wikipedia", query, outcome: "failed", reason });
    return null;
  }
}
