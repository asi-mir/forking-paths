import { z } from "zod";
import type { PathStep, Quest } from "@/quest/schema";

/**
 * What the two grounding evals check, and how Gemma is asked to pre-check it.
 *
 * - Fact check (page → fact): does the linked page say what the fact says?
 * - Reveal check (fact → narration): does a reveal, link reason, mystery answer, finale or
 *   bridge line say only what its cited facts say?
 *
 * Gemma's answer is a pre-check, not the verdict: the reports keep it apart from the agent's
 * and the owner's checks.
 */

// ---------------------------------------------------------------------------
// Reveal check items

export type LineKind = "reveal" | "link reason" | "mystery" | "finale" | "bridge";

export type CitedItem = {
  /** Stable across runs: the quest, where the line sits, and its text. */
  key: string;
  questId: string;
  questTitle: string;
  kind: LineKind;
  /** "P2", "P1 → P3", "mystery", … */
  where: string;
  text: string;
  facts: Array<{ id: string; text: string }>;
  /** Fact IDs the line cites that the quest does not have (the validator should make this empty). */
  unknownFactIds: string[];
};

/** A short stable hash (FNV-1a), so a review file can refer to an item. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function item(quest: Pick<Quest, "id" | "title" | "facts">, kind: LineKind, where: string, text: string, factIds: readonly string[]): CitedItem {
  const byId = new Map(quest.facts.map((f) => [f.id, f.text]));
  const questId = quest.id ?? "unsaved";
  return {
    key: `${questId}:${where}:${shortHash(text)}`,
    questId,
    questTitle: quest.title,
    kind,
    where,
    text,
    facts: factIds.filter((id) => byId.has(id)).map((id) => ({ id, text: byId.get(id)! })),
    unknownFactIds: factIds.filter((id) => !byId.has(id)),
  };
}

/** Every line of a quest that states facts: reveals, link reasons, the mystery's answer and the finale. */
export function questItems(quest: Pick<Quest, "id" | "title" | "facts" | "places" | "mystery" | "finale">): CitedItem[] {
  const out: CitedItem[] = [];
  for (const p of quest.places) {
    out.push(item(quest, "reveal", p.id, p.reveal.text, p.reveal.factIds));
    for (const l of p.links) out.push(item(quest, "link reason", `${p.id} → ${l.to}`, l.reason, l.factIds));
  }
  out.push(item(quest, "mystery", "mystery", `${quest.mystery.question} — ${quest.mystery.answer}`, quest.mystery.factIds));
  out.push(item(quest, "finale", "finale", quest.finale.text, quest.finale.factIds));
  return out;
}

/** The bridge lines of a run's walked path that cite facts (said on the way to the next stop). */
export function bridgeItems(quest: Pick<Quest, "id" | "title" | "facts">, path: readonly PathStep[]): CitedItem[] {
  return path
    .filter((s) => s.bridge && s.bridgeFactIds?.length)
    .map((s) => item(quest, "bridge", `${s.placeId} → ${s.to ?? "?"}`, s.bridge!, s.bridgeFactIds!));
}

/** Items with the same quest, place and text counted once (runs repeat the same bridge). */
export function uniqueItems(items: readonly CitedItem[]): CitedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}

// ---------------------------------------------------------------------------
// Gemma pre-checks

export const RevealCheckSchema = z.object({
  verdict: z.enum(["supported", "partly", "unsupported"]),
  /** Claims in the line that the cited facts do not state (empty when supported). */
  unsupported: z.array(z.string()),
});
export type RevealCheck = z.infer<typeof RevealCheckSchema>;

export function revealCheckPrompt(i: Pick<CitedItem, "kind" | "text" | "facts">): string {
  return [
    "You check a narrator's line in a walking game against the facts it cites.",
    "A line passes only if every claim about a place, a person, a date or an event in it is stated by, or follows directly from, the cited facts.",
    "Do not count as claims: directions (\"head downhill toward the water\"), what the player just photographed (\"the plaque you photographed\"), questions, or mood (\"a story waits\").",
    "",
    `Line (${i.kind}): "${i.text}"`,
    "",
    "Cited facts:",
    ...i.facts.map((f) => `- ${f.id}: ${f.text}`),
    "",
    'Answer with one JSON object: {"verdict": "supported" | "partly" | "unsupported", "unsupported": [the claims the facts do not state, in a few words each]}.',
    '"partly": the main claim is supported but a detail is added or changed. "unsupported": the main claim is not in the facts.',
  ].join("\n");
}

export const FactCheckSchema = z.object({
  verdict: z.enum(["holds", "partly", "not-found"]),
  note: z.string(),
});
export type FactCheck = z.infer<typeof FactCheckSchema>;

export function factCheckPrompt(fact: string, passage: string): string {
  return [
    "You check one fact against the text of the web page it links to.",
    "",
    `Fact: "${fact}"`,
    "",
    "Best-matching passage from the page:",
    `"""${passage}"""`,
    "",
    'Answer with one JSON object: {"verdict": "holds" | "partly" | "not-found", "note": "one short sentence"}.',
    '"holds": the passage states the fact (wording may differ). "partly": it states part of it, or a detail differs (a date, a name). "not-found": the passage does not state it.',
  ].join("\n");
}
