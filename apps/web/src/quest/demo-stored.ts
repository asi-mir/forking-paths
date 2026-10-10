import { createHash } from "node:crypto";
import storedJson from "./__fixtures__/demo-verdicts.json";
import { DEMO_QUEST_ID } from "./demo";
import { demoSample, StoredVerdictsSchema, type StoredVerdicts } from "./demo-samples";
import type { Verdict } from "./schema";

/**
 * Stored reader results for the desk demo's sample photos (`__fixtures__/demo-verdicts.json`,
 * written by `scripts/store-demo-verdicts.ts`: each photo read 10 times by the configured reader).
 *
 * The live reader always runs first. A stored result is used only when it fails, is rate-limited
 * or times out, and only for the exact sample file: the upload's sha256 must match, so another
 * photo sent with a sample's id gets no stored result. Server only.
 */

const parsed = StoredVerdictsSchema.parse(storedJson);

export function storedVerdicts(): StoredVerdicts {
  return parsed;
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The stored verdict for a sample photo, or null: the quest must be the demo quest, the sample
 * must belong to the stop, its bytes must be the sample file's, and a stored result must exist.
 */
export function storedVerdictFor(
  input: { questId: string; placeId: string; sampleId?: string | null; image: Uint8Array },
  stored: StoredVerdicts = parsed,
): Verdict | null {
  if (!input.sampleId || input.questId !== DEMO_QUEST_ID) return null;
  const sample = demoSample(input.sampleId);
  if (!sample || sample.placeId !== input.placeId) return null;
  if (sha256Hex(input.image) !== sample.sha256) return null;
  return stored.samples[sample.id]?.verdict ?? null;
}
