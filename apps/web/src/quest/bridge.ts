import { z } from "zod";
import type { CitedFact, CitedSpokenLine } from "./api";
import { placeById } from "./routes";
import { usableObserved, type Fact, type Link, type Place, type Quest } from "./schema";
import { compassWords, idsIn, numbersIn, safetyIssues } from "./validate";

/**
 * The bridge line: what the narrator says as the player leaves a place. It names the detail the
 * reader saw and says why it leads on, citing the chosen link's facts. Gemma writes it at play
 * time, so it is checked like a reveal: known fact IDs (of this link), no numbers that are not in
 * the cited facts, no compass words, no unsafe directions. A line that fails, or a call that
 * fails or times out, falls back to the link's stored reason (already checked by the validator),
 * opened by a short sentence that names the detail, so the fallback still names what was seen.
 */

export const BRIDGE_MAX_WORDS = 45;
export const BRIDGE_MAX_SENTENCES = 2;

/** What the narrator returns. Plain strings: the checks below give better errors than a schema. */
export const BridgeAnswerSchema = z.object({
  text: z.string(),
  factIds: z.array(z.string()),
});
export type BridgeAnswer = z.infer<typeof BridgeAnswerSchema>;

export type Bridge = {
  text: string;
  factIds: string[];
  /** `narrator`: Gemma's line passed the checks. `reason`: the link's stored reason. */
  source: "narrator" | "reason";
  /** Why the narrator's line was not used (empty when it was, or when no call was made). */
  rejected: string[];
};

export type BridgeContext = {
  quest: Pick<Quest, "places" | "facts" | "lang">;
  place: Place; // the place the player is leaving
  link: Link; // the link taken
  observed: string | null; // the detail the reader saw
};

/**
 * The opening of a fallback bridge: "You photographed the gilded inscription." Built from the
 * reader's `observed` line in code, so it states no fact. Words with digits are dropped (a number
 * read off the photo is not a fetched fact). Null when there is nothing safe to name: no usable
 * detail, a Turkish quest (the reader writes English), or a detail that would use a compass word,
 * break a safety rule or name the next place.
 */
export function detailOpening(ctx: BridgeContext): string | null {
  const observed = usableObserved(ctx.observed);
  if (!observed || ctx.quest.lang !== "en") return null;
  const kept = observed
    .replace(/[.!?…]+$/, "")
    .split(/\s+/)
    .filter((w) => !/\d/.test(w));
  while (kept.length && TRAILING.has(kept[kept.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ""))) kept.pop();
  const detail = kept.join(" ").replace(/[\s,;:–-]+$/, "").trim();
  if (!detail || stems(detail).size === 0) return null;
  if (compassWords(detail, ctx.quest.places.map((p) => p.name)).length || safetyIssues(detail).length) return null;
  const next = placeById(ctx.quest, ctx.link.to);
  if (next && detail.toLowerCase().includes(next.name.toLowerCase())) return null;
  const article = /^(a|an|the|this|that|these|those|some|its|their)\b/i.test(detail) ? "" : "the ";
  return `You photographed ${article}${detail.charAt(0).toLowerCase()}${detail.slice(1)}.`;
}

/** Words a cut-down detail must not end on ("a plaque dated" → "a plaque"). */
const TRAILING = new Set(
  "a an and the of with on in at to from by for dated reading saying marked showing numbered year date number".split(" "),
);

/**
 * The fallback: the link's stored reason, with the link's facts. Given the context, it opens
 * with the detail the reader saw (see `detailOpening`).
 */
