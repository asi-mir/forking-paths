import karakoyJson from "./__fixtures__/karakoy.json";
import { CandidateSchema, FactSchema, type Candidate, type Fact, type Quest } from "./schema";
import { validateQuest, type ValidateOptions } from "./validate";

/**
 * The desk demo's quest: four real places below Galata Tower in Karaköy, Istanbul.
 * Gemma drafted the text from facts fetched from Wikipedia. Each fact was checked against
 * the page it links to, and every hand edit to Gemma's draft is listed in `editedByHand`.
 */
export const DEMO_QUEST_ID = "demo-karakoy";

/** The research data and writer output the demo quest is built from. */
export type DemoSource = {
  questId: string;
  facts: Fact[];
  candidates: Candidate[];
  opts: ValidateOptions;
  // The writer's JSON (validated by validateQuest, so loosely typed here).
  writer: unknown;
  editedByHand: string[];
  model: { provider: string; writer: string };
};

/** A fresh copy of the demo quest's source data. */
export function demoSource(): DemoSource {
  const copy = structuredClone(karakoyJson);
  return {
    questId: copy.questId,
    facts: FactSchema.array().parse(copy.facts),
    candidates: CandidateSchema.array().parse(copy.candidates),
    opts: copy.opts as ValidateOptions,
    writer: copy.writer,
    editedByHand: copy.editedByHand,
    model: copy.model,
  };
}

/**
 * The demo quest, run through the validator like any generated quest. Throws when the
 * fixture no longer passes (a unit test guards this).
 */
export function demoQuest(): Quest {
  const src = demoSource();
  const result = validateQuest(src.writer, src.facts, src.candidates, src.opts);
  if (!result.ok) {
    throw new Error(`The demo quest fails the validator:\n${result.errors.join("\n")}`);
  }
  return {
    ...result.quest,
    id: src.questId,
    demo: true,
    editedByHand: src.editedByHand,
    model: src.model,
  };
}
