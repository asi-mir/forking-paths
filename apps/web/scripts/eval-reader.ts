/**
 * Photo reader, Google vs. local: runs the labelled photo set (eval/photos/manifest.json, freely
 * licensed Wikimedia Commons photos, labelled by hand) through the real photo reader on each
 * provider (scripts/reader-eval.ts does one provider) and writes one report that compares them:
 * plausibility accuracy, cue-match accuracy, the no-GPS pass rule and latency p50/p95.
 *
 * Usage (from apps/web, after `pnpm eval:photos:fetch`):
 *   pnpm exec tsx scripts/eval-reader.ts [--providers ollama,google] [--from-ollama rows.json]
 *     [--from-google rows.json] [--out-dir <dir>] [--date YYYY-MM-DD]
 *
 * --from-<provider> reuses rows that `reader-eval.ts --out` wrote instead of calling the model
 * again. A provider without its key (Google) or not running (Ollama) is skipped and the report
 * says so. Reports: <out-dir>/<date>-reader.md and .json (default out-dir eval/runs).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { commandLine, listOption, loadEnv, option, today, writeReport } from "../eval/common";
import { loadManifest, type EvalPhoto } from "../eval/photos/manifest";
import { mdTable, ratio, tally } from "../src/eval/stats";
import { readerSummary } from "../src/eval/verdicts";
import type { Verdict } from "../src/quest/schema";

loadEnv();

type Row = {
  id: string;
  provider: string;
  model: string;
  offered: string[];
  expected: EvalPhoto["label"];
  verdict: Verdict | null;
  rawCue: string | null;
  error: string | null;
  latencyMs: number;
  plausibleOk: boolean;
  cueOk: boolean;
  passOk: boolean;
  repaired: boolean;
};

function rowsFor(provider: string): { rows: Row[]; skipped?: string; from: string } {
  const from = option(`from-${provider}`);
  if (from) return { rows: (JSON.parse(readFileSync(from, "utf8")) as { rows: Row[] }).rows, from };
  if (provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return { rows: [], skipped: "GOOGLE_GENERATIVE_AI_API_KEY not set", from: "-" };
  }
  mkdirSync("eval/runs", { recursive: true });
  const out = `eval/runs/${option("date") ?? today()}-reader-${provider}-rows.json`;
  rmSync(out, { force: true }); // never report rows from an earlier run as this one's
  const r = spawnSync("pnpm", ["exec", "tsx", "scripts/reader-eval.ts", "--provider", provider, "--out", out], { stdio: "inherit", env: process.env });
  if (r.status !== 0 || !existsSync(out)) return { rows: [], skipped: `reader-eval.ts exited ${r.status} or wrote no rows (provider not reachable?)`, from: "-" };
  return { rows: (JSON.parse(readFileSync(out, "utf8")) as { rows: Row[] }).rows, from: out };
}

async function main() {
  const providers = listOption("providers") ?? ["ollama", "google"];
  const photos = loadManifest();
  const runs = providers.map((p) => ({ provider: p, ...rowsFor(p) }));
  const ran = runs.filter((r) => r.rows.length);
  const models = ran.map((r) => ({ ...r, model: r.rows[0].model, s: readerSummary(r.rows) }));

  const cueCounts = tally(photos.filter((p) => p.label.plausible).map((p) => p.label.cue ?? "none fits"));
  const header = ["Measure", ...models.map((m) => m.model)];
  const line = (name: string, f: (s: ReturnType<typeof readerSummary>) => string) => [name, ...models.map((m) => f(m.s))];
  const byPhoto = photos.map((p) => {
    const cells = models.map((m) => {
      const r = m.rows.find((x) => x.id === p.id);
      if (!r) return "-";
      if (r.error) return `error`;
      const miss = [r.plausibleOk ? "" : "plausible miss", p.label.plausible && !r.cueOk ? "cue miss" : ""].filter(Boolean).join(", ");
      return `${r.verdict!.cue ?? "null"} / ${r.verdict!.plausible} ${r.latencyMs} ms${miss ? ` (${miss})` : ""}`;
    });
    return [p.id, p.offeredCues.join(", "), `${p.label.cue ?? "null"} / ${p.label.plausible}`, ...cells];
  });
  const misses = models.flatMap((m) =>
    m.rows
      .filter((r) => r.error || !r.plausibleOk || (r.expected.plausible && !r.cueOk))
      .map((r) => [m.model, r.id, r.offered.join(", "), r.expected.cue ?? "null", r.error ? `error: ${r.error}` : (r.verdict!.cue ?? "null"), r.verdict?.observed ?? "-", photos.find((p) => p.id === r.id)?.note ?? ""]),
  );

  const md = [
    `# Photo reader: Google vs. local (${option("date") ?? today()})`,
    "",
    `Command: \`${commandLine()}\``,
    "",
    "## Headline",
    "",
    ...models.map(
      (m) =>
        `- **${m.model}**: plausible right ${ratio(m.s.plausibleOk, m.s.photos)}; cue right ${ratio(m.s.cueOk, m.s.positives)} on the street details (chance on the offered-cue ones: ${m.s.chance.toFixed(1)} of ${m.s.cueOffered}); no-GPS pass rule right ${ratio(m.s.passOk, m.s.photos)}; latency p50 ${m.s.p50Ms} ms, p95 ${m.s.p95Ms} ms; errors ${m.s.errors}.`,
    ),
    ...runs.filter((r) => r.skipped).map((r) => `- ${r.provider}: skipped (${r.skipped}).`),
    "",
    "## The photo set",
    "",
    `- ${photos.length} photos from Wikimedia Commons (freely licensed; each entry in eval/photos/manifest.json names its file page, author and licence). They are not photos from a walk with the game.`,
    `- ${photos.filter((p) => p.label.plausible).length} street details (${cueCounts.map(([c, k]) => `${c} ${k}`).join(", ")}) and ${photos.filter((p) => !p.label.plausible).length} negatives (a screen, rooms at home, a wrong place).`,
    `- ${photos.filter((p) => p.id.startsWith("karakoy-")).length} are from the Karaköy desk-demo places, including both details of its first fork (an inscription to read, and the spout).`,
    "- Each photo is shown to the reader as it is at a fork: with the place's name and the cues of the fork's links (2 or 3). The labels (expected cue, plausible or not) were set by an agent from looking at each photo; the owner has not confirmed them yet.",
    "",
    "## Side by side",
    "",
    models.length
      ? mdTable(header, [
          line("Plausible right", (s) => ratio(s.plausibleOk, s.photos)),
          line("Cue right, street details", (s) => ratio(s.cueOk, s.positives)),
          line("… offered cue fits", (s) => ratio(s.cueOfferedOk, s.cueOffered)),
          line("… no offered cue fits (answer null)", (s) => ratio(s.cueNoneOk, s.cueNone)),
          line("Chance on offered-cue details", (s) => `${s.chance.toFixed(1)}/${s.cueOffered}`),
          line("No-GPS pass rule right", (s) => ratio(s.passOk, s.photos)),
          line("Street details passed (no GPS)", (s) => ratio(s.positivesPassed, s.positives)),
          line("Negatives refused (no GPS)", (s) => ratio(s.negativesRefused, s.negatives)),
          line("Latency p50 / p95", (s) => `${s.p50Ms} / ${s.p95Ms} ms`),
          line("Errors", (s) => String(s.errors)),
        ])
      : "No provider ran.",
    "",
    "## Misses",
    "",
    misses.length ? mdTable(["Model", "Photo", "Offered", "Expected cue", "Got", "Observed", "Note"], misses) : "None.",
    "",
    "## Every photo (cue / plausible, latency)",
    "",
    mdTable(["Photo", "Offered", "Expected", ...models.map((m) => m.model)], byPhoto),
    "",
    "## Method and caveats",
    "",
    "- One call per photo with the app's reader prompt and schema (`readPhoto`), temperature 0. Latency is the whole call from this machine, including any repair; Google latency depends on the free tier's load at the time.",
    "- Cue accuracy counts street details only: a negative fails the no-GPS pass rule whatever its cue. In the game, GPS near the place passes a stop whatever the reader says; the pass rule here is the no-GPS case (the desk demo).",
    `- ${photos.length} photos is a small set; one photo moves a rate by about ${Math.round(100 / Math.max(1, photos.length))} points. Several photos are reused at a different fork (\"-no-cue\" ids).`,
    "",
  ].join("\n");

  const files = writeReport("reader", md, { at: new Date().toISOString(), command: commandLine(), runs: models.map((m) => ({ provider: m.provider, model: m.model, from: m.from, summary: m.s, rows: m.rows })), skipped: runs.filter((r) => r.skipped).map((r) => ({ provider: r.provider, reason: r.skipped })) });
  console.log(`\n${md}\nwrote ${files.md} and ${files.json}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
