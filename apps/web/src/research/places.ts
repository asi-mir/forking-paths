import { distanceM, roundCenter, type LatLng } from "@/lib/geo";
import type { Lang } from "@/quest/schema";
import { openForWalk, type OperatingHours } from "./hours";
import { isExcluded, isGated } from "./kinds";
import { serpapiSearch, slimMaps, type SerpapiSession } from "./serpapi";
import { clean, MAX_FACT_CHARS } from "./text";
import type { FoundFact, FoundPlace, ResearchDeps } from "./types";

/**
 * SerpApi Google Maps: finds places near the player. At most two searches, at zoom 16 around
 * the (rounded) centre. Results outside the radius are dropped; ratings are never used.
 */

/** The two Maps searches, per language. */
export const MAPS_QUERIES: Record<Lang, readonly [string, string]> = {
  en: ["historical landmark", "fountain monument"],
  tr: ["tarihi yer", "çeşme anıt"],
};

export const MAPS_ZOOM = 16;

/** A Google Maps link for a place id (opens the place in Maps). */
export function mapsUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}

export interface PlayTime {
  /** When the walk starts. */
  start: Date;
  minutes: number;
  /** The player's IANA time zone; without it, hours are not used (unknown, place kept). */
  timeZone?: string;
}

type MapsResult = {
  title?: unknown;
  place_id?: unknown;
  gps_coordinates?: { latitude?: unknown; longitude?: unknown };
  type?: unknown;
  types?: unknown;
  address?: unknown;
  description?: unknown;
  open_state?: unknown;
  operating_hours?: unknown;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? clean(v) : undefined);

/**
 * Reads one Maps response into places and facts. Drops results without a place id or
 * coordinates, outside the radius, of an excluded kind, and gated places closed during the walk.
 */
export function parseMapsPlaces(
  payload: unknown,
  ctx: { center: LatLng; radiusM: number; query: string; play: PlayTime },
): { places: FoundPlace[]; facts: FoundFact[]; skippedClosed: string[] } {
  const list = (payload as { local_results?: unknown })?.local_results;
  const places: FoundPlace[] = [];
  const facts: FoundFact[] = [];
  const skippedClosed: string[] = [];
  if (!Array.isArray(list)) return { places, facts, skippedClosed };

  for (const r of list as MapsResult[]) {
    const name = str(r.title);
    const placeId = str(r.place_id);
    const lat = Number(r.gps_coordinates?.latitude);
    const lng = Number(r.gps_coordinates?.longitude);
    if (!name || !placeId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const location = { lat, lng };
    const d = distanceM(ctx.center, location);
    if (d > ctx.radiusM) continue;

    const types = [
      ...new Set([str(r.type), ...(Array.isArray(r.types) ? r.types.map(str) : [])].filter((t): t is string => !!t)),
    ];
    if (types.some(isExcluded)) continue;
    const description = str(r.description);
    const gated = isGated([name, ...types].join(" "));
    const operatingHours =
      r.operating_hours && typeof r.operating_hours === "object" ? (r.operating_hours as OperatingHours) : undefined;
    const openState = str(r.open_state);
    const open = openForWalk({ operatingHours, openState }, ctx.play.start, ctx.play.minutes, ctx.play.timeZone);
    if (gated && open === false) {
      skippedClosed.push(name);
      continue;
    }

    const key = `maps:${placeId}`;
    const sourceUrl = mapsUrl(placeId);
    places.push({
      key,
      name,
      altNames: [],
      location,
      distanceM: Math.round(d),
      sourceUrl,
      sources: ["serpapi-maps"],
      types,
      ...(description ? { description } : {}),
      ...(str(r.address) ? { address: str(r.address) } : {}),
      gated,
      ...(open !== undefined ? { openNow: open } : {}),
      ...(operatingHours ? { operatingHours } : {}),
      ...(openState ? { openState } : {}),
    });
    if (description && description.length >= 20 && description.length <= MAX_FACT_CHARS) {
      facts.push({ text: description, sourceUrl, sourceTitle: `${name} (Google Maps)`, query: ctx.query, source: "serpapi-maps", placeKey: key });
    }
  }
  return { places, facts, skippedClosed };
}

/** Both Maps searches (in parallel), merged by place id. */
export async function placesNearby(
  session: SerpapiSession,
  deps: ResearchDeps,
  opts: { center: LatLng; lang: Lang; radiusM: number; play: PlayTime; queries?: readonly string[] },
): Promise<{ places: FoundPlace[]; facts: FoundFact[]; skippedClosed: string[] }> {
  const at = roundCenter(opts.center);
  const queries = (opts.queries ?? MAPS_QUERIES[opts.lang]).slice(0, 2);
  const results = await Promise.all(
    queries.map(async (q) => {
      const payload = await serpapiSearch(session, deps, {
        source: "serpapi-maps",
        at,
        query: q,
        variant: `hl=${opts.lang} z=${MAPS_ZOOM}`,
        params: { engine: "google_maps", type: "search", q, ll: `@${at.lat},${at.lng},${MAPS_ZOOM}z`, hl: opts.lang },
        slim: slimMaps,
      });
      return parseMapsPlaces(payload, { center: opts.center, radiusM: opts.radiusM, query: q, play: opts.play });
    }),
  );
  const byKey = new Map<string, FoundPlace>();
  const facts: FoundFact[] = [];
  const seenFacts = new Set<string>();
  const skipped = new Set<string>();
  for (const r of results) {
    for (const p of r.places) if (!byKey.has(p.key)) byKey.set(p.key, p);
    for (const f of r.facts) {
      const k = `${f.placeKey}:${f.text}`;
      if (!seenFacts.has(k)) {
        seenFacts.add(k);
        facts.push(f);
      }
    }
    for (const s of r.skippedClosed) skipped.add(s);
  }
  return { places: [...byKey.values()], facts, skippedClosed: [...skipped] };
}
