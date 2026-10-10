/**
 * Generate one quest with the Mastra workflow "generate-quest" (research → write → validate →
 * save) and print what it cost: time, SerpApi searches, writer calls and tokens, and whether
 * the first draft passed the validator. Calls the workflow directly (no daily quest cap; the
 * SerpApi daily budget still applies). No voice.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/generate-quest.ts [--lat 41.0247 --lng 28.9744] [--minutes 15|25]
 *     [--lang en|tr] [--time-zone Europe/Istanbul] [--out <record.json>] [--no-spend]
 *     [--deadline-ms 600000]
 *
 * --deadline-ms raises the total time limit (the app's is QUEST_DEADLINE_MS), e.g. for local Ollama.
 * --no-spend runs without SerpApi (cached results and Wikipedia only).
 * --out writes a record of the run (the saved quest, the validation record, timings), without keys.
 * Variables already set (e.g. MONGODB_DB for a test database) win over .env.local.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  const before = { ...process.env };
  process.loadEnvFile(envFile);
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
}
if (flag("no-spend")) delete process.env.SERPAPI_API_KEY;

async function main() {
  // Imported after the env is loaded: the Mastra instance reads MONGODB_URI when it is created.
  const { mastra } = await import("../src/mastra");
  const { getStore } = await import("../src/lib/store");
  const { modelLabel, resolveModelConfig } = await import("../src/lib/model");
  const { roundCenter } = await import("../src/lib/geo");

  const config = resolveModelConfig("writer");
  if (config.provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return;
  }
  if (!process.env.SERPAPI_API_KEY?.trim()) console.log("SerpApi off (SERPAPI_API_KEY not set or --no-spend): cached results and Wikipedia only");

  const minutes = Number(option("minutes") ?? 15) === 25 ? 25 : 15;
  const deadlineMs = option("deadline-ms") ? Number(option("deadline-ms")) : undefined;
  // Rounded to ~100 m before the run: Mastra stores a run's input in its snapshots and traces.
  const center = roundCenter({ lat: Number(option("lat") ?? 41.0247), lng: Number(option("lng") ?? 28.9744) });
  const input = {
    ...center,
    ...(deadlineMs && Number.isInteger(deadlineMs) && deadlineMs > 0 ? { deadlineMs } : {}),
    minutes: minutes as 15 | 25,
    lang: (option("lang") === "tr" ? "tr" : "en") as "en" | "tr",
    timeZone: option("time-zone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  console.log(`writer: ${modelLabel(config)} (thinking ${config.thinking}); store: ${getStore().kind}`);
  console.log(`input: ${input.lat}, ${input.lng}, ${input.minutes} min, ${input.lang}`);

  const started = Date.now();
  const run = await mastra.getWorkflow("generateQuest").createRun();
  const result = await run.start({ inputData: input });
  const totalMs = Date.now() - started;

  const record: Record<string, unknown> = { input: { ...input }, totalMs, status: result.status, createdAt: new Date().toISOString() };
  if (result.status === "success") {
    const out = result.result;
    record.output = out;
    console.log(`status: ${out.status}${out.questId ? ` (quest ${out.questId})` : ""}`);
    console.log(`total: ${totalMs} ms; research ${out.timings.researchMs} ms; writing ${out.timings.writeMs} ms`);
    console.log(`SerpApi searches: ${out.serpapiSearches} (cache hits ${out.serpapiCacheHits}); candidates ${out.candidates}; route options ${out.routeOptions}`);
    console.log(`first draft passed: ${out.validation.firstTryOk}; repaired: ${out.validation.repaired}`);
    for (const e of out.validation.firstTryErrors) console.log(`  first-try error: ${e}`);
    for (const e of out.errors) console.log(`  final error: ${e}`);
    for (const c of out.calls) {
      console.log(`  call ${c.provider}/${c.model}: ${c.latencyMs} ms, ${c.inputTokens} in / ${c.outputTokens} out (${c.reasoningTokens} thinking)`);
    }
    if (out.questId) record.quest = await getStore().getQuest(out.questId);
  } else {
    const error = result.status === "failed" ? result.error : undefined;
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    record.error = message;
    console.log(`workflow ${result.status}: ${message}`);
  }

  const outPath = option("out");
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(record, null, 2));
    console.log(`saved ${outPath}`);
  }
  await getStore().close();
  process.exit(result.status === "success" && (result.result as { status: string }).status === "ready" ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
