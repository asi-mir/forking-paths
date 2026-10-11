/**
 * Validator first try: how often Gemma's first draft of a quest passed the validator, how many
 * more passed after one repair, how many failed, and the most common errors. Reads every quest
 * generation it can find: `generate-quest.ts --out` records (they include failed generations,
 * which save no quest) and the quests stored in MongoDB. The desk demo quest is left out (it was
 * drafted by its own script and edited by hand).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/eval-validator.ts [--records <dir of generate-quest records>]
 *     [--dbs all|db1,db2] [--out-dir <dir>] [--date YYYY-MM-DD]
 *     [--generate <city,city,…|all> [--minutes 15|25]]
 *
 * --generate first runs scripts/generate-quest.ts once per city centre listed in
 * eval/coverage-points.ts (writer on Gemma; ≤ 6 SerpApi searches each; no voice) and writes each
 * record into --records. Without GOOGLE_GENERATIVE_AI_API_KEY the writer runs on Ollama.
 * Reports: <out-dir>/<date>-validator.md and .json (default out-dir eval/runs).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { COVERAGE_POINTS } from "../eval/coverage-points";
import { cityOf, commandLine, generations, listOption, loadEnv, option, readDatabases, writeReport } from "../eval/common";
import { mdTable, ratio, tally } from "../src/eval/stats";
import { errorKind, errorKinds } from "../src/eval/validator-errors";
import { validatorSummary } from "../src/eval/verdicts";

loadEnv();

function generate(recordsDir: string) {
  const want = listOption("generate") ?? [];
  const points = COVERAGE_POINTS.filter((p) => p.kind === "centre" && (want.includes("all") || want.includes(p.city)));
  if (!points.length) return;
  mkdirSync(recordsDir, { recursive: true });
  const minutes = option("minutes") === "25" ? "25" : "15";
  for (const p of points) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = join(recordsDir, `t12-${p.city.toLowerCase().replace(/\s+/g, "-")}-${minutes}-${stamp}.json`);
    console.log(`generating: ${p.city} (${p.lat}, ${p.lng}), ${minutes} min → ${out}`);
    const r = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/generate-quest.ts", "--lat", String(p.lat), "--lng", String(p.lng), "--minutes", minutes, "--time-zone", p.timeZone, "--out", out],
      { stdio: "inherit", env: process.env },
    );
    console.log(`  exit ${r.status}`);
  }
}

async function main() {
  const recordsDir = option("records") ? resolve(option("records")!) : undefined;
  if (option("generate")) {
    if (!recordsDir) throw new Error("--generate needs --records <dir> to write the records into");
    generate(recordsDir);
  }
  const sources = await readDatabases();
  const all = generations(sources, recordsDir);
  const gens = all.filter((g) => !g.demo);
  if (!gens.length) {
    console.log("No generated quests found (pass --records <dir> and/or --dbs all).");
    return;
  }
  const s = validatorSummary(gens);
  if (s.firstTry + s.afterRepair + s.failed !== s.drafted) throw new Error("validator buckets do not add up to the drafted count");
  const firstErrors = gens.flatMap((g) => (g.validation && !g.validation.firstTryOk ? errorKinds(g.validation.firstTryErrors) : []));
  const firstMessages = gens.flatMap((g) => (g.validation && !g.validation.firstTryOk ? g.validation.firstTryErrors : []));
  const finalErrors = gens.filter((g) => g.status === "failed").flatMap((g) => errorKinds(g.finalErrors));
  const byCity = tally(gens.map((g) => cityOf(g.center)));
  const byWriter = tally(gens.map((g) => g.writer ?? "unknown"));

  const rows = gens.map((g) => [
    g.createdAt?.slice(0, 16).replace("T", " ") ?? "-",
    cityOf(g.center),
    g.minutes ?? "-",
    g.writer ?? "-",
    g.validation ? (g.validation.firstTryOk ? "yes" : "no") : "no draft",
    g.validation ? (g.validation.firstTryOk ? "-" : g.status === "ready" ? "passed" : "failed") : "-",
    g.status,
    g.validation && !g.validation.firstTryOk ? errorKinds(g.validation.firstTryErrors).join("; ") : g.error ?? "",
    g.source,
  ]);

  const md = [
    `# Validator first try (${option("date") ?? new Date().toISOString().slice(0, 10)})`,
    "",
    `Command: \`${commandLine()}\``,
    `Read: ${sources.dbs.length ? `databases ${sources.dbs.join(", ")}` : "no database"}${recordsDir ? `; records in ${recordsDir.split("/").slice(-2).join("/")}` : ""}. The desk demo quest is left out.`,
    "",
    "## Headline",
    "",
    `- Generations found: ${s.generations} (${byCity.map(([c, n]) => `${c} ${n}`).join(", ")}); writer: ${byWriter.map(([w, n]) => `${w} ${n}`).join(", ")}.`,
    `- With a draft to validate: ${s.drafted}. ${s.noDraft} generation(s) ended before any draft (the writer call failed or timed out).`,
    `- **First draft passed the validator: ${ratio(s.firstTry, s.drafted)}.**`,
    `- Passed after one repair: ${s.afterRepair}. Failed (after the repair, or no time left for one): ${s.failed}. (${s.firstTry} + ${s.afterRepair} + ${s.failed} = ${s.drafted} drafts.)`,
    s.mismatch.length ? `- Status and validation disagree for ${s.mismatch.length} generation(s), counted by validation as above: ${s.mismatch.join(", ")}.` : "",
    "",
    "## First-draft errors, by kind (each kind counted once per draft)",
    "",
    firstErrors.length ? mdTable(["Kind", "Drafts"], tally(firstErrors)) : "None: every first draft passed.",
    "",
    firstMessages.length ? `All ${firstMessages.length} first-try messages, by kind: ${tally(firstMessages.map(errorKind)).map(([k, n]) => `${k} ${n}`).join("; ")}.` : "",
    "",
    "## Errors of failed generations (after the repair)",
    "",
    finalErrors.length ? mdTable(["Kind", "Generations"], tally(finalErrors)) : "None.",
    "",
    "## Every generation",
    "",
    mdTable(["Created (UTC)", "Where", "Min", "Writer", "First try", "Repair", "Status", "First-try errors / failure", "Source"], rows),
    "",
    "## Caveats",
    "",
    `- ${s.drafted} drafts is a small sample: one more failure moves the rate by ${s.drafted ? Math.round(100 / s.drafted) : 0} points.${s.generations < 10 ? ` Fewer than 10 generations: treat the rate as a first look, not a result.` : ""}`,
    "- The runs span several builds of the app: the writer prompt (and in places the validator) changed between some of them.",
    "",
  ].join("\n");

  const files = writeReport("validator", md, { at: new Date().toISOString(), command: commandLine(), summary: s, firstErrorKinds: tally(firstErrors), generations: gens.map(({ quest, ...g }) => ({ ...g, questTitle: quest?.title })) });
  console.log(md);
  console.log(`wrote ${files.md} and ${files.json}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
