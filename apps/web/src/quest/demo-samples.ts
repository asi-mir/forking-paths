import { z } from "zod";
import credits from "../../public/demo/credits.json";
import { CueSchema, PlaceIdSchema, VerdictSchema } from "./schema";

/**
 * The desk demo's sample photos: files in public/demo/, credits in public/demo/credits.json.
 * Their stored reader results live server side (`demo-stored.ts`).
 */

export const DemoSampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  placeId: PlaceIdSchema,
  detail: z.string(), // what the photo shows, as the tile says it
  cue: CueSchema.nullable(), // the cue it should read as (forks only)
  file: z.string().regex(/^[a-z0-9-]+\.jpg$/), // under /demo/
  title: z.string(), // the Commons file title
  author: z.string(),
  licence: z.string(),
  licenceUrl: z.url(),
  filePage: z.url(),
  changes: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type DemoSample = z.infer<typeof DemoSampleSchema>;

const CreditsSchema = z.object({ questId: z.string(), samples: z.array(DemoSampleSchema) });

/** One stored result: the verdict, and how the 10 reads went. */
export const StoredSampleSchema = z.object({
  verdict: VerdictSchema,
  runs: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(), // no-GPS pass rule (plausible && confidence ≥ 0.7)
  cues: z.record(z.string(), z.number().int().nonnegative()), // cue (or "null") → count
  next: z.record(z.string(), z.number().int().nonnegative()).optional(), // forks: next stop → count
  errors: z.number().int().nonnegative(),
  latencyMs: z.object({ p50: z.number(), p95: z.number() }).nullable(),
});
export type StoredSample = z.infer<typeof StoredSampleSchema>;

export const StoredVerdictsSchema = z.object({
  questId: z.string(),
  reader: z.string().nullable(), // e.g. google/gemma-4-26b-a4b-it
  at: z.string().nullable(), // when the reads ran (ISO)
  samples: z.record(z.string(), StoredSampleSchema),
});
export type StoredVerdicts = z.infer<typeof StoredVerdictsSchema>;

const parsedCredits = CreditsSchema.parse(credits);

/** Every sample photo, in stop order. Safe to import in the browser. */
export function demoSamples(): DemoSample[] {
  return parsedCredits.samples;
}

/** The sample photos for one stop of the demo quest. */
export function samplesFor(placeId: string): DemoSample[] {
  return parsedCredits.samples.filter((s) => s.placeId === placeId);
}

export function demoSample(id: string): DemoSample | null {
  return parsedCredits.samples.find((s) => s.id === id) ?? null;
}

/** The public URL of a sample photo. */
export const sampleUrl = (sample: Pick<DemoSample, "file">) => `/demo/${sample.file}`;

/** The quest the sample photos belong to (the Karaköy demo quest). */
export const DESK_QUEST_ID = parsedCredits.questId;

/** Sample photos for a stop of a desk run: only the demo quest has them. */
export const deskSamplesFor = (questId: string, placeId: string) => (questId === DESK_QUEST_ID ? samplesFor(placeId) : []);
