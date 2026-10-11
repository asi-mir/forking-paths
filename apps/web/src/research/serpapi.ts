import { budgetTake } from "@/lib/budget";
import { roundCenter, type LatLng } from "@/lib/geo";
import { cacheKey } from "@/lib/store";
import { withSpan } from "@/lib/trace";
import type { LookupLog, ResearchDeps } from "./types";

/**
 * SerpApi calls with the cache, the per-quest cap and the daily budget.
 *
 * Order for every search: cache (free) → key set? → per-quest cap (6) → daily budget
 * (`serpapi`) → the request. Responses are slimmed to the fields the research step reads before
 * they are cached or recorded: SerpApi echoes its request (search_parameters, search_metadata
 * URLs), so the raw response is never stored.
 */

/** The most real SerpApi searches one new quest may make (2 Maps + 4 Search). */
export const MAX_SERPAPI_PER_QUEST = 6;

/** A SerpApi request waits this long before it gives up. */
export const SERPAPI_TIMEOUT_MS = 30_000;

/** Counts one research call's SerpApi use. */
export interface SerpapiSession {
  max: number;
  made: number;
  cacheHits: number;
  limited?: "no-key" | "budget" | "cap" | "off";
  lookups: LookupLog[];
  warnings: string[];
}

export function newSerpapiSession(max = MAX_SERPAPI_PER_QUEST): SerpapiSession {
  return { max: Math.max(0, Math.min(max, MAX_SERPAPI_PER_QUEST)), made: 0, cacheHits: 0, lookups: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Slimming and scrubbing

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(obj: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const MAPS_FIELDS = [
  "position", "title", "place_id", "data_id", "gps_coordinates", "type", "types", "type_id", "type_ids",
  "address", "description", "open_state", "hours", "operating_hours",
] as const;

/** google_maps → the places, with only the fields the research step reads. */
export function slimMaps(raw: Json): Json {
  const list = Array.isArray(raw.local_results) ? raw.local_results : [];
  // A query that matches one place exactly returns `place_results` instead of a list.
  const items = list.length ? list : isObject(raw.place_results) ? [raw.place_results] : [];
  return { local_results: items.filter(isObject).map((r) => pick(r, MAPS_FIELDS)) };
}

/** Knowledge-graph keys that are not facts about the place's history. */
const KG_SKIP = new Set([
  "title", "type", "entity_type", "kgmid", "knowledge_graph_search_link", "serpapi_knowledge_graph_search_link",
  "header_images", "images", "description", "source", "website", "people_also_search_for",
  "see_results_about", "local_map", "rating", "review_count", "reviews", "user_reviews", "phone", "hours",
  "popular_times", "address", "plus_code", "directions", "merchant_description", "menu", "price",
  "reservations", "order", "tickets", "profiles", "list", "located_in", "web_results", "thumbnail",
]);

const KG_FIELDS_KEPT = ["title", "type", "description", "source", "website", "knowledge_graph_search_link"] as const;

/** google → knowledge_graph, answer_box and the first organic results. */
export function slimSearch(raw: Json): Json {
  const out: Json = {};
  if (isObject(raw.knowledge_graph)) {
    const kg = raw.knowledge_graph;
    const slim = pick(kg, KG_FIELDS_KEPT);
    if (isObject(kg.source)) slim.source = pick(kg.source, ["name", "link"]);
    // An already slimmed payload (a cache entry or a fixture) keeps its attributes.
    const attributes: Record<string, string> = isObject(kg.attributes)
      ? Object.fromEntries(Object.entries(kg.attributes).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
    for (const [k, v] of Object.entries(kg)) {
      if (k === "attributes") continue;
      if (KG_SKIP.has(k) || /_(?:links?|stick|id)$/.test(k) || k.startsWith("serpapi")) continue;
      if (typeof v === "string" && v.length <= 160) attributes[k] = v;
    }
    if (Object.keys(attributes).length) slim.attributes = attributes;
    out.knowledge_graph = slim;
  }
  if (isObject(raw.answer_box)) {
    out.answer_box = pick(raw.answer_box, ["type", "title", "link", "snippet", "answer", "result", "displayed_link"]);
  }
  if (Array.isArray(raw.organic_results)) {
    out.organic_results = raw.organic_results
      .filter(isObject)
      .slice(0, 6)
      .map((r) => pick(r, ["position", "title", "link", "snippet", "source"]));
  }
  return out;
}

/**
 * A deep copy without anything that could carry a key: strings holding `api_key` or one of
 * `secrets`, and every serpapi.com link.
 */
export function scrub<T>(value: T, secrets: string[]): T {
  const bad = (s: string) => /api_key|serpapi\.com/i.test(s) || secrets.some((x) => x && s.includes(x));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return bad(v) ? undefined : v;
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (isObject(v)) {
      const out: Json = {};
      for (const [k, x] of Object.entries(v)) {
        if (/^serpapi/i.test(k) || k === "api_key") continue;
        const w = walk(x);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** An error message safe to log: no key, no request URL. */
export function safeMessage(err: unknown, secrets: string[]): string {
  let msg: string;
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as { error?: unknown };
      msg = typeof parsed.error === "string" ? parsed.error : err;
    } catch {
      msg = err;
    }
  } else if (err instanceof Error) {
    msg = err.message || err.name;
  } else {
    msg = String(err);
  }
  for (const s of secrets) if (s) msg = msg.split(s).join("[redacted]");
  msg = msg.replace(/api_key=[^&\s"']*/gi, "api_key=[redacted]").replace(/https?:\/\/\S+/g, "[url]");
  return msg.slice(0, 200);
}

export function serpapiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.SERPAPI_API_KEY?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// The guarded call

export interface SerpapiRequest {
  source: "serpapi-maps" | "serpapi-search";
  /** Where the search is about (rounded to ~100 m in the cache key). */
  at: LatLng;
  /** The search text: part of the cache key and the query every fact keeps. */
  query: string;
  /** The rest of the cache key (e.g. the language), so different requests never share an entry. */
  variant: string;
  params: Record<string, string | number>;
  slim: (raw: Json) => Json;
}

/**
 * One SerpApi search, through the cache and the guards. Returns the slimmed payload, or null
 * when the search was skipped (no key, cap, budget) or failed; the session records why.
 */
export async function serpapiSearch(session: SerpapiSession, deps: ResearchDeps, req: SerpapiRequest): Promise<Json | null> {
  const key = cacheKey(req.source, roundCenter(req.at), `${req.variant} ${req.query}`);
  const log = (outcome: LookupLog["outcome"], reason?: string) =>
    session.lookups.push({ source: req.source, query: req.query, outcome, ...(reason ? { reason } : {}) });

  let hit: Json | null = null;
  try {
    hit = await deps.store.cacheGet<Json>(key);
  } catch (err) {
    session.warnings.push(`cache read failed: ${safeMessage(err, [])}`);
  }
  if (hit) {
    session.cacheHits++;
    log("cached");
    deps.onResponse?.({ source: req.source, query: req.query, cacheKey: key, payload: hit, cached: true });
    return hit;
  }

  if (session.limited === "off") {
    log("skipped", "SerpApi off");
    return null;
  }
  const apiKey = serpapiKey(deps.env);
  if (!apiKey) {
    session.limited ??= "no-key";
    log("skipped", "SERPAPI_API_KEY not set");
    return null;
  }
  if (session.limited === "budget") {
    log("skipped", "daily SerpApi budget used");
    return null;
  }
  // Counted before the first await, so parallel searches can never pass the cap together.
  if (session.made >= session.max) {
    session.limited ??= "cap";
    log("skipped", `per-quest cap of ${session.max} searches reached`);
    return null;
  }
  session.made++;
  const budget = await budgetTake("serpapi", 1, { store: deps.store, env: deps.env, now: deps.now });
  if (!budget.ok) {
    session.made--;
    session.limited = "budget";
    log("skipped", `daily SerpApi budget used (${budget.used}/${budget.cap})`);
    return null;
  }

  const secrets = [apiKey];
  try {
    const raw = await withSpan(
      `research.${req.source}`,
      { role: "research" },
      () => deps.getJson({ ...req.params, api_key: apiKey, timeout: SERPAPI_TIMEOUT_MS }),
      { op: "http.client" },
    );
    if (isObject(raw) && typeof raw.error === "string" && !/hasn't returned any results/i.test(raw.error)) {
      throw new Error(raw.error);
    }
    const payload = scrub(req.slim(raw), secrets);
    try {
      await deps.store.cacheSet(key, req.source, payload);
    } catch (err) {
      session.warnings.push(`cache write failed: ${safeMessage(err, secrets)}`);
    }
    log("fetched");
    deps.onResponse?.({ source: req.source, query: req.query, cacheKey: key, payload, cached: false });
    return payload;
  } catch (err) {
    const reason = safeMessage(err, secrets);
    // "No results" comes back as an error from the client; it is a real (paid) search with nothing in it.
    if (/hasn't returned any results/i.test(reason)) {
      const payload = req.slim({});
      await deps.store.cacheSet(key, req.source, payload).catch(() => undefined);
      log("fetched", "no results");
      return payload;
    }
    session.warnings.push(`${req.source} "${req.query}" failed: ${reason}`);
    log("failed", reason);
    return null;
  }
}
