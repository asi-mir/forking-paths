/**
 * Runs each desk-demo sample photo (public/demo/, see credits.json) through the photo check 10
 * times with GPS missing, as the desk demo does, and stores one verdict per photo in
 * src/quest/__fixtures__/demo-verdicts.json. The desk demo uses a stored verdict only when the
 * live reader fails, is rate-limited or times out (and labels it "stored result").
 *
 * At the fork (P1) each run also applies the fork rule, so the log shows which next stop each
 * photo leads to: the two fork photos must lead to two different stops in every run.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/store-demo-verdicts.ts [--runs 10] [--provider google|ollama] [--only id1,id2]
 *     [--log path.json] [--dry]
 *
 * --dry prints the tally and writes nothing. A reader that is not configured: "skipped: NAME not
 * set", exit 0. The photo is read from disk, sent to the reader and dropped: nothing stores it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { modelLabel, resolveModelConfig } from "../src/lib/model";
import { gemmaMeaningPicker } from "../src/mastra/agents/reader";
import { demoQuest } from "../src/quest/demo";
import { demoSamples, StoredVerdictsSchema, type StoredSample } from "../src/quest/demo-samples";
import { pickNext } from "../src/quest/fork";
import { checkPhoto } from "../src/quest/photo-check";
import { isFork, placeById } from "../src/quest/routes";
import type { Verdict } from "../src/quest/schema";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const RUNS = Number(option("runs") ?? 10);
const provider = option("provider");
const env: Record<string, string | undefined> = provider
  ? { ...process.env, GEMMA_PROVIDER: provider, GEMMA_READER_PROVIDER: provider }
  : { ...process.env };
const only = option("only")?.split(",");
const OUT = resolve(process.cwd(), "src/quest/__fixtures__/demo-verdicts.json");

type RunRow = {
  sample: string;
  run: number;
  verdict: Verdict | null;
  passed: boolean;
  next: string | null;
  chosenBy: string | null;
  latencyMs: number | null;
  error: string | null;
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

async function main() {
  let config;
  try {
    config = resolveModelConfig("reader", env);
  } catch (error) {
    console.log(`skipped: ${(error as Error).message}`);
    return;
  }
  if (config.provider === "google" && !env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return;
  }
  const reader = modelLabel(config);
  const timeoutMs = config.provider === "ollama" ? 240_000 : 60_000;
  const quest = demoQuest();
  const samples = demoSamples().filter((s) => !only || only.includes(s.id));
  console.log(`reader ${reader}; ${samples.length} photos x ${RUNS} runs, GPS missing`);

  const rows: RunRow[] = [];
  for (const sample of samples) {
    const data = new Uint8Array(readFileSync(join(process.cwd(), "public/demo", sample.file)));
    const place = placeById(quest, sample.placeId)!;
    for (let run = 1; run <= RUNS; run += 1) {
      const check = await checkPhoto(
        { quest, placeId: sample.placeId, image: { data, mediaType: "image/jpeg" }, position: null },
        { env, timeoutMs, tags: { questId: quest.id, placeId: sample.placeId } },
      );
      let next: string | null = null;
      let chosenBy: string | null = null;
      if (check.verdict && check.decision.passed && isFork(place)) {
        const fork = await pickNext(quest, place.id, check.verdict, {
          byMeaning: gemmaMeaningPicker({ env, timeoutMs }),
        });
        next = fork.link.to;
        chosenBy = fork.chosenBy;
      } else if (check.decision.passed && place.links.length === 1) {
        next = place.links[0].to;
        chosenBy = "only-link";
      }
      const row: RunRow = {
        sample: sample.id,
        run,
        verdict: check.verdict,
        passed: check.decision.passed,
        next,
        chosenBy,
        latencyMs: check.latencyMs,
        error: check.readerError,
      };
      rows.push(row);
      console.log(
        `${sample.id} #${run}: ${row.error ? `error ${row.error}` : `cue ${row.verdict?.cue ?? "null"}, plausible ${row.verdict?.plausible} ${row.verdict?.confidence}, ${row.passed ? "pass" : "fail"}${next ? ` -> ${next} (${chosenBy})` : ""}, ${row.latencyMs} ms, "${row.verdict?.observed}"`}`,
      );
    }
  }

  const existing = existsSync(OUT) ? StoredVerdictsSchema.parse(JSON.parse(readFileSync(OUT, "utf8"))) : null;
  const stored: Record<string, StoredSample> = { ...(existing?.samples ?? {}) };
  for (const sample of samples) {
    const mine = rows.filter((r) => r.sample === sample.id);
    const ok = mine.filter((r) => r.verdict);
    const cues: Record<string, number> = {};
    for (const r of ok) cues[String(r.verdict!.cue)] = (cues[String(r.verdict!.cue)] ?? 0) + 1;
    const next: Record<string, number> = {};
    for (const r of mine) if (r.next && sample.cue) next[r.next] = (next[r.next] ?? 0) + 1;
    // The stored verdict: a passing read with the most common cue, with the median confidence.
    const top = Object.entries(cues).sort((a, b) => b[1] - a[1])[0]?.[0];
    const pool = ok.filter((r) => String(r.verdict!.cue) === top && r.passed);
    const pick = pool.sort((a, b) => a.verdict!.confidence - b.verdict!.confidence)[Math.floor(pool.length / 2)];
    const latencies = mine.flatMap((r) => (r.error || r.latencyMs === null ? [] : [r.latencyMs]));
    if (!pick) {
      console.log(`${sample.id}: no passing read; nothing stored`);
      continue;
    }
    stored[sample.id] = {
      verdict: pick.verdict!,
      runs: mine.length,
      passed: mine.filter((r) => r.passed).length,
      cues,
      ...(sample.cue ? { next } : {}),
      errors: mine.filter((r) => r.error).length,
      latencyMs: latencies.length ? { p50: percentile(latencies, 50), p95: percentile(latencies, 95) } : null,
    };
    console.log(`${sample.id}: passed ${stored[sample.id].passed}/${mine.length}, cues ${JSON.stringify(cues)}${sample.cue ? `, next ${JSON.stringify(next)}` : ""}`);
  }

  // A6, desk part: in run i, do the two fork photos lead to two different next stops?
  const forkIds = samples.filter((s) => s.cue).map((s) => s.id);
  if (forkIds.length === 2) {
    let distinct = 0;
    for (let run = 1; run <= RUNS; run += 1) {
      const [a, b] = forkIds.map((id) => rows.find((r) => r.sample === id && r.run === run)?.next ?? null);
      if (a && b && a !== b) distinct += 1;
    }
    console.log(`fork photos lead to two different next stops in ${distinct} of ${RUNS} runs`);
  }

  const log = option("log");
  if (log) writeFileSync(resolve(log), JSON.stringify({ reader, at: new Date().toISOString(), runs: RUNS, rows }, null, 2) + "\n");
  if (args.includes("--dry")) return;
  const out = StoredVerdictsSchema.parse({ questId: quest.id, reader, at: new Date().toISOString(), samples: stored });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
