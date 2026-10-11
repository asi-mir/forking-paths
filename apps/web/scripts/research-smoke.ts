/**
 * Smoke test for the research step: prints the candidate places and their cited facts for a
 * point (default Karaköy, Istanbul) and the SerpApi searches it used.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/research-smoke.ts [--lat 41.0247 --lng 28.9744] [--lang en|tr]
 *     [--minutes 25] [--time-zone Europe/Istanbul] [--wikipedia-only] [--maps-only]
 *     [--record <dir>] [--json <file>] [--no-spend]
 *
 * Without SERPAPI_API_KEY it runs on Wikipedia only ("skipped: SERPAPI_API_KEY not set").
 * --no-spend uses cached SerpApi results only (shows which searches a run would make).
 * --record writes every response (slimmed, with no key) as a fixture. Exit code 1 only when
 * a run with SerpApi misses the check (≥ 6 candidates within the radius, each with a fact that
 * has a query and a link, ≤ 6 SerpApi searches).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getStore } from "../src/lib/store";
import { research, MAX_SERPAPI_PER_QUEST, type ExternalResponse, type ResearchInput } from "../src/research";
import { scrub } from "../src/research/serpapi";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// Variables already set (e.g. MONGODB_DB for a test database) win over the file.
const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  const before = { ...process.env };
  process.loadEnvFile(envFile);
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
}

const apiKey = process.env.SERPAPI_API_KEY?.trim() ?? "";
if (flag("no-spend")) delete process.env.SERPAPI_API_KEY;
const secrets = [apiKey].filter((s) => s.length > 8);

const lat = Number(option("lat") ?? 41.0247);
const lng = Number(option("lng") ?? 28.9744);
const lang = option("lang") === "tr" ? "tr" : "en";
const minutes = Number(option("minutes") ?? 25);
const timeZone = option("time-zone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
let mode: ResearchInput["serpapi"] = flag("wikipedia-only") ? "off" : flag("maps-only") ? "maps" : "all";
if (!apiKey && !flag("no-spend") && mode !== "off") {
  console.log("skipped: SERPAPI_API_KEY not set (running on Wikipedia only)");
  mode = "off";
}

const recordDir = option("record");
const responses: ExternalResponse[] = [];

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

async function main() {
  const store = getStore();
  console.log(`store: ${store.kind}${store.kind === "mongo" ? ` (${process.env.MONGODB_DB ?? "default db"})` : ""}`);
  console.log(`point: ${lat}, ${lng} · lang ${lang} · ${minutes} min · time zone ${timeZone} · SerpApi: ${mode}`);

  const result = await research(
    { lat, lng, lang, minutes, timeZone, serpapi: mode },
    { onResponse: (r) => responses.push(r) },
  );

  console.log("\nLookups:");
  for (const l of result.lookups) console.log(`  ${l.outcome.padEnd(8)} ${l.source.padEnd(15)} ${l.query}${l.reason ? `  (${l.reason})` : ""}`);
  for (const w of result.warnings) console.log(`  warning: ${w}`);

  const facts = new Map(result.facts.map((f) => [f.id, f]));
  console.log(`\nCandidates (${result.candidates.length}):`);
  for (const c of result.candidates) {
    const flags = [c.gated ? "gated" : "", c.openNow === true ? "open" : c.openNow === false ? "closed" : ""].filter(Boolean).join(",");
    console.log(`  ${c.id} ${c.name}  ${c.distanceM} m  [${c.sources.join("+")}]${flags ? ` (${flags})` : ""}  ${c.factIds.length} facts`);
    if (c.altNames.length) console.log(`       also: ${c.altNames.join("; ")}`);
    for (const id of c.factIds) {
      const f = facts.get(id)!;
      console.log(`     ${f.id} [${f.source}] ${f.text.slice(0, 110)}${f.text.length > 110 ? "…" : ""}`);
      console.log(`        query: ${f.query}`);
      console.log(`        link:  ${f.sourceUrl}`);
    }
  }
  const area = result.facts.filter((f) => !f.placeId);
  if (area.length) {
    console.log(`\nArea facts (${area.length}):`);
    for (const f of area) console.log(`  ${f.id} ${f.text.slice(0, 110)}${f.text.length > 110 ? "…" : ""}  (${f.sourceUrl})`);
  }

  const s = result.stats;
  console.log("\nStats:");
  console.log(`  SerpApi searches made: ${s.serpapiSearches} (cached: ${s.serpapiCacheHits}, cap ${MAX_SERPAPI_PER_QUEST})${s.serpapiLimited ? ` · limited: ${s.serpapiLimited}` : ""}`);
  console.log(`  places found: maps ${s.placesFound.maps}, wikipedia ${s.placesFound.wikipedia}, merged ${s.placesFound.merged}, SerpApi only ${s.placesFound.serpapiOnly}`);
  console.log(`  candidates only SerpApi found: ${s.serpapiOnlyCandidates}`);
  console.log(`  gated places skipped as closed: ${s.skippedClosed.length ? s.skippedClosed.join(", ") : "none"}`);
  console.log(`  research time: ${s.researchMs} ms`);

  const inRadius = result.candidates.filter((c) => c.distanceM <= result.radiusM);
  const cited = inRadius.filter((c) => c.factIds.some((id) => facts.get(id)?.query && facts.get(id)?.sourceUrl));
  const checks = [
    { name: `≥ 6 candidates within ${result.radiusM} m`, ok: inRadius.length >= 6, got: inRadius.length },
    { name: "each with ≥ 1 fact carrying query + link", ok: cited.length === result.candidates.length && cited.length > 0, got: `${cited.length}/${result.candidates.length}` },
    { name: `≤ ${MAX_SERPAPI_PER_QUEST} SerpApi searches`, ok: s.serpapiSearches <= MAX_SERPAPI_PER_QUEST, got: s.serpapiSearches },
  ];
  console.log("\nChecks:");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.got})`);

  if (recordDir) {
    mkdirSync(recordDir, { recursive: true });
    for (const r of responses) {
      const file = join(recordDir, `${r.source}-${slug(r.query)}.json`);
      const body = JSON.stringify(scrub({ source: r.source, query: r.query, payload: r.payload }, secrets), null, 2);
      if (secrets.some((x) => body.includes(x)) || /api_key/i.test(body)) throw new Error(`refusing to write ${file}: it holds a key`);
      writeFileSync(file, `${body}\n`);
      console.log(`recorded ${file}`);
    }
  }
  const jsonOut = option("json");
  if (jsonOut) {
    writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${jsonOut}`);
  }

  await store.close();
  const failed = checks.some((c) => !c.ok);
  if (failed && mode !== "off") process.exitCode = 1;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`research smoke failed: ${secrets.reduce((m, s) => m.split(s).join("[redacted]"), msg)}`);
  process.exit(1);
});
