/**
 * Draft the desk demo's quest text with Gemma, from the fetched facts and the chosen route in
 * `src/quest/__fixtures__/karakoy.json`. The draft goes through `validateQuest`; when it fails,
 * Gemma gets the error list for one repair. Nothing is written into the fixture: the draft is
 * saved to `--out` for a person to check, edit (listing each edit in `editedByHand`) and copy in.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/draft-demo-quest.ts --out <file.json> [--fixture <file.json>]
 *
 * Uses the writer role from env (Google AI Studio when GOOGLE_GENERATIVE_AI_API_KEY is set,
 * otherwise Ollama). No voice, no network other than the model call.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateJson, type ModelCallMeta } from "../src/lib/json";
import { modelLabel, resolveModelConfig } from "../src/lib/model";
import { CUES, type Candidate, type Fact, WriterOutputSchema, type WriterOutput } from "../src/quest/schema";
import { LIMITS, validateQuest, type ValidateOptions } from "../src/quest/validate";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

type RoutePlan = {
  startPlaceId: string;
  answerPlaceId: string;
  fork: { from: string; to: string; cue: string }[];
  beforeAnswer: string[];
};
type Fixture = {
  facts: Fact[];
  candidates: Candidate[];
  opts: ValidateOptions;
  route: RoutePlan;
  walkingNotes?: Record<string, string>;
};

const fixturePath = resolve(option("fixture") ?? "src/quest/__fixtures__/karakoy.json");
const outPath = option("out");
if (!outPath) {
  console.error("usage: pnpm exec tsx scripts/draft-demo-quest.ts --out <file.json> [--fixture <file.json>]");
  process.exit(2);
}
const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const INSTRUCTIONS = `You write a short walking mystery for a phone game. A narrator speaks every line aloud.
The player hears a clue, locks the phone, walks, and at each place photographs one detail.
At the first place (a fork) the detail they photograph picks the next place.
Every route ends at the same answer place, where the mystery is solved.

Hard rules:
- State only facts from the list you are given. Every reveal, link reason, the mystery and the finale cite the IDs of the facts they state in factIds.
- Say only what the cited facts say. Keep their hedges ("is thought to", "says", "circa"): a legend stays a legend. Never claim that an inscription or a detail says something unless a fact says so.
- Never write an ID (F3, P2) inside a spoken line.
- A number or year may appear in a line only if it is in that line's cited facts. Clue, look and hint lines cite nothing: leave numbers out of them.
- Clues: at most ${LIMITS.maxClueWords} words, lead to something you can see, use landmarks ("downhill toward the water", "past the tower"), never compass words (north, south, east, west).
- Safety: never send the player across or onto a road or tram line, into a building, courtyard or private property, and never ask them to photograph people.
- The look line at the fork hints at the two details without saying which is right, e.g. "Two things here keep a story: one you can read, one that flows. Photograph the one you trust."
- Plain, warm English. Short sentences that sound good spoken. No markdown.`;

function prompt(): string {
  const byPlace = new Map<string, Fact[]>();
  for (const f of fx.facts) {
    if (!f.placeId) continue;
    byPlace.set(f.placeId, [...(byPlace.get(f.placeId) ?? []), f]);
  }
  const places = fx.candidates
    .map((c) => {
      const facts = (byPlace.get(c.id) ?? []).map((f) => `    ${f.id}: ${f.text}`).join("\n");
      const notes = fx.walkingNotes?.[c.id] ? `\n  Walking notes (for clues and hints only, not facts): ${fx.walkingNotes[c.id]}` : "";
      return `- ${c.id} ${c.name}${notes}\n  Facts:\n${facts}`;
    })
    .join("\n");
  const r = fx.route;
  const forkLines = r.fork.map((l) => `  ${l.from} -> ${l.to}, cue "${l.cue}"`).join("\n");
  return `Places and facts:
${places}

The route is fixed (3 stops):
- Start: ${r.startPlaceId}, a fork with two links:
${forkLines}
- ${r.beforeAnswer.join(" and ")} each have exactly one link, to the answer ${r.answerPlaceId}, with no cue.
- The answer place ${r.answerPlaceId} has no links.
Cue list: ${CUES.join(", ")}.

Write:
- title: a short quest title.
- mystery: a question whose answer is a real fact of the answer place ${r.answerPlaceId}, intriguing enough to walk for and answerable when the player stands there. question, answer, factIds (at least one fact of ${r.answerPlaceId}).
- briefing: 2-3 spoken sentences that set up the mystery and send the player to the start (${r.startPlaceId}) by a landmark. No facts that need a citation, no numbers.
- places: one entry per place (${fx.candidates.map((c) => c.id).join(", ")}), each with clue (how to find it), look (said at the place), hint (said when the player is too far away), reveal (text + factIds, at least one fact of that place), links (to, cue at the fork only, reason, factIds). A link reason is said on the way: it ties the detail just photographed to the next place and gives a landmark direction.
- startPlaceId, answerPlaceId.
- finale: solves the mystery with cited facts; it must be true whichever route the player took.

Answer with one JSON object only.`;
}

async function main() {
  const config = resolveModelConfig("writer");
  if (config.provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
    console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
    return;
  }
  if (config.provider === "ollama") {
    const up = await fetch(`${config.baseURL}/models`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) {
      console.log(`skipped: the writer runs on Ollama, which is not reachable at ${config.baseURL}`);
      return;
    }
  }
  console.log(`writer: ${modelLabel(config)} (thinking ${config.thinking})`);
  const basePrompt = prompt();
  const metas: ModelCallMeta[] = [];

  const first = await generateJson("writer", WriterOutputSchema, basePrompt, undefined, {
    instructions: INSTRUCTIONS,
    maxOutputTokens: 16_000,
  });
  metas.push(first.meta);
  const firstCheck = validateQuest(first.data, fx.facts, fx.candidates, fx.opts);
  const firstErrors = firstCheck.ok ? [] : firstCheck.errors;
  console.log(`first draft: ${firstCheck.ok ? "passed" : `${firstErrors.length} error(s)`}`);
  for (const e of firstErrors) console.log(`  - ${e}`);

  let repairedDraft: WriterOutput | undefined;
  let repairErrors: string[] = [];
  if (!firstCheck.ok) {
    const repairPrompt = `${basePrompt}

Your previous answer:
${JSON.stringify(first.data)}

The validator rejected it:
${firstErrors.map((e) => `- ${e}`).join("\n")}

Fix every error and answer with the whole corrected JSON object.`;
    const second = await generateJson("writer", WriterOutputSchema, repairPrompt, undefined, {
      instructions: INSTRUCTIONS,
      maxOutputTokens: 16_000,
    });
    metas.push(second.meta);
    repairedDraft = second.data;
    const check = validateQuest(second.data, fx.facts, fx.candidates, { ...fx.opts, firstTryErrors: firstErrors });
    repairErrors = check.ok ? [] : check.errors;
    console.log(`repaired draft: ${check.ok ? "passed" : `${repairErrors.length} error(s)`}`);
    for (const e of repairErrors) console.log(`  - ${e}`);
  }

  writeFileSync(
    outPath!,
    JSON.stringify(
      {
        model: modelLabel(config),
        thinking: config.thinking,
        createdAt: new Date().toISOString(),
        firstDraft: first.data,
        firstErrors,
        repairedDraft: repairedDraft ?? null,
        repairErrors,
        calls: metas,
      },
      null,
      2,
    ),
  );
  for (const m of metas) {
    console.log(`call: ${m.latencyMs} ms, ${m.inputTokens} in / ${m.outputTokens} out (${m.reasoningTokens} thinking), requests ${m.requests}`);
  }
  console.log(`saved ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
