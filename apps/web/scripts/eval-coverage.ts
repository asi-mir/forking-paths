/**
 * SerpApi coverage: for each point of eval/coverage-points.ts (5 cities × centre, residential,
 * edge), how many places within 900 m the research step finds from Wikipedia alone, and how many
 * with SerpApi Google Maps added (Maps searches only: at most 2 per point, cached, paced).
 * Also: whether the app's route planner finds a 15-minute route (4 places, hops ≤ 250 m) among
 * the top 12 candidates.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/eval-coverage.ts [--no-spend] [--cities Istanbul,Rome]
 *     [--max-per-hour 45] [--out-dir <dir>] [--date YYYY-MM-DD]
 *
 * --no-spend (or no SERPAPI_API_KEY): Wikipedia only; the SerpApi columns say "skipped".
 * Searches go through the app's cache and daily budget (MONGODB_DB), so a rerun is free.
 * Reports: <out-dir>/<date>-coverage.md and .json (default out-dir eval/runs).
 */
import { COVERAGE_POINTS, type CoveragePoint } from "../eval/coverage-points";
import type { ResearchCandidate } from "../src/research";
import { commandLine, flag, listOption, loadEnv, numberOption, option, sleep, writeReport } from "../eval/common";

loadEnv();
if (flag("no-spend")) delete process.env.SERPAPI_API_KEY;

/** "Few places": fewer than this many places with a fact. */
const FEW = 5;
const HOUR_MS = 3_600_000;

type Row = CoveragePoint & {
  wiki: { found: number; withFact: number; route15: boolean; warnings: string[] };
  maps:
    | { skipped: string }
    | {
        mapsFound: number;
        mergedFound: number;
        serpapiOnlyFound: number;
        withFact: number;
        serpapiOnlyWithFact: number;
        route15: boolean;
        searches: number;
        cacheHits: number;
        limited?: string;
        warnings: string[];
      };
};

async function main() {
  const { research } = await import("../src/research");
  const { routeOptions } = await import("../src/quest/plan");
  const { getStore } = await import("../src/lib/store");
  const { roundCenter } = await import("../src/lib/geo");

  const cities = listOption("cities");
  const points = COVERAGE_POINTS.filter((p) => !cities || cities.includes(p.city));
  const spend = !!process.env.SERPAPI_API_KEY?.trim();
  const maxPerHour = numberOption("max-per-hour", 45);
  const made: number[] = []; // times of real SerpApi searches in this run
  if (!spend) console.log("skipped: SERPAPI_API_KEY not set (or --no-spend): Wikipedia only");

  const route15 = (candidates: ResearchCandidate[], at: { lat: number; lng: number }) => {
    const top = candidates.slice(0, 12); // what the app's generate step hands the planner
    const factCount = Object.fromEntries(top.map((c) => [c.id, c.factIds.length]));
    return routeOptions(top, roundCenter(at), 15, { factCount, limit: 1 }).length > 0;
  };

  const rows: Row[] = [];
  for (const p of points) {
    const at = { lat: p.lat, lng: p.lng };
    // No time zone: opening hours are not used, so the counts do not depend on the hour of the run.
    const wiki = await research({ ...at, serpapi: "off", maxCandidates: 100 });
    const row: Row = {
      ...p,
      wiki: { found: wiki.stats.placesFound.wikipedia, withFact: wiki.candidates.length, route15: route15(wiki.candidates, at), warnings: wiki.warnings },
      maps: { skipped: "no key" },
    };
    if (spend) {
      // Pace: at most `maxPerHour` real searches in any hour of this run (2 per point at most).
      for (;;) {
        const recent = made.filter((t) => Date.now() - t < HOUR_MS);
        if (recent.length + 2 <= maxPerHour) break;
        const wait = HOUR_MS - (Date.now() - recent[0]) + 1_000;
        console.log(`pacing: ${recent.length} SerpApi searches in the last hour; waiting ${Math.round(wait / 1000)} s`);
        await sleep(wait);
      }
      const r = await research({ ...at, serpapi: "maps", maxSerpapiSearches: 2, maxCandidates: 100 });
      for (let i = 0; i < r.stats.serpapiSearches; i++) made.push(Date.now());
      row.maps = {
        mapsFound: r.stats.placesFound.maps,
        mergedFound: r.stats.placesFound.merged,
        serpapiOnlyFound: r.stats.placesFound.serpapiOnly,
        withFact: r.candidates.length,
        serpapiOnlyWithFact: r.stats.serpapiOnlyCandidates,
        route15: route15(r.candidates, at),
        searches: r.stats.serpapiSearches,
        cacheHits: r.stats.serpapiCacheHits,
        ...(r.stats.serpapiLimited ? { limited: r.stats.serpapiLimited } : {}),
        warnings: r.warnings,
      };
    }
    rows.push(row);
    const m = row.maps;
    console.log(
      `${p.city} ${p.kind} (${p.area}): Wikipedia ${row.wiki.found} found, ${row.wiki.withFact} with a fact, route ${row.wiki.route15 ? "yes" : "no"}` +
        ("skipped" in m ? "; SerpApi skipped" : `; + Maps ${m.mergedFound} found (${m.serpapiOnlyFound} only on Maps), ${m.withFact} with a fact, route ${m.route15 ? "yes" : "no"}; searches ${m.searches}, cached ${m.cacheHits}${m.limited ? `, limited: ${m.limited}` : ""}`),
    );
  }
  await getStore().close();

  const md = report(rows, spend);
  const files = writeReport("coverage", md, { at: new Date().toISOString(), command: commandLine(), radiusM: 900, few: FEW, rows });
  console.log(`\n${md}\nwrote ${files.md} and ${files.json}`);
}

