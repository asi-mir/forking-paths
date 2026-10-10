import { Agent } from "@mastra/core/agent";
import type { LanguageModelUsage } from "ai";
import { extractJson } from "@/lib/json";
import { distanceM, type LatLng } from "@/lib/geo";
import { getModel, modelFromConfig, providerOptionsFor, resolveModelConfig, type ModelConfig } from "@/lib/model";
import { mastraTracing } from "@/lib/trace";
import { narratorStyle } from "./narrator-style";
import karakoy from "@/quest/__fixtures__/karakoy.json";
import { describeOption, maxRouteM, type RouteOption } from "@/quest/plan";
import { CUES, type Candidate, type Fact, type Lang, WriterOutputSchema } from "@/quest/schema";
import { compassWords, LIMITS, SAFETY_FIXES, stopsForMinutes } from "@/quest/validate";

/**
 * The quest writer: one Gemma call (thinking on) that turns fetched facts and code-checked
 * route options into a mystery, clues, look lines, reveals, fork links and a finale, as JSON
 * that cites fact IDs. No tools: research runs in code before this call.
 */

/** Who speaks every line, and how: the narrator's style guide (`narrator-style.md`). */
const NARRATOR = `The narrator's style guide (follow it for every line):\n${narratorStyle()}`;

export const WRITER_INSTRUCTIONS = `You write a short walking mystery for a phone game. A narrator speaks every line aloud.
The player hears a clue, locks the phone, walks, and at each place photographs one detail.
At a fork, the detail they photograph picks the next place. Every route ends at the same answer place, where the mystery is solved.
${NARRATOR}

Hard rules:
- State only facts from the list you are given. Every reveal, link reason, the mystery and the finale cite the IDs of the facts they state in factIds.
- Say only what the cited facts say. Keep their hedges ("is thought to", "says", "circa"): a legend stays a legend. Never claim that an inscription or a detail says something unless a fact says so.
- Never write an ID (F3, P2) inside a spoken line.
- A number or year may appear in a line only if it is in that line's cited facts. Clue, look and hint lines cite nothing: leave numbers out of them. Leave numbers out of the briefing.
- Clues: at most ${LIMITS.maxClueWords} words; lead to something you can see at the place; use landmarks ("downhill toward the water", "past the tower"); never compass words (north, south, east, west), not even in "the northwest corner": say "the corner by the gallery".
- Safety: never send the player across or onto a road or tram line, into a building, courtyard or private property, and never ask them to photograph people. The player stays outside, on the pavement. No line says "across the street", "the other side of the street" or "diagonally": lead along the pavement to a landmark instead.
- Plain, warm English. Short sentences that sound good spoken. No markdown.`;

/** The writer agent, registered on the Mastra instance (Studio shows it). Its model comes from env at call time. */
export const writerAgent = new Agent({
  id: "writer",
  name: "Quest writer",
  description: "Writes a walking mystery from fetched facts, as JSON that cites fact IDs.",
  instructions: WRITER_INSTRUCTIONS,
  model: () => getModel("writer"),
});

// ---------------------------------------------------------------------------
// The prompt

export type WriterCandidate = Candidate & { types?: string[]; description?: string };

export type WriterPromptInput = {
  center: LatLng;
  minutes: number;
  lang: Lang;
  candidates: WriterCandidate[];
  facts: Fact[];
  options: RouteOption[];
};

/**
 * The Karaköy desk demo quest (hand-checked), trimmed to keep tokens low: the fork, one
 * middle stop and the answer (the other middle stop has the same shape).
 */
function example(): string {
  const w = karakoy.writer;
  const keep = new Set([w.startPlaceId, w.answerPlaceId, w.places[0].links[0].to]);
  return JSON.stringify({ ...w, places: w.places.filter((p) => keep.has(p.id)) });
}

function placeBlock(c: WriterCandidate, input: WriterPromptInput, facts: Fact[]): string {
  const kind = [...(c.types ?? []).slice(0, 2), c.description].filter(Boolean).join("; ");
  const fromCentre = Math.round(distanceM(input.center, c.location));
  const near = input.candidates
    .filter((o) => o.id !== c.id)
    .map((o) => ({ id: o.id, m: Math.round(distanceM(c.location, o.location)) }))
    .filter((o) => o.m <= LIMITS.maxHopM)
    .map((o) => `${o.id} ${o.m} m`)
    .join(", ");
  const lines = facts.map((f) => `    ${f.id}: ${f.text}`).join("\n");
  // Gemma copies "the northwest corner" from a fact into its clues; say which words to leave there.
  const compass = [...new Set(facts.flatMap((f) => compassWords(f.text, [c.name]).map((w) => w.toLowerCase())))];
  const note = compass.length
    ? `\n  These facts use the compass word${compass.length > 1 ? "s" : ""} ${compass.map((w) => `"${w}"`).join(", ")}: cite them, but in clues, hints and link reasons name a landmark instead.`
    : "";
  return `- ${c.id} ${c.name}${kind ? ` (${kind})` : ""}. ${fromCentre} m from the start point.${near ? ` Within ${LIMITS.maxHopM} m: ${near}.` : ""}\n  Facts:\n${lines}${note}`;
}

