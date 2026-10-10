/**
 * Reveal check (fact → narration): samples the lines that state facts (reveals, link reasons,
 * mystery answers, finales of generated quests, and the bridge lines the narrator said on real
 * walks) and checks each against the facts it cites. Gemma pre-checks; a review file adds the
 * agent's and the owner's verdicts, which win over Gemma's. Misses are listed.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/eval-reveals.ts [--n 20] [--seed 20] [--records <dir>] [--dbs all|a,b]
 *     [--precheck google|ollama|none] [--review <review.json>] [--out-dir <dir>] [--date YYYY-MM-DD]
 *
 * --precheck: the provider of the Gemma pre-check (default: the narrator role's provider from env;
 * "none" skips it). The review file maps an item key (printed in the report) to
 * {"verdict": "supported" | "partly" | "unsupported", "by": "agent" | "owner", "note": "…"}.
 * Bridge lines come from walked runs of any quest, the desk demo's included (the narrator writes
 * them live); the desk demo's own lines are left out (edited by hand and checked separately).
 * Reports: <out-dir>/<date>-reveals.md and .json (default out-dir eval/runs).
 */
import { existsSync, readFileSync } from "node:fs";
import { commandLine, generations, loadEnv, numberOption, option, readDatabases, writeReport } from "../eval/common";
import { bridgeItems, questItems, revealCheckPrompt, RevealCheckSchema, uniqueItems, type CitedItem, type RevealCheck } from "../src/eval/precheck";
import { mdTable, pct, stratifiedSample, tally } from "../src/eval/stats";
import { decideReveal, type RevealReview, type RevealVerdict } from "../src/eval/verdicts";
import { numbersIn } from "../src/quest/validate";
import type { Quest } from "../src/quest/schema";

loadEnv();

type Verdict = RevealVerdict;
type Review = RevealReview;

type Row = CitedItem & {
  /** Numbers in the line that none of its cited facts contain (code check, as the validator does). */
  strayNumbers: string[];
  gemma: (RevealCheck & { model: string; ms: number }) | { error: string } | null;
  review: Review | null;
  verdict: Verdict | "not checked";
  decidedBy: "gemma pre-check" | "agent" | "owner" | "-";
};

async function precheck(item: CitedItem, provider: string | undefined): Promise<Row["gemma"]> {
  const { generateJson } = await import("../src/lib/json");
  const env = { ...process.env, ...(provider ? { GEMMA_NARRATOR_PROVIDER: provider } : {}) };
  try {
    const { data, meta } = await generateJson("narrator", RevealCheckSchema, revealCheckPrompt(item), undefined, {
      env,
      temperature: 0,
      maxOutputTokens: 400,
      timeoutMs: 180_000,
    });
    return { ...data, model: `${meta.provider}/${meta.model}`, ms: meta.latencyMs };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160) };
  }
}

function strayNumbers(item: CitedItem): string[] {
  const inFacts = new Set(item.facts.flatMap((f) => numbersIn(f.text)));
  return numbersIn(item.text).filter((n) => !inFacts.has(n));
}

async function main() {
  const n = numberOption("n", 20);
  const seed = numberOption("seed", 20);
  const precheckOpt = option("precheck");
  const reviewPath = option("review");
  const reviews: Record<string, Review> = reviewPath && existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : {};

  const sources = await readDatabases();
  const gens = generations(sources, option("records"));
  const generated = gens.filter((g) => !g.demo && g.quest && g.status === "ready").map((g) => g.quest!);
  const questById = new Map<string, Quest>(gens.filter((g) => g.quest?.id).map((g) => [g.quest!.id!, g.quest!]));
  const items = uniqueItems([
    ...generated.flatMap(questItems),
    ...sources.runs.flatMap((r) => (questById.get(r.questId) ? bridgeItems(questById.get(r.questId)!, r.path) : [])),
  ]);
  const picked = stratifiedSample(items, (i) => i.kind, n, seed);
  console.log(`${generated.length} generated quests and ${sources.runs.length} runs: ${items.length} unique cited lines; sampled ${picked.length} (seed ${seed})`);

  const rows: Row[] = [];
  for (const item of picked) {
    const review = reviews[item.key] ?? null;
    const gemma = precheckOpt === "none" ? null : await precheck(item, precheckOpt);
    const row: Row = { ...item, strayNumbers: strayNumbers(item), gemma, review, ...decideReveal(review, gemma) };
    rows.push(row);
    console.log(`${row.verdict.padEnd(12)} ${row.decidedBy.padEnd(16)} ${row.kind.padEnd(12)} ${row.text.slice(0, 80)}`);
  }

  const md = report(rows, items, generated.length, sources.runs.length, seed);
  const files = writeReport("reveals", md, { at: new Date().toISOString(), command: commandLine(), seed, rows });
  console.log(`\n${md}\nwrote ${files.md} and ${files.json}`);
}

