/**
 * Generate a batch of quests with the Mastra workflow "generate-quest" (research → write →
 * validate → save), one after another, and write one record per generation (the same shape as
 * `generate-quest.ts --out`, so `eval-validator.ts --records <dir>` reads them) plus a summary
 * table. Calls the workflow directly: no daily quest cap and no reuse of saved quests. No voice.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/generate-batch.ts --runs karakoy:15,karakoy:25,london:15
 *     --records <dir> [--label before] [--serpapi-per-hour 45] [--deadline-ms 240000]
 *
 * --runs   point:minutes pairs; the points are listed in BATCH_POINTS below.
 * --label  goes into every record and file name (e.g. "before" and "after" a prompt change).
 * --serpapi-per-hour  waits before a generation when the searches made in the last hour (read
 *   from the records in --records) plus the 6 a new quest may make would pass this number.
 * --gap-s  seconds to wait between generations (default 60): the AI Studio free tier counts
 *   input tokens per minute (16,000 for gemma-4-31b), and one writer prompt is ~5,500 tokens.
 * A writer error that looks like a rate limit (HTTP 429) waits for the time the API asks
 * ("retry in N s") plus 60 s and runs that generation once more (the research is cached by
 * then, so the retry costs no SerpApi search).
 * Variables already set (MONGODB_DB, BUDGET_SERPAPI_PER_DAY) win over .env.local.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv, option, sleep } from "../eval/common";

loadEnv();

export type BatchPoint = { id: string; city: string; area: string; lat: number; lng: number; timeZone: string };

/** Public squares and streets in cities of different kinds (old port, grid, boulevard, waterfront). */
export const BATCH_POINTS: readonly BatchPoint[] = [
  { id: "karakoy", city: "Istanbul", area: "Karaköy", lat: 41.0247, lng: 28.9744, timeZone: "Europe/Istanbul" },
  { id: "london", city: "London", area: "Trafalgar Square", lat: 51.508, lng: -0.1281, timeZone: "Europe/London" },
  { id: "newyork", city: "New York", area: "Flatiron", lat: 40.7411, lng: -73.9897, timeZone: "America/New_York" },
  { id: "berlin", city: "Berlin", area: "Mitte (Gendarmenmarkt)", lat: 52.5136, lng: 13.3927, timeZone: "Europe/Berlin" },
  { id: "bengaluru", city: "Bengaluru", area: "MG Road", lat: 12.9755, lng: 77.6068, timeZone: "Asia/Kolkata" },
  { id: "sanfrancisco", city: "San Francisco", area: "Ferry Building", lat: 37.7955, lng: -122.3937, timeZone: "America/Los_Angeles" },
  { id: "lisbon", city: "Lisbon", area: "Baixa", lat: 38.7105, lng: -9.1378, timeZone: "Europe/Lisbon" },
];

const SERPAPI_PER_QUEST = 6;
const HOUR_MS = 3_600_000;

type Run = { point: BatchPoint; minutes: 15 | 25 };

function parseRuns(raw: string | undefined): Run[] {
  if (!raw) throw new Error("--runs is required, e.g. --runs karakoy:15,london:15");
  return raw.split(",").map((pair) => {
    const [id, m] = pair.trim().split(":");
    const point = BATCH_POINTS.find((p) => p.id === id);
    if (!point) throw new Error(`unknown point "${id}" (known: ${BATCH_POINTS.map((p) => p.id).join(", ")})`);
    return { point, minutes: m === "25" ? 25 : 15 };
  });
}

/** SerpApi searches the records in `dir` (and its retries/) made in the last hour. */
function searchesLastHour(dir: string, now = Date.now()): { used: number; oldest?: number } {
  let used = 0;
  let oldest: number | undefined;
  const retries = join(dir, "retries");
  const files = [
    ...readdirSync(dir).map((f) => join(dir, f)),
    ...(existsSync(retries) ? readdirSync(retries).map((f) => join(retries, f)) : []),
  ].filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const r = JSON.parse(readFileSync(file, "utf8")) as { createdAt?: string; research?: { serpapiSearches?: number } };
      const at = r.createdAt ? Date.parse(r.createdAt) : NaN;
      const n = r.research?.serpapiSearches ?? 0;
      if (!n || !(now - at < HOUR_MS)) continue;
      used += n;
      oldest = oldest === undefined ? at : Math.min(oldest, at);
    } catch {
      // not a record
    }
  }
  return { used, oldest };
}

const looksRateLimited = (text: string) => /\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(text);

type Fact = { id: string; source: string; placeId?: string };