/** The user prompt for one quest. */
export function writerPrompt(input: WriterPromptInput): string {
  const n = stopsForMinutes(input.minutes);
  const byPlace = new Map<string, Fact[]>();
  const area: Fact[] = [];
  for (const f of input.facts) {
    if (!f.placeId) area.push(f);
    else byPlace.set(f.placeId, [...(byPlace.get(f.placeId) ?? []), f]);
  }
  const used = new Set(input.options.flatMap((o) => o.places));
  const places = input.candidates
    .filter((c) => used.has(c.id))
    .map((c) => placeBlock(c, input, byPlace.get(c.id) ?? []))
    .join("\n");
  const areaBlock = area.length
    ? `\nFacts about the area (no place of their own; the mystery and the finale may cite them as well as, never instead of, a fact of the answer place):\n${area.map((f) => `    ${f.id}: ${f.text}`).join("\n")}\n`
    : "";
  // The mystery's answer must be a fact of the answer place: name those facts on the option's answer line.
  const withAnswerFacts = (o: RouteOption, i: number) => {
    const ids = (byPlace.get(o.answer) ?? []).map((f) => f.id).join(", ");
    return describeOption(o, i).replace(
      `${o.answer}: the answer place, no links`,
      `${o.answer}: the answer place, no links; the mystery cites one of its facts (${ids})`,
    );
  };

  const shape =
    n === 3
      ? `The walk is ${input.minutes} minutes: 3 stops, one fork.
- Start: a fork with exactly 2 links (each with a different cue) to the two middle places.
- Each middle place has exactly 1 link, to the answer place, with no cue (cue null).
- The answer place has no links. Every route: start → a middle place → answer.`
      : `The walk is ${input.minutes} minutes: 4 stops, two forks.
- Start: a fork with exactly 2 links (different cues) to the two places of the first fork.
- Each of those is itself a fork with exactly 2 links (different cues) to the same two places of the second fork.
- Each place of the second fork has exactly 1 link, to the answer place, with no cue (cue null).
- The answer place has no links. Every route: start → fork → one-link place → answer.`;

  const lang =
    input.lang === "tr"
      ? "Write every spoken line (title, mystery, briefing, clue, look, hint, reveal, reason, finale) in Turkish. Keep JSON keys, IDs and cues in English."
      : "Write every spoken line in English.";

  return `Places near the player, with the facts fetched for them:
${places}
${areaBlock}
${shape}
The longest route must stay under ${Math.round(maxRouteM(input.minutes, n))} m. Code has measured the distances; these route options already fit (every hop at most ${LIMITS.maxHopM} m):
${input.options.map(withAnswerFacts).join("\n")}
Pick the option that makes the best mystery. The start never links straight to the answer place: every route passes ${n === 3 ? "one middle place" : "two places"} on the way. Your "places" array must have exactly one entry for each place of that option (${n === 3 ? 4 : 6} entries), with exactly the links the option lists, and no other places.

Cue list (each fork link has one; it names the kind of detail the player photographs): ${CUES.join(", ")}.
A cue must be something the player can see at the fork place itself (writing, water, a carving...). The link's reason ties that kind of detail to the next place through a cited fact of the next place (writing → a place whose fact is about writing or a name; water → another fountain). Never say what the photographed detail says or shows unless a fact says so.

Write:
- title: a short quest title.
- mystery: a question whose answer is a real fact of the answer place, intriguing enough to walk for and answerable when the player stands there. question, answer, factIds (at least one fact of the answer place; a fact of another place or of the area alone is rejected).
- briefing: 2-3 spoken sentences that set up the mystery and send the player to the start by a landmark. No numbers.
- places: one entry per place of the option, each with:
  clue (how to find it from the previous stop: something visible, landmark directions),
  look (said at the place; at a fork it hints at the details behind its links without saying which is right, e.g. "Two things here keep a story: one you can read, one that flows. Photograph the one you trust."),
  hint (said when the player is still too far away: one more visible landmark on the way, not only the place's name; "Look for the X" is not a hint),
  reveal (text + factIds, at least one fact of that place),
  links (to, cue at forks only, reason, factIds). A link reason is said on the way: it ties the detail just photographed to the next place with a cited fact and gives a landmark direction. The one link before the answer ties that stop's evidence to the answer. Say only what the cited facts say about the next place: never invent a tie between two places ("mirrors", "is named after", "echoes") that no fact states.
- startPlaceId, answerPlaceId.
- finale: solves the mystery with cited facts; it must be true whichever route the player took. Do not only repeat the mystery's answer: when the answer place has more than one fact, add a second one (cited) that the player can see or picture there.
${lang}
If a rule needs a fix, the fixes are: ${SAFETY_FIXES.join("; ")}.

Example of the shape and tone (a finished quest from another neighbourhood, trimmed: one of its two middle stops is left out; its IDs refer to its own facts, not yours; do not reuse its places or wording):
${example()}

Answer with one JSON object only.`;
}

