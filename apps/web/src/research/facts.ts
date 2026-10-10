import type { LatLng } from "@/lib/geo";
import type { Lang } from "@/quest/schema";
import { serpapiSearch, slimSearch, type SerpapiSession } from "./serpapi";
import { aboutPlace, clean, factSentences, fold, MAX_FACT_CHARS, sameName, snippetText } from "./text";
import type { FoundFact, ResearchDeps } from "./types";

/**
 * SerpApi Google Search: one search per shortlisted place ("<place> <city> history") →
 * facts from the knowledge graph, the answer box and organic snippets. Every fact keeps its
 * link and the query; anything without a link is skipped, and so is a result that does not
 * name the place (a search for an obscure fountain can return the whole city).
 */

/**
 * Sites whose snippets are not facts about the place: social media, stock photos, reviews and
 * bookings (opinions, prices, opening times), and Wikipedia mirrors (Wikipedia is read directly).
 */
const SKIP_SITES = new Set([
  "instagram", "facebook", "tiktok", "pinterest", "youtube", "youtu", "twitter", "x", "threads", "reddit",
  "quora", "linkedin", "alamy", "shutterstock", "gettyimages", "istockphoto", "dreamstime", "depositphotos",
  "123rf", "flickr", "tripadvisor", "trip", "booking", "expedia", "agoda", "hotels", "airbnb", "foursquare",
  "yelp", "yandex", "wikiwand", "wikimili", "dbpedia", "everybodywiki", "alchetron", "getyourguide", "viator",
  "klook", "tiqets",
]);

/** True for a link whose host is one of SKIP_SITES (any label: "my.trip.com", "tripadvisor.ca"). */
export function skippedHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().split(".").some((label) => SKIP_SITES.has(label));
  } catch {
    return true;
  }
}

/** Common short words of each language: a snippet in another language is skipped. */
const STOPWORDS: Record<Lang, Set<string>> = {
  // Words other Latin-script languages do not share ("in", "a" and "an" are Italian or German too).
  en: new Set(["the", "is", "was", "were", "of", "and", "by", "it", "its", "built", "from", "which", "with", "for", "this", "that", "has", "had", "are"]),
  tr: new Set(["ve", "bir", "bu", "ile", "olarak", "yılında", "tarafından", "da", "de", "en", "olan", "için", "yapılmıştır", "inşa", "edilen"]),
};

/** True when `text` reads as `lang` (at least two of its common words, few letters from other scripts). */
export function inLanguage(text: string, lang: Lang): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (!letters.length || latin / letters.length < 0.9) return false;
  const words = text.toLocaleLowerCase(lang === "tr" ? "tr" : "en").split(/[^\p{L}]+/u);
  let hits = 0;
  for (const w of words) if (STOPWORDS[lang].has(w)) hits++;
  return hits >= 2;
}

/** A review, a tour plan, a listing or an infobox fragment, not a statement about the place. */
export function looksLikeOpinionOrListing(text: string): boolean {
  return (
    !/^["“(]?[\p{Lu}0-9]/u.test(text) || // "medieval Genoese tower. Built as …" (an infobox, not a sentence)
    /\byears ago\b/i.test(text) ||
    /\b(?:I|I'm|I've|my|we|we're|our|us|you|your|you'll)\b/.test(text) ||
    /^(?:Day \d+|Address|Opening (?:hours|times)|Hours|Tickets?|Price|Download|Watch|Book|Rating)\b/i.test(text) ||
    /\b(?:stock (?:photo|image)s?|high resolution|reviews?|rated|rating)\b/i.test(text)
  );
}

/** Knowledge-graph attributes that state a fact about the place (not ids, hours or contacts). */
const KG_FACT_KEYS =
  /^(?:architects?|architectural_styles?|style|opened|founded|founders?|built|constructed|construction_(?:started|began)|completed|year_built|height|floors|materials?|designers?|designed_by|established|inaugurated|dedicated_to|dedication|denomination|religious_affiliation|affiliation|creators?|sculptors?|artists?|commissioned_by|patron|function|status|area|length|width|date|dates|period|culture)$/;

/** Organic results turned into facts, per search. */
export const ORGANIC_FACTS = 3;
/** Knowledge-graph attributes kept, per search. */
export const KG_ATTRIBUTES = 4;

export function searchQuery(name: string, city: string | undefined): string {
  const withCity = city && !fold(name).includes(fold(city)) ? `${name} ${city}` : name;
  return clean(`${withCity} history`);
}

/**
 * The city of most addresses ("…, 34425 Beyoğlu/İstanbul, Türkiye" → "İstanbul";
 * "…, New York, NY 10118" → "New York"). Undefined without addresses.
 */
export function cityFromAddresses(addresses: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const address of addresses) {
    const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // The city sits before the country ("…, 75016 Paris, France") or before the state and
    // postcode ("…, New York, NY 10118"). Postcodes and two-letter codes are dropped below.
    let part = parts[parts.length - 2];
    part = part.split("/").pop() ?? part;
    const city = part
      .split(/\s+/)
      .filter((w) => !/\d/.test(w) && !/^[A-Z]{2}$/.test(w))
      .join(" ")
      .trim();
    if (city.length >= 2) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [city, c] of counts) if (c > n) [best, n] = [city, c];
  return best;
}

