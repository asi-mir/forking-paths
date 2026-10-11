import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The narrator's character and line rules (`narrator-style.md`, next to this file), for the
 * writer and bridge-line prompts. Server only (it reads the file once).
 */

/** The ElevenLabs Voice Design prompt. Keep it in step with "Voice description" in the .md. */
export const NARRATOR_VOICE_DESCRIPTION =
  "An old Istanbul ferry captain turned city archivist. A man in his late sixties with a warm, low, " +
  "slightly raspy voice. He speaks slowly and kindly, with small pauses, like someone sharing a " +
  "secret over tea. Gentle Turkish accent in English. Calm, never theatrical.";

export const NARRATOR_VOICE_NAME = "Forking Paths narrator";

/** The audio tags the style guide allows (ElevenLabs v4 reads them; the screen strips them). */
export const NARRATOR_TAGS = ["whispers", "curious", "sighs", "excited"] as const;

/**
 * Three lines for hearing the voice once (`scripts/voice-sample.ts`): a plain briefing, a fork's
 * look line (`[curious]`) and a whispered finale (`[whispers]`), as the style guide uses them.
 */
export const SAMPLE_LINES = [
  "Welcome aboard, first mate. This street keeps a secret… and by the end of our walk, you will know it.",
  "[curious] Two things here keep a story. One you can read, one that flows… Photograph the one you trust.",
  "[whispers] Now you know what the old quay remembers.",
] as const;

const STYLE_PATH = join(process.cwd(), "src", "mastra", "agents", "narrator-style.md");

const FALLBACK = [
  "The narrator: an old Istanbul ferry captain turned city archivist; warm, a little raspy, slow, loves a secret.",
  "Short lines in plain words. Landmark directions, never compass words. Never send the player onto a road,",
  "into private property, or to photograph people. State only cited facts.",
  `Audio tags, at most one per line, at the start of a sentence: ${NARRATOR_TAGS.map((t) => `[${t}]`).join(", ")}.`,
  'Use "…" for a pause.',
].join(" ");

let cached: string | undefined;

/** The style guide as Markdown (a short built-in summary if the file cannot be read). */
export function narratorStyle(): string {
  if (cached === undefined) {
    try {
      cached = readFileSync(STYLE_PATH, "utf8");
    } catch {
      cached = FALLBACK;
    }
  }
  return cached;
}