function report(rows: Row[], pool: CitedItem[], quests: number, runs: number, seed: number): string {
  const decided = rows.filter((r) => r.verdict !== "not checked");
  const ok = decided.filter((r) => r.verdict === "supported");
  const misses = decided.filter((r) => r.verdict !== "supported");
  const gemmaRows = rows.filter((r) => r.gemma && "verdict" in r.gemma);
  const reviewed = rows.filter((r) => r.review && r.gemma && "verdict" in r.gemma);
  const agree = reviewed.filter((r) => (r.gemma as RevealCheck).verdict === r.review!.verdict);
  const models = [...new Set(gemmaRows.map((r) => (r.gemma as { model: string }).model))];
  const facts = (r: Row) => r.facts.map((f) => `${f.id}: ${f.text}`).join(" / ");

  return [
    `# Reveal check: fact → narration (${option("date") ?? new Date().toISOString().slice(0, 10)})`,
    "",
    `Command: \`${commandLine()}\``,
    "",
    "## Headline",
    "",
    `- Sample: ${rows.length} of ${pool.length} unique lines that cite facts (${quests} generated quests, bridge lines from ${runs} walked runs; spread over kinds, seed ${seed}). By kind: ${tally(rows.map((r) => r.kind)).map(([k, c]) => `${k} ${c}`).join(", ")}.`,
    `- **${ok.length} of ${decided.length} matched their cited facts** (${pct(ok.length, decided.length)}); ${misses.filter((r) => r.verdict === "partly").length} partly (a detail added or changed); ${misses.filter((r) => r.verdict === "unsupported").length} unsupported.`,
    `- Who decided: ${tally(decided.map((r) => r.decidedBy)).map(([w, c]) => `${w} ${c}`).join(", ") || "-"}. Gemma pre-check: ${models.join(", ") || "not run"}${reviewed.length ? `; it agreed with the review on ${agree.length} of ${reviewed.length}` : ""}.`,
    `- Owner confirmed: ${rows.filter((r) => r.review?.by === "owner").length} of ${rows.length} (owner verdicts go in the review file).`,
    `- Numbers check (code): ${rows.filter((r) => r.strayNumbers.length).length} line(s) with a number none of their cited facts contain.`,
    "",
    "## Misses",
    "",
    misses.length
      ? mdTable(
          ["Verdict", "Kind", "Quest", "Line", "Cited facts", "What is not in the facts", "Decided by"],
          misses.map((r) => [r.verdict, r.kind, r.questTitle, r.text, facts(r), r.review?.note ?? (r.gemma && "unsupported" in r.gemma ? r.gemma.unsupported.join("; ") : ""), r.decidedBy]),
        )
      : "None.",
    "",
    "## Every sampled line",
    "",
    mdTable(
      ["#", "Verdict", "Decided by", "Gemma", "Kind", "Quest", "Where", "Line", "Cited facts", "Key"],
      rows.map((r, i) => [
        i + 1,
        r.verdict,
        r.decidedBy,
        r.gemma ? ("verdict" in r.gemma ? r.gemma.verdict : `error: ${r.gemma.error}`) : "-",
        r.kind,
        r.questTitle,
        r.where,
        r.text,
        facts(r),
        r.key,
      ]),
    ),
    "",
    "## Method",
    "",
    "- A line passes when every claim it makes about a place, a person, a date or an event is stated by, or follows directly from, its cited facts. Directions, what the player photographed, questions and mood are not counted as claims.",
    "- Gemma (text only) pre-checks each line against its cited facts. Its answer is a pre-check: an agent or owner verdict in the review file replaces it, and \"Decided by\" says whose verdict counts.",
    "- The mystery row is the question and its answer, checked against the facts the mystery cites.",
    "- Small sample: one line moves the rate by several points.",
    "",
  ].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