/** The repair prompt: the first prompt, the rejected draft and the validator's errors. */
export function repairPrompt(basePrompt: string, draft: unknown, errors: string[]): string {
  return `${basePrompt}

Your previous answer:
${JSON.stringify(draft)}

The validator rejected it:
${errors.map((e) => `- ${e}`).join("\n")}

Fix every error and answer with the whole corrected JSON object.`;
}

// ---------------------------------------------------------------------------
// The call

export type WriterCall = {
  /** The parsed JSON (unchecked: the validator checks it), or null when no JSON came back. */
  draft: unknown;
  provider: string;
  model: string;
  thinking: ModelConfig["thinking"];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type WriteOptions = {
  agent?: Agent;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A cap on this call's timeout: the time left of the quest's deadline. */
  maxMs?: number;
  /** Tags for the trace (quest centre is never sent). */
  tags?: { questId?: string };
};

/**
 * A quest is ~1,100 output tokens: on the AI Studio free tier the 31B took 52–68 s per call, and
 * a repair call (longer prompt) timed out at 90 s. So the writer waits up to 150 s on Google;
 * Ollama keeps its role timeout (300 s).
 */
export const WRITER_GOOGLE_TIMEOUT_MS = 150_000;

export function writerTimeoutMs(config: ModelConfig): number {
  return config.provider === "google" ? Math.max(config.timeoutMs, WRITER_GOOGLE_TIMEOUT_MS) : config.timeoutMs;
}

/**
 * One writer call through the Mastra agent: structured output with the writer schema, thinking
 * from env (high by default), the per-attempt timeout of the writer role, retries on HTTP 429/5xx.
 * Returns whatever JSON came back; the validator decides whether it is a quest.
 */
export async function writeDraft(prompt: string, opts: WriteOptions = {}): Promise<WriterCall> {
  const env = opts.env ?? process.env;
  const config = resolveModelConfig("writer", env);
  // An explicit env (scripts, evals) gets its own agent, so its provider and model are used.
  const agent = opts.agent ?? (opts.env ? writerAgentFor(env) : writerAgent);
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? writerTimeoutMs(config), opts.maxMs ?? Number.POSITIVE_INFINITY));
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const started = Date.now();

  const result = await agent.generate(prompt, {
    structuredOutput: { schema: WriterOutputSchema, errorStrategy: "warn" },
    providerOptions: providerOptionsFor(config),
    modelSettings: { maxOutputTokens: 16_000, maxRetries: 2 },
    abortSignal: signal,
    tracingOptions: mastraTracing({ role: "writer", provider: config.provider, model: config.modelId, ...opts.tags }),
  });
  const error = (result as { error?: unknown }).error;
  if (error) throw error instanceof Error ? error : new Error(String(error));
  // An aborted call can come back as an empty result instead of an error.
  if (signal.aborted) {
    throw new Error(opts.signal?.aborted ? "the writer call was cancelled" : `the writer call timed out after ${timeoutMs} ms`);
  }

  let draft: unknown = result.object ?? null;
  if (draft === null && result.text?.trim()) {
    try {
      draft = extractJson(result.text);
    } catch {
      draft = null;
    }
  }
  const usage = (result.totalUsage ?? result.usage) as LanguageModelUsage | undefined;
  return {
    draft,
    provider: config.provider,
    model: config.modelId,
    thinking: config.thinking,
    latencyMs: Date.now() - started,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

/** A writer agent on an explicit env (scripts that switch provider without touching process.env). */
export function writerAgentFor(env: Record<string, string | undefined>): Agent {
  const config = resolveModelConfig("writer", env);
  return new Agent({
    id: "writer",
    name: "Quest writer",
    instructions: WRITER_INSTRUCTIONS,
    model: modelFromConfig(config, env),
  });
}