function report(rows: Row[], spend: boolean): string {
  const few = rows.filter((r) => r.wiki.withFact < FEW);
  const withMaps = rows.filter((r) => !("skipped" in r.maps));
  const mapsOf = (r: Row) => (!("skipped" in r.maps) ? r.maps : null);
  // Same measure on both sides: places with a fact. The places Maps lists (with or without one)
  // are a secondary, looser count.
  const lifted = few.filter((r) => (mapsOf(r)?.withFact ?? 0) >= FEW);
  const liftedListed = few.filter((r) => (mapsOf(r)?.mergedFound ?? 0) >= FEW);
  const routeWiki = rows.filter((r) => r.wiki.route15).length;
  const routeMaps = withMaps.filter((r) => mapsOf(r)!.route15).length;
  const searches = withMaps.reduce((s, r) => s + mapsOf(r)!.searches, 0);
  const cached = withMaps.reduce((s, r) => s + mapsOf(r)!.cacheHits, 0);
  const cities = [...new Set(rows.map((r) => r.city))];
  const yes = (b: boolean) => (b ? "yes" : "no");

  const table = [
    "| City | Point | Area | Wikipedia: places | with a fact | 15-min route | + Maps: places | only on Maps | with a fact | 15-min route | Searches (cached) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const m = mapsOf(r);
      return `| ${r.city} | ${r.kind} | ${r.area} | ${r.wiki.found} | ${r.wiki.withFact} | ${yes(r.wiki.route15)} | ${m ? m.mergedFound : "skipped"} | ${m ? m.serpapiOnlyFound : "-"} | ${m ? m.withFact : "-"} | ${m ? yes(m.route15) : "-"} | ${m ? `${m.searches} (${m.cacheHits})${m.limited ? ` ${m.limited}` : ""}` : "-"} |`;
    }),
  ].join("\n");

  return [
    `# SerpApi coverage (${option("date") ?? new Date().toISOString().slice(0, 10)})`,
    "",
    `Command: \`${commandLine()}\``,
    "",
    "## Headline",
    "",
    `- Points: ${rows.length} (${cities.length} cities: ${cities.join(", ")}; centre, residential and edge each). Radius 900 m.`,
    `- **In ${few.length} of ${rows.length} points Wikipedia alone had fewer than ${FEW} places with a fact.**`,
    spend
      ? `- **With SerpApi Google Maps added, ${lifted.length} of those ${few.length} points had ${FEW} or more places with a fact** (a Wikipedia sentence or a Maps description; the same measure as the line above).`
      : "- SerpApi was not run (no key or --no-spend): the Maps columns are empty.",
    spend
      ? `- Looser count, not the same measure: ${liftedListed.length} of those ${few.length} points had ${FEW} or more places listed (any place Wikipedia or Maps lists within 900 m, with or without a fact).`
      : "",
    `- A 15-minute route (4 places, hops ≤ 250 m, from the app's top 12) exists in ${routeWiki} of ${rows.length} points from Wikipedia alone${spend ? `, and in ${routeMaps} of ${withMaps.length} with Maps places that have a Maps description` : ""}.`,
    spend ? `- SerpApi searches made: ${searches} real, ${cached} from the cache (Maps only, ≤ 2 per point).` : "",
    "",
    "## Every point",
    "",
    table,
    "",
    "## Method and caveats",
    "",
    "- \"Places\" are what the research step keeps: within 900 m, a kind you can see (a fountain, a church, a monument), not a shop or an office. \"With a fact\" means the place has at least one fetched sentence it could cite (a Wikipedia intro sentence, or a Maps description).",
    "- Wikipedia is English Wikipedia GeoSearch, which returns at most 20 pages per point, so its counts stop at 20. Local-language Wikipedias were not queried.",
    "- The Maps columns use Maps searches only (\"historical landmark\" and \"fountain monument\"). The app's full research also runs up to 4 Google searches for facts about the top places, so a Maps place without a description can still become a stop; the \"with a fact\" and \"15-min route\" columns with Maps undercount that.",
    "- Opening hours are not used here (no time zone), so a courtyard or garden counts whatever the hour; the app drops gated places that are closed during the walk.",
    "- Point kinds (centre, residential, edge) were picked by hand from a map; they are labels, not measured categories. One point per kind per city is a small sample.",
    "",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
