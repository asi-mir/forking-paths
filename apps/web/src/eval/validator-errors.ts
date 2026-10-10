import { SAFETY_FIXES } from "@/quest/validate";

/**
 * Groups the validator's error messages (`src/quest/validate.ts`) into kinds, so the validator
 * eval can say which mistakes Gemma's first drafts make most often. Order matters: the first
 * matching kind wins.
 */
const SAFETY = "safety block list (road, private property, people)";

const KINDS: ReadonlyArray<[kind: string, pattern: RegExp]> = [
  ["answer was not JSON / schema", /not a JSON object|^(?:writer output|quest)(?: at [^:]+)?: /],
  ["link to a place left out of the quest", /links to \S+, which is not one of the quest's places/],
  ["place not in the candidate list", /is not one of the candidate places/],
  ["place without facts of its own", /has no fetched fact of its own/],
  ["place beyond 900 m", /m from the quest centre; every place must be within/],
  ["start or answer id wrong", /^(?:startPlaceId|answerPlaceId) .* is not one of|startPlaceId and answerPlaceId are both/],
  ["too many places", /^The quest uses \d+ places/],
  ["clue over 30 words", /clue has \d+ words/],
  ["compass word", /compass word/],
  ["fact ID written in the text", /writes the ID/],
  ["line cites no fact", /cites no fact; cite the IDs/],
  ["unknown fact ID", /which is not one of the facts/],
  ["number not in the cited facts", /says .+, which is (?:not in its cited facts|in none of)/],
  ["reveal cites no fact of its place", /reveal cites no fact of/],
  ["mystery cites no fact of the answer place", /The mystery cites no fact of the answer place/],
  ["hop over 250 m", /m; every hop must be|from the quest centre; it must be within/],
  ["route too long for the minutes", /The longest route/],
  ["fork links or cues", /\bcues?\b|fork/i],
  ["route shape", /^Route |is on no route|stop before the answer|The answer place .* has \d+ link/],
  ["no repair (time limit)", /^No repair:/],
];

/** The kind of one validator error message ("other" when no kind matches). */
export function errorKind(message: string): string {
  // Safety messages end with the rule's fix ("keep the player on the pavement").
  if (SAFETY_FIXES.some((fix) => message.includes(fix))) return SAFETY;
  for (const [kind, pattern] of KINDS) if (pattern.test(message)) return kind;
  return "other";
}

/** The kinds in a list of messages, each once (a draft with five bad links counts once per kind). */
export function errorKinds(messages: readonly string[]): string[] {
  return [...new Set(messages.map(errorKind))];
}