export function reasonBridge(link: Link, rejected: string[] = [], ctx?: BridgeContext): Bridge {
  const opening = ctx ? detailOpening(ctx) : null;
  const text = opening ? `${opening} ${link.reason}` : link.reason;
  return { text, factIds: [...link.factIds], source: "reason", rejected };
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Sentences, counted by their end marks (a line without one counts as one sentence). */
export function sentenceCount(text: string): number {
  const ends = text.trim().match(/[.!?…]+(?=\s|$)/g)?.length ?? 0;
  return Math.max(1, ends + (/[.!?…]["'”’)]*\s*$/.test(text.trim()) ? 0 : 1));
}

/**
 * Problems with a narrator bridge line (empty = usable). Checked like a reveal: it cites only
 * facts of the chosen link, states only numbers from those facts, uses no compass words, sends
 * no one onto a road, keeps fact IDs out of the text and keeps the next place's name hidden.
 */
export function bridgeIssues(answer: BridgeAnswer, ctx: BridgeContext): string[] {
  const issues: string[] = [];
  const text = answer.text.trim();
  if (!text) return ["the line is empty"];

  const n = words(text);
  if (n > BRIDGE_MAX_WORDS) issues.push(`the line has ${n} words; keep it to ${BRIDGE_MAX_WORDS} or fewer`);
  const s = sentenceCount(text);
  if (s > BRIDGE_MAX_SENTENCES) issues.push(`the line has ${s} sentences; use one or two`);

  const factById = new Map(ctx.quest.facts.map((f) => [f.id, f]));
  const cited = [...new Set(answer.factIds)];
  if (cited.length === 0) issues.push("the line cites no fact");
  for (const id of cited) {
    if (!factById.has(id)) issues.push(`the line cites ${id}, which is not one of the facts`);
    else if (!ctx.link.factIds.includes(id)) issues.push(`the line cites ${id}, which is not a fact of this link`);
  }

  // Numbers must be in the cited facts (or in the current place's name). A number the reader
  // read off the photo does not count: it is not a fetched fact.
  const allowed = new Set([
    ...cited.flatMap((id) => numbersIn(factById.get(id)?.text ?? "")),
    ...numbersIn(ctx.place.name),
  ]);
  for (const num of numbersIn(text.replace(/\b[FP]\d+\b/g, ""))) {
    if (!allowed.has(num)) issues.push(`the line says ${num}, which is not in its cited facts`);
  }

  const names = ctx.quest.places.map((p) => p.name);
  const compass = compassWords(text, names);
  if (compass.length) issues.push(`the line uses the compass word "${compass[0]}"`);
  for (const issue of safetyIssues(text)) issues.push(`the line ${issue}`);
  const ids = idsIn(text);
  if (ids.length) issues.push(`the line writes the ID ${ids[0]} in its text`);

  const observed = usableObserved(ctx.observed);
  if (observed && ctx.quest.lang === "en" && !namesDetail(text, observed)) {
    issues.push(`the line does not name the detail the player photographed ("${ctx.observed}")`);
  }

  const next = placeById(ctx.quest, ctx.link.to);
  if (next && !ctx.link.reason.toLowerCase().includes(next.name.toLowerCase())) {
    if (text.toLowerCase().includes(next.name.toLowerCase())) {
      issues.push(`the line names the next place (${next.name}); keep it hidden until the reveal`);
    }
  }
  return [...new Set(issues)];
}

const STOP_WORDS = new Set(
  [
    "a an and the of with on in at to from by for its it this that these those there here some one two near next under over above below into onto",
    // Generic words most details and most lines share: they do not name a specific detail.
    "small large big old tall long wide little ancient ornate decorative decorated carved stone stones wall walls metal wooden building detail details part side front piece close",
  ]
    .join(" ")
    .split(" "),
);

/** The content words of a line, as 5-letter stems ("inscription" and "inscriptions" match). */
function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

/**
 * True when the line names the detail: it shares at least one content word with the reader's
 * `observed` line ("the gilded inscription" for "carved marble panel with a gilded inscription").
 * An observed line with no content word of four letters or more is not checked.
 */
export function namesDetail(text: string, observed: string): boolean {
  const wanted = stems(observed);
  if (wanted.size === 0) return true;
  const said = stems(text);
  return [...wanted].some((w) => said.has(w));
}

/** Use the narrator's line when it passes the checks; otherwise the link's reason. */
export function acceptBridge(answer: BridgeAnswer | null, ctx: BridgeContext, failure?: string): Bridge {
  if (!answer) return reasonBridge(ctx.link, failure ? [failure] : [], ctx);
  const issues = bridgeIssues(answer, ctx);
  if (issues.length) return reasonBridge(ctx.link, issues, ctx);
  return { text: answer.text.trim(), factIds: [...new Set(answer.factIds)], source: "narrator", rejected: [] };
}

const LANGUAGE = { en: "English", tr: "Turkish" } as const;

/**
 * The narrator's prompt. Everything is in one user message: for Gemma, `@ai-sdk/google` folds
 * the system prompt into the first user message anyway.
 */
export function bridgePrompt(ctx: BridgeContext): string {
  const factById = new Map(ctx.quest.facts.map((f) => [f.id, f]));
  const facts = ctx.link.factIds
    .map((id) => factById.get(id))
    .filter((f): f is Fact => Boolean(f))
    .map((f) => `- ${f.id}: ${f.text}`)
    .join("\n");
  return [
    "You are the narrator of a walking mystery game. The player is leaving a place and walking to the next stop.",
    `Write the line you say now, in ${LANGUAGE[ctx.quest.lang]}.`,
    "",
    `The place they are leaving: ${ctx.place.name}.`,
    `The detail they photographed here: ${ctx.observed}`,
    `Why that detail leads to the next stop: ${ctx.link.reason}`,
    "Facts you may use (the only facts you may state):",
    facts,
    "",
    "Rules:",
    "- One or two short sentences, at most 40 words.",
    "- Start from the detail they photographed, then say why it leads on, using only the facts above.",
    "- Keep the way-finding words from the reason (a landmark such as \"toward the water\"). Never use compass words (north, south, east, west).",
    "- Do not name the next place. Never mention people around the player.",
    "- No numbers or dates unless they are in the facts above. Never write a fact ID in the line.",
    "",
    'Answer with JSON only: {"text": "<the line>", "factIds": ["<IDs of the facts the line uses>"]}',
  ].join("\n");
}

/** Facts by ID, as the player sees them (with source and link). Unknown IDs are skipped. */
export function citedFacts(quest: Pick<Quest, "facts">, factIds: readonly string[]): CitedFact[] {
  const byId = new Map(quest.facts.map((f) => [f.id, f]));
  return factIds
    .map((id) => byId.get(id))
    .filter((f): f is Fact => Boolean(f))
    .map((f) => ({ id: f.id, text: f.text, source: f.source, sourceTitle: f.sourceTitle, query: f.query, url: f.sourceUrl }));
}

/** The bridge as a cited spoken line for the play API (clipId is added by the voice step). */
export function bridgeLine(quest: Pick<Quest, "facts">, bridge: Bridge): CitedSpokenLine {
  return { line: { text: bridge.text }, facts: citedFacts(quest, bridge.factIds) };
}