async function main() {
  const runs = parseRuns(option("runs"));
  const dir = resolve(option("records") ?? "eval/runs/batch");
  mkdirSync(dir, { recursive: true });
  const label = option("label") ?? "batch";
  const perHour = Number(option("serpapi-per-hour") ?? 45);
  const deadlineMs = option("deadline-ms") ? Number(option("deadline-ms")) : undefined;
  const gapMs = Number(option("gap-s") ?? 60) * 1000;

  // Imported after the env is loaded: the Mastra instance reads MONGODB_URI when it is created.
  const { mastra } = await import("../src/mastra");
  const { getStore } = await import("../src/lib/store");
  const { modelLabel, resolveModelConfig } = await import("../src/lib/model");
  const { roundCenter } = await import("../src/lib/geo");
  const { budgetStatus } = await import("../src/lib/budget");
  // The daily SerpApi counter counts every search made, also by a research step that then failed.
  const serpapiUsed = async () => (await budgetStatus("serpapi")).used;

  const config = resolveModelConfig("writer");
  if (config.provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return;
  }
  const serpapiOn = !!process.env.SERPAPI_API_KEY?.trim();
  const writer = `${config.provider}/${config.modelId} (thinking ${config.thinking})`;
  console.log(`writer: ${modelLabel(config)} (thinking ${config.thinking}); research: ${serpapiOn ? "SerpApi + Wikipedia" : "Wikipedia only"}; store: ${getStore().kind}`);

  const summary: string[][] = [];
  for (const [i, run] of runs.entries()) {
    const { point, minutes } = run;
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    // Pace SerpApi: a generation may make up to 6 searches.
    if (serpapiOn) {
      for (;;) {
        const { used, oldest } = searchesLastHour(dir);
        if (used + SERPAPI_PER_QUEST <= perHour || oldest === undefined) break;
        const waitMs = Math.max(30_000, oldest + HOUR_MS - Date.now() + 1_000);
        console.log(`SerpApi pacing: ${used} searches in the last hour; waiting ${Math.round(waitMs / 1000)} s`);
        await sleep(waitMs);
      }
    }
    const center = roundCenter({ lat: point.lat, lng: point.lng });
    const input = { ...center, minutes, lang: "en" as const, timeZone: point.timeZone, ...(deadlineMs ? { deadlineMs } : {}) };
    let record: Record<string, unknown> = {};
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`\n[${i + 1}/${runs.length}] ${point.city}, ${point.area} (${center.lat}, ${center.lng}), ${minutes} min, attempt ${attempt}`);
      const usedBefore = await serpapiUsed();
      const started = Date.now();
      const wf = await mastra.getWorkflow("generateQuest").createRun();
      const result = await wf.start({ inputData: input });
      const totalMs = Date.now() - started;
      const counted = (await serpapiUsed()) - usedBefore;
      const steps = result.steps as Record<string, { status?: string; output?: Record<string, unknown> }>;
      const r = steps.research?.output as
        | { facts?: Fact[]; candidates?: Array<{ sources: string[] }>; serpapiSearches?: number; serpapiCacheHits?: number; researchMs?: number; warnings?: string[]; options?: unknown[] }
        | undefined;
      const factsBySource: Record<string, number> = {};
      for (const f of r?.facts ?? []) factsBySource[f.source] = (factsBySource[f.source] ?? 0) + 1;
      record = {
        input: { ...input },
        label,
        point: { id: point.id, city: point.city, area: point.area },
        writer,
        totalMs,
        status: result.status,
        createdAt: new Date().toISOString(),
        attempt,
        research: {
          mode: serpapiOn ? "serpapi+wikipedia" : "wikipedia",
          serpapiSearches: r?.serpapiSearches ?? Math.max(0, counted),
          serpapiCounted: counted,
          serpapiCacheHits: r?.serpapiCacheHits ?? 0,
          researchMs: r?.researchMs,
          candidates: r?.candidates?.length ?? 0,
          facts: r?.facts?.length ?? 0,
          factsBySource,
          routeOptions: r?.options?.length ?? 0,
          warnings: r?.warnings ?? [],
        },
      };
      let retryText = "";
      if (result.status === "success") {
        const out = result.result;
        record.output = out;
        if (out.questId) record.quest = await getStore().getQuest(out.questId);
        retryText = out.errors.join(" ");
        console.log(`status ${out.status}; first draft ${out.validation.firstTryOk ? "passed" : "failed"}; repaired ${out.validation.repaired}; ${totalMs} ms`);
        for (const e of out.validation.firstTryErrors) console.log(`  first-try error: ${e}`);
        for (const e of out.errors) console.log(`  final error: ${e}`);
      } else {
        const error = result.status === "failed" ? result.error : undefined;
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        record.error = message;
        retryText = message ?? "";
        console.log(`workflow ${result.status}: ${message}`);
      }
      if (attempt === 1 && looksRateLimited(retryText)) {
        const asked = Number(/retry in ([\d.]+)\s*s/i.exec(retryText)?.[1] ?? 0);
        const waitS = Math.ceil(asked) + 60;
        console.log(`writer looks rate-limited: waiting ${waitS} s, then one more try`);
        mkdirSync(join(dir, "retries"), { recursive: true });
        writeFileSync(join(dir, "retries", `${label}-${point.id}-${minutes}-${Date.now()}.json`), JSON.stringify(record, null, 2));
        await sleep(waitS * 1000);
        continue;
      }
      break;
    }
    const file = join(dir, `${label}-${point.id}-${minutes}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));
    const out = record.output as
      | { status: string; validation: { firstTryOk: boolean; repaired: boolean }; calls: Array<{ latencyMs: number; inputTokens: number; outputTokens: number; reasoningTokens: number }> }
      | undefined;
    const research = record.research as { serpapiSearches: number; facts: number };
    summary.push([
      point.city,
      String(minutes),
      String(research.serpapiSearches),
      String(research.facts),
      out ? out.calls.map((c) => `${(c.latencyMs / 1000).toFixed(1)} s`).join(" + ") : "-",
      out ? out.calls.map((c) => `${c.inputTokens}/${c.outputTokens}`).join(" + ") : "-",
      out ? (out.validation.firstTryOk ? "pass" : "fail") : "-",
      out ? (out.validation.repaired ? "yes" : "no") : "-",
      out?.status ?? String(record.status),
      `${(Number(record.totalMs) / 1000).toFixed(1)} s`,
    ]);
    console.log(`saved ${file}`);
  }

  const head = ["City", "Min", "SerpApi", "Facts", "Writer calls", "Tokens in/out", "First draft", "Repaired", "Status", "Total"];
  const table = [head, head.map(() => "---"), ...summary].map((row) => `| ${row.join(" | ")} |`).join("\n");
  console.log(`\n${table}`);
  writeFileSync(join(dir, `${label}-summary.md`), `${table}\n`);
  await getStore().close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
