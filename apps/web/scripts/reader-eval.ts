/**
 * Runs the labelled photo set (eval/photos/manifest.json) through the real photo reader and
 * reports, per provider: plausibility accuracy, cue accuracy at the fork, the no-GPS pass rule's
 * accuracy, and latency p50/p95. Misses are listed, not hidden.
 *
 * Usage (from apps/web, after `pnpm eval:photos:fetch`):
 *   pnpm eval:reader [--provider ollama|google|all] [--only id1,id2] [--out results.json] [--md report.md]
 *
 * A provider that is not configured is skipped ("skipped: NAME not set") with exit code 0.
 * Ollama runs get a 240 s per-attempt timeout (a laptop under memory pressure is slow).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelLabel, resolveModelConfig, type Provider } from "../src/lib/model";
import { readPhoto } from "../src/mastra/agents/reader";
import { passRule } from "../src/quest/check";
import type { Verdict } from "../src/quest/schema";
import { cachedPath, loadManifest, type EvalPhoto } from "../eval/photos/manifest";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

type Row = {
  id: string;
  provider: Provider;
  model: string;
  offered: string[];
  expected: EvalPhoto["label"];
  verdict: Verdict | null;
  rawCue: string | null; // the cue as the model wrote it, before matching to the offered cues
  error: string | null;
  latencyMs: number;
  plausibleOk: boolean;
  cueOk: boolean;
  passOk: boolean; // the no-GPS pass rule gives the expected outcome
  repaired: boolean;
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function runProvider(provider: Provider, photos: EvalPhoto[]): Promise<Row[] | null> {
  const env: Record<string, string | undefined> = { ...process.env, GEMMA_PROVIDER: provider, GEMMA_READER_PROVIDER: provider };
  if (provider === "google" && !env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return null;
  }
  const config = resolveModelConfig("reader", env);
  const label = modelLabel(config);
  if (provider === "ollama") {
    const base = config.baseURL?.replace(/\/v1$/, "") ?? "http://127.0.0.1:11434";
    const up = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
    if (!up) {
      console.log(`skipped: Ollama not reachable at ${base}`);
      return null;
    }
  }
  const timeoutMs = provider === "ollama" ? 240_000 : 60_000;
  const rows: Row[] = [];
  for (const photo of photos) {
    const path = cachedPath(photo);
    if (!existsSync(path)) {
      console.log(`${photo.id}: not in the cache; run pnpm eval:photos:fetch`);
      continue;
    }
    const image = { data: new Uint8Array(readFileSync(path)), mediaType: "image/jpeg" };
    const started = Date.now();
    let verdict: Verdict | null = null;
    let error: string | null = null;
    let repaired = false;
    let rawCue: string | null = null;
    try {
      const result = await readPhoto({ image, placeName: photo.placeName, cues: photo.offeredCues }, { env, timeoutMs });
      verdict = result.verdict;
      repaired = result.meta.repaired;
      rawCue = result.raw.cue;
    } catch (e) {
      error = (e as Error).message;
    }
    const latencyMs = Date.now() - started;
    const pass = passRule({ gps: false }, verdict).passed;
    const row: Row = {
      id: photo.id,
      provider,
      model: label,
      offered: photo.offeredCues,
      expected: photo.label,
      verdict,
      rawCue,
      error,
      latencyMs,
      plausibleOk: verdict?.plausible === photo.label.plausible,
      cueOk: verdict !== null && verdict.cue === photo.label.cue,
      passOk: pass === photo.label.plausible,
      repaired,
    };
    rows.push(row);
    console.log(
      `${label} ${photo.id}: ${error ? `ERROR ${error}` : `plausible=${verdict!.plausible} (${verdict!.confidence}) cue=${verdict!.cue} (raw ${JSON.stringify(rawCue)}) "${verdict!.observed}"`} ` +
        `[${row.plausibleOk ? "ok" : "MISS"} plausible, ${row.cueOk || !photo.label.plausible ? "ok" : "MISS"} cue] ${latencyMs} ms`,
    );
  }
  return rows;
}

function summary(rows: Row[]) {
  const n = rows.length;
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const lat = rows.filter((r) => !r.error).map((r) => r.latencyMs);
  return {
    photos: n,
    errors: count((r) => r.error !== null),
    plausibleOk: count((r) => r.plausibleOk),
    // Cue accuracy counts street details only: a negative fails the pass rule whatever its cue.
    cueOk: count((r) => r.expected.plausible && r.cueOk),
    // Split: details whose cue is offered, and details at a fork where no offered cue fits
    // (label null: the reader should say null, and the meaning pick then decides).
    cueOffered: count((r) => r.expected.plausible && r.expected.cue !== null),
    cueOfferedOk: count((r) => r.expected.plausible && r.expected.cue !== null && r.cueOk),
    cueNone: count((r) => r.expected.plausible && r.expected.cue === null),
    cueNoneOk: count((r) => r.expected.plausible && r.expected.cue === null && r.cueOk),
    // What a random pick among the offered cues would get right on the offered-cue details.
    chance: rows
      .filter((r) => r.expected.plausible && r.expected.cue !== null)
      .reduce((sum, r) => sum + 1 / Math.max(1, r.offered.length), 0),
    twoWay: count((r) => r.expected.plausible && r.expected.cue !== null && r.offered.length === 2),
    passOk: count((r) => r.passOk),
    positives: count((r) => r.expected.plausible),
    positivePasses: count((r) => r.expected.plausible && r.passOk),
    negatives: count((r) => !r.expected.plausible),
    negativeRejects: count((r) => !r.expected.plausible && r.passOk),
    repaired: count((r) => r.repaired),
    p50Ms: percentile(lat, 50),
    p95Ms: percentile(lat, 95),
  };
}

function markdown(all: Row[]): string {
  const out: string[] = [];
  for (const model of [...new Set(all.map((r) => r.model))]) {
    const rows = all.filter((r) => r.model === model);
    const s = summary(rows);
    out.push(
      `### ${model}`,
      "",
      `- Photos: ${s.photos} (${s.positives} street details, ${s.negatives} negatives); errors: ${s.errors}; repaired answers: ${s.repaired}`,
      `- Plausible right: ${s.plausibleOk}/${s.photos}`,
      `- Cue right (street details, at a 2- or 3-way fork): ${s.cueOk}/${s.positives}`,
      `  - Offered cue fits: ${s.cueOfferedOk}/${s.cueOffered} (${s.twoWay} of ${s.cueOffered} are 2-way forks; a random pick among the offered cues gets ${s.chance.toFixed(1)}/${s.cueOffered})`,
      `  - No offered cue fits (should answer null; the meaning pick decides): ${s.cueNoneOk}/${s.cueNone}`,
      `- No-GPS pass rule right: ${s.passOk}/${s.photos} (street details passed: ${s.positivePasses}/${s.positives}; negatives refused: ${s.negativeRejects}/${s.negatives})`,
      `- Latency (successful calls): p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms`,
      "",
      "| Photo | Offered | Expected cue | Got cue | Plausible (conf.) | Observed | ms | Result |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => {
        const v = r.verdict;
        const cueMiss = r.expected.plausible && !r.cueOk;
        const result = r.error ? `error: ${r.error}` : [cueMiss ? "cue miss" : "", r.plausibleOk ? "" : "plausible miss"].filter(Boolean).join(", ") || "ok";
        return `| ${r.id} | ${r.offered.join(", ")} | ${r.expected.cue ?? "null"} | ${v ? (v.cue ?? "null") : "-"} | ${v ? `${v.plausible} (${v.confidence})` : "-"} | ${v ? v.observed.replace(/\|/g, "/") : "-"} | ${r.latencyMs} | ${result} |`;
      }),
      "",
    );
  }
  return out.join("\n");
}

async function main() {
  const which = option("provider") ?? "all";
  const only = option("only")?.split(",");
  const photos = loadManifest().filter((p) => !only || only.includes(p.id));
  const providers: Provider[] = which === "all" ? ["ollama", "google"] : [which as Provider];
  const all: Row[] = [];
  for (const provider of providers) {
    const rows = await runProvider(provider, photos);
    if (rows) all.push(...rows);
  }
  if (!all.length) return;
  const md = markdown(all);
  console.log(`\n${md}`);
  const out = option("out");
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows: all }, null, 2));
  const mdOut = option("md");
  if (mdOut) writeFileSync(mdOut, md);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
