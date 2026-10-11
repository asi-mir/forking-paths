/**
 * How the narrator's clips and the sounds are played together. Client-safe (no Node imports):
 * the play screen uses it to decide what plays under which line.
 *
 * Safety: nothing plays while the player walks, so they hear the street. The ambience plays
 * only under the briefing and the clues (the player is standing still, listening); a stinger
 * plays on a photo result.
 */

/** A quest line's key in `voiceQuest`'s clips: `briefing`, `finale` or `<placeId>.<part>`. */
export type QuestLinePart = "clue" | "look" | "hint" | "reveal";
export type QuestLineKey = "briefing" | "finale" | `${string}.${QuestLinePart}`;
export type LineKind = "briefing" | "finale" | QuestLinePart | "bridge";

/** The ambience under the voice: quiet enough that every word stays clear. */
export const AMBIENCE_GAIN = 0.25;
/** Fade the ambience in before the voice starts and out after it ends. */
export const AMBIENCE_FADE_MS = 800;
/** A stinger plays at full level, then the next line starts after this pause. */
export const STINGER_GAP_MS = 400;

export function lineKind(key: QuestLineKey | "bridge"): LineKind {
  if (key === "briefing" || key === "finale" || key === "bridge") return key;
  const part = key.slice(key.lastIndexOf(".") + 1);
  if (part === "clue" || part === "look" || part === "hint" || part === "reveal") return part;
  throw new Error(`not a quest line key: ${key}`);
}

/** True when the ambience plays under this line: the briefing and the clues only. */
export function ambienceUnder(kind: LineKind): boolean {
  return kind === "briefing" || kind === "clue";
}

/** The stinger for a photo result: "found" when the stop passed, "notHere" when it did not. */
export function stingerFor(result: { passed: boolean }): "found" | "notHere" {
  return result.passed ? "found" : "notHere";
}