const label = (key: string) => {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type Kg = {
  title?: string;
  description?: string;
  source?: { name?: string; link?: string };
  knowledge_graph_search_link?: string;
  attributes?: Record<string, string>;
};
type AnswerBox = { title?: string; link?: string; snippet?: string; answer?: string; result?: string };
type Organic = { title?: string; link?: string; snippet?: string; source?: string };

const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/.test(v);

/** Reads one Google Search response into facts about `placeName`. */
export function parseSearchFacts(
  payload: unknown,
  ctx: { placeKey: string; placeName: string; query: string; lang: Lang },
): FoundFact[] {
  const out: FoundFact[] = [];
  const seen = new Set<string>();
  const add = (text: string, sourceUrl: string, sourceTitle: string) => {
    const t = clean(text);
    if (t.length < 20 || t.length > MAX_FACT_CHARS || seen.has(t)) return;
    seen.add(t);
    out.push({ text: t, sourceUrl, sourceTitle, query: ctx.query, source: "serpapi-search", placeKey: ctx.placeKey });
  };
  const usable = (text: string) => inLanguage(text, ctx.lang) && !looksLikeOpinionOrListing(text);
  const p = (payload ?? {}) as { knowledge_graph?: Kg; answer_box?: AnswerBox; organic_results?: Organic[] };

  const kg = p.knowledge_graph;
  if (kg?.title && (sameName(kg.title, ctx.placeName) || aboutPlace(kg.title, ctx.placeName))) {
    const title = kg.title;
    const descLink = kg.source?.link;
    if (kg.description && isUrl(descLink)) {
      for (const s of factSentences(kg.description, 2)) add(s, descLink, kg.source?.name ?? title);
    }
    const kgLink = kg.knowledge_graph_search_link;
    if (kg.attributes && isUrl(kgLink)) {
      const attributes = Object.entries(kg.attributes).filter(([k]) => KG_FACT_KEYS.test(k));
      for (const [k, v] of attributes.slice(0, KG_ATTRIBUTES)) {
        add(`${title} — ${label(k)}: ${clean(v)}.`, kgLink, `${title} (Google)`);
      }
    }
  }

  const ab = p.answer_box;
  const abLink = ab?.link;
  if (ab && isUrl(abLink) && !skippedHost(abLink)) {
    const raw = [ab.snippet, ab.answer, ab.result].find((x): x is string => typeof x === "string" && x.trim().length > 0);
    const text = raw ? snippetText(raw) : null;
    if (text && usable(text) && aboutPlace(`${ab.title ?? ""} ${text}`, ctx.placeName)) {
      for (const s of text.length <= MAX_FACT_CHARS ? [text] : factSentences(text, 2)) add(s, abLink, ab.title ?? abLink);
    }
  }

  let organic = 0;
  for (const r of p.organic_results ?? []) {
    if (organic >= ORGANIC_FACTS) break;
    const link = r.link;
    if (!isUrl(link) || skippedHost(link) || typeof r.snippet !== "string") continue;
    const text = snippetText(r.snippet);
    if (!text || !usable(text) || !aboutPlace(`${r.title ?? ""} ${text}`, ctx.placeName)) continue;
    const before = out.length;
    for (const s of text.length <= MAX_FACT_CHARS ? [text] : factSentences(text, 2)) add(s, link, r.title ?? r.source ?? link);
    if (out.length > before) organic++;
  }
  return out;
}

/** One Google Search for a place's history (cached; counts toward the per-quest cap and the daily budget). */
export async function placeFacts(
  session: SerpapiSession,
  deps: ResearchDeps,
  opts: { placeKey: string; name: string; location: LatLng; city?: string; lang: Lang },
): Promise<FoundFact[]> {
  const query = searchQuery(opts.name, opts.city);
  const payload = await serpapiSearch(session, deps, {
    source: "serpapi-search",
    at: opts.location,
    query,
    variant: `hl=${opts.lang}`,
    params: { engine: "google", q: query, hl: opts.lang, num: 10 },
    slim: slimSearch,
  });
  return payload ? parseSearchFacts(payload, { placeKey: opts.placeKey, placeName: opts.name, query, lang: opts.lang }) : [];
}
