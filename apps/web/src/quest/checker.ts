import { z } from "zod";
import type { Verdict } from "./schema";

/**
 * Which Gemma read a photo, and where it ran. Shown on the screen-time receipt and sent as a
 * trace tag, so a walk says whether its photos stayed on the owner's machine. Pure: no SDK
 * import, safe in the browser.
 */

export const PhotoCheckerSchema = z.object({
  provider: z.enum(["google", "ollama"]), // google = Google AI Studio; ollama = your own machine
  model: z.string().min(1), // the provider's model ID, e.g. gemma-4-26b-a4b-it or gemma4:e4b
});
export type PhotoChecker = z.infer<typeof PhotoCheckerSchema>;

/** The checker from a model label (`ollama/gemma4:e4b`, as the attempt record keeps it), or null. */
export function checkerFromLabel(label: string | null | undefined): PhotoChecker | null {
  if (!label) return null;
  const slash = label.indexOf("/");
  if (slash <= 0) return null;
  const parsed = PhotoCheckerSchema.safeParse({ provider: label.slice(0, slash), model: label.slice(slash + 1) });
  return parsed.success ? parsed.data : null;
}

/**
 * A model ID in plain words: `gemma-4-26b-a4b-it` → "Gemma 4 26B", `gemma4:e4b` → "Gemma 4 E4B",
 * `gemma4:latest` → "Gemma 4". Anything else is shown as its ID.
 */
export function gemmaName(modelId: string): string {
  const sized = /^gemma-?(\d+(?:\.\d+)?)[-:](e?\d+(?:\.\d+)?b)(?![a-z0-9])/i.exec(modelId);
  if (sized) return `Gemma ${sized[1]} ${sized[2].toUpperCase()}`;
  const family = /^gemma-?(\d+(?:\.\d+)?)(?![\d.])/i.exec(modelId);
  return family ? `Gemma ${family[1]}` : modelId;
}

/** Where a provider runs, in the words the receipt uses. */
export const CHECKER_PLACE: Record<PhotoChecker["provider"], string> = {
  google: "on Google AI Studio",
  ollama: "on my laptop (Ollama)",
};

/** "Gemma 4 E4B on my laptop (Ollama)" or "Gemma 4 26B on Google AI Studio". */
export function checkerLabel(checker: PhotoChecker): string {
  return `${gemmaName(checker.model)} ${CHECKER_PLACE[checker.provider]}`;
}

/** Adds a checker to a list once (same provider and model). */
export function addChecker(list: readonly PhotoChecker[], checker: PhotoChecker | null | undefined): PhotoChecker[] {
  if (!checker || list.some((c) => c.provider === checker.provider && c.model === checker.model)) return [...list];
  return [...list, checker];
}

/**
 * A verdict as the phone sees it (the play API's `VerdictView`): a live one says which Gemma read
 * the photo, from the attempt's model label; a stored one (the desk demo's saved result) does not.
 */
export function viewOfVerdict(verdict: Verdict, source: "live" | "stored", providerLabel: string | null) {
  const checkedBy = source === "live" ? checkerFromLabel(providerLabel) : null;
  return { ...verdict, source, ...(checkedBy ? { checkedBy } : {}) };
}
