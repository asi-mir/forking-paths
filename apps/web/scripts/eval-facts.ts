/**
 * Fact check (page → fact): samples facts cited by generated quests, fetches the page each one
 * links to, and checks that the page says it. Code marks the word-for-word matches; Gemma
 * pre-checks the rest against the best-matching passage; a review file adds the agent's and the
 * owner's verdicts, which win over Gemma's. Misses are listed.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/eval-facts.ts [--n 30] [--seed 12] [--records <dir>] [--dbs all|a,b]
 *     [--precheck google|ollama|none] [--review <review.json>] [--out-dir <dir>] [--date YYYY-MM-DD]
 *
 * --precheck: the provider of the Gemma pre-check (default: the narrator role's provider from env;
 * "none" skips it). The review file maps a fact key (printed in the report) to
 * {"verdict": "held" | "partly" | "missed", "by": "agent" | "owner", "note": "…"}.
 * Fetched pages are cached in eval/runs/pages (git-ignored).
 * Reports: <out-dir>/<date>-facts.md and .json (default out-dir eval/runs).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine, generations, loadEnv, numberOption, option, readDatabases, sleep, writeReport } from "../eval/common";
import { factCheckPrompt, FactCheckSchema, shortHash, type FactCheck } from "../src/eval/precheck";
import { mdTable, pct, stratifiedSample, tally } from "../src/eval/stats";
import { htmlToText, matchFact, type FactMatch } from "../src/eval/text-match";
import { decideFact, type FactDecider, type FactReview, type FactVerdict } from "../src/eval/verdicts";
import type { Fact } from "../src/quest/schema";

loadEnv();

const UA = process.env.WIKIPEDIA_USER_AGENT?.trim() || "ForkingPathsEval/0.1 (open-source walking game; fact check)";
const PAGES = "eval/runs/pages";

type Review = FactReview;

type Row = {
  key: string;
  fact: Pick<Fact, "text" | "sourceUrl" | "sourceTitle" | "source" | "query">;
  quests: string[];
  fetch: { ok: boolean; how: string; chars: number };
  match: FactMatch | null;
  gemma: (FactCheck & { model: string; ms: number }) | { error: string } | null;
  review: Review | null;
  verdict: FactVerdict;
  decidedBy: FactDecider;
};

const factKey = (f: Pick<Fact, "text" | "sourceUrl">) => `${f.sourceUrl}#${shortHash(f.text)}`;

/** The page text behind a fact's link, or why it could not be read. */
async function pageText(f: Pick<Fact, "sourceUrl" | "source">): Promise<{ text: string | null; how: string }> {
  const url = new URL(f.sourceUrl);
  if (/(^|\.)google\.[a-z.]+$/.test(url.hostname)) {
    return { text: null, how: url.pathname.startsWith("/maps") ? "Google Maps listing (no page text to fetch)" : "Google result page (not fetchable)" };
  }
  mkdirSync(PAGES, { recursive: true });
  const cache = join(PAGES, `${createHash("sha256").update(f.sourceUrl).digest("hex").slice(0, 16)}.txt`);
  if (existsSync(cache)) return { text: readFileSync(cache, "utf8"), how: "cached page" };

  let text: string | null = null;
  let how = "";
  const wiki = /^([a-z-]+)\.wikipedia\.org$/.exec(url.hostname);
  try {
    if (wiki && url.pathname.startsWith("/wiki/")) {
      // The whole article as plain text (the research step read only its intro).
      const title = decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ");
      const api = new URL(`https://${url.hostname}/w/api.php`);
      for (const [k, v] of Object.entries({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title, format: "json", formatversion: "2" })) {
        api.searchParams.set(k, v);
      }
      const res = await fetch(api, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
      const json = (await res.json()) as { query?: { pages?: Array<{ extract?: string; missing?: boolean }> } };
      text = json.query?.pages?.[0]?.extract ?? null;
      how = text ? "Wikipedia article (API, plain text)" : "Wikipedia page missing";
    } else {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { text: null, how: `HTTP ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (!/html|text/.test(type)) return { text: null, how: `not a web page (${type.split(";")[0] || "unknown type"})` };
      text = htmlToText(await res.text());
      how = "web page (HTML to text)";
    }
  } catch (e) {
    return { text: null, how: `fetch failed: ${(e as Error).message.slice(0, 80)}` };
  }
  if (text) writeFileSync(cache, text);
  await sleep(500);
  return { text, how };
}

async function precheck(fact: string, passage: string, provider: string | undefined): Promise<Row["gemma"]> {
  const { generateJson } = await import("../src/lib/json");
  const env = { ...process.env, ...(provider ? { GEMMA_NARRATOR_PROVIDER: provider } : {}) };
  try {
    const { data, meta } = await generateJson("narrator", FactCheckSchema, factCheckPrompt(fact, passage), undefined, {
      env,
      temperature: 0,
      maxOutputTokens: 300,
      timeoutMs: 180_000,
    });
    return { ...data, model: `${meta.provider}/${meta.model}`, ms: meta.latencyMs };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160) };
  }
}

async function main() {
  const n = numberOption("n", 30);
  const seed = numberOption("seed", 12);
  const precheckOpt = option("precheck");
  const reviewPath = option("review");
  const reviews: Record<string, Review> = reviewPath && existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : {};

  const sources = await readDatabases();
  const gens = generations(sources, option("records")).filter((g) => !g.demo && g.quest && g.status === "ready");
  // Unique facts cited by generated quests (Karaköy quests share many).
  const facts = new Map<string, { fact: Fact; quests: Set<string> }>();
  for (const g of gens) {
    for (const f of g.quest!.facts) {
      const key = factKey(f);
      const entry = facts.get(key) ?? { fact: f, quests: new Set<string>() };
      entry.quests.add(g.quest!.title);
      facts.set(key, entry);
    }
  }
  const pool = [...facts.entries()];
  const picked = stratifiedSample(pool, ([, v]) => v.fact.source, n, seed);
  console.log(`${gens.length} generated quests, ${pool.length} unique cited facts; sampled ${picked.length} (seed ${seed})`);

  const rows: Row[] = [];
  for (const [key, { fact, quests }] of picked) {
    const page = await pageText(fact);
    const match = page.text ? matchFact(fact.text, page.text) : null;
    let gemma: Row["gemma"] = null;
    if (page.text && match && !match.verbatim && precheckOpt !== "none") {
      gemma = await precheck(fact.text, match.passage, precheckOpt);
    }
    const base = {
      key,
      fact: { text: fact.text, sourceUrl: fact.sourceUrl, sourceTitle: fact.sourceTitle, source: fact.source, query: fact.query },
      quests: [...quests],
      fetch: { ok: !!page.text, how: page.how, chars: page.text?.length ?? 0 },
      match,
      gemma,
      review: reviews[key] ?? null,
    };
    const row: Row = { ...base, ...decideFact(base) };
    rows.push(row);
    console.log(`${row.verdict.padEnd(13)} ${row.decidedBy.padEnd(20)} ${fact.source} ${fact.text.slice(0, 80)}`);
  }

  const md = report(rows, gens.length, pool.length, seed);
  const files = writeReport("facts", md, { at: new Date().toISOString(), command: commandLine(), seed, rows });
  console.log(`\n${md}\nwrote ${files.md} and ${files.json}`);
}

function report(rows: Row[], quests: number, pool: number, seed: number): string {
  const checkable = rows.filter((r) => r.verdict !== "not checkable" && r.verdict !== "not checked");
  const undecided = rows.filter((r) => r.verdict === "not checked");
  const held = checkable.filter((r) => r.verdict === "held");
  const partly = checkable.filter((r) => r.verdict === "partly");
  const missed = checkable.filter((r) => r.verdict === "missed");
  const by = tally(checkable.map((r) => r.decidedBy));
  const gemmaRuns = rows.flatMap((r) => (r.gemma && "model" in r.gemma ? [r.gemma.model] : []));
  const short = (t: string) => (t.length > 140 ? `${t.slice(0, 137)}…` : t);

  return [
    `# Fact check: page → fact (${option("date") ?? new Date().toISOString().slice(0, 10)})`,
    "",
    `Command: \`${commandLine()}\``,
    "",
    "## Headline",
    "",
    `- Sample: ${rows.length} of ${pool} unique facts cited by ${quests} generated quests (seeded, spread over sources; seed ${seed}). By source: ${tally(rows.map((r) => r.fact.source)).map(([s, k]) => `${s} ${k}`).join(", ")}.`,
    `- **${held.length} of ${checkable.length} checkable facts held against their pages** (${pct(held.length, checkable.length)}); ${partly.length} held in part; ${missed.length} missed.`,
    undecided.length ? `- Not checked yet (page fetched, not word for word, no pre-check or review yet): ${undecided.length}.` : "",
    `- Not checkable: ${rows.filter((r) => r.verdict === "not checkable").length} (${tally(rows.filter((r) => r.verdict === "not checkable").map((r) => r.fetch.how)).map(([h, k]) => `${h}: ${k}`).join("; ") || "none"}).`,
    `- Who decided: ${by.map(([w, k]) => `${w} ${k}`).join(", ") || "-"}.${gemmaRuns.length ? ` Gemma pre-check: ${[...new Set(gemmaRuns)].join(", ")}, ${gemmaRuns.length} call(s).` : ""}`,
    `- Owner confirmed: ${rows.filter((r) => r.review?.by === "owner").length} of ${rows.length} (owner verdicts go in the review file).`,
    "",
    "## Misses and partial holds",
    "",
    missed.length + partly.length
      ? mdTable(
          ["Verdict", "Fact", "Link", "Decided by", "Why"],
          [...missed, ...partly].map((r) => [r.verdict, short(r.fact.text), r.fact.sourceUrl, r.decidedBy, r.review?.note ?? (r.gemma && "note" in r.gemma ? r.gemma.note : `coverage ${r.match?.coverage}`)]),
        )
      : "None.",
    "",
    "## Every sampled fact",
    "",
    mdTable(
      ["#", "Verdict", "Decided by", "Source", "Fact", "Word for word", "Coverage", "Numbers not on page", "Gemma", "Page", "Key"],
      rows.map((r, i) => [
        i + 1,
        r.verdict,
        r.decidedBy,
        r.fact.source,
        short(r.fact.text),
        r.match ? (r.match.verbatim ? "yes" : "no") : "-",
        r.match ? r.match.coverage : "-",
        r.match?.missingNumbers.join(", ") || "-",
        r.gemma ? ("verdict" in r.gemma ? r.gemma.verdict : `error: ${r.gemma.error}`) : "-",
        r.fetch.how,
        r.key,
      ]),
    ),
    "",
    "## Method",
    "",
    "- Each fact's link was fetched again for this check: Wikipedia through its API (the whole article as plain text; the research step read only the intro), other pages as HTML turned into text. Google Maps listings and Google result pages have no page text to fetch, so their facts are listed as not checkable.",
    "- \"Word for word\": the page contains the fact (or each of its sentences) after folding case, accents and punctuation. These count as held without a model.",
    "- The rest went to Gemma with the page passage (up to 3 sentences) that shares the most words with the fact. Gemma's answer is a pre-check; an agent or owner verdict in the review file replaces it, and the \"Decided by\" column says whose verdict counts.",
    "- A page may have changed since the quest was generated; a miss can mean the page changed, not that the research step copied it wrong.",
    "- This checks that the game repeats its source faithfully, not that the source is right: a held fact is only as true as its page.",
    "- Wikipedia facts are whole sentences cut from the article's intro, so most match word for word; the check catches sentence-splitting slips, merged sentences and pages that changed.",
    "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
