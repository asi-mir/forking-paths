import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { getStore } from "@/lib/store";
import { CaseFileSchema, type PhotoResult } from "@/quest/api";
import { caseFile, type PhotoInput } from "@/quest/run";
import { loadQuest, photoStep, type ServiceOptions } from "@/quest/run-service";
import { LangSchema, PlaceIdSchema } from "@/quest/schema";

/**
 * The walk as a paused workflow ("play-quest"). One run per walk, with the walk's run id. It
 * loops over the route: at each stop it suspends with `{ placeId }` while the player walks, and
 * the photo route resumes it with the photo. Suspended runs live in Mastra's storage (MongoDB
 * when MONGODB_URI is set), so a walk survives a server restart.
 *
 * The rules are not here: on resume the step calls the plain run engine (`photoStep` in
 * `run-service.ts`, over `run.ts`), which checks the photo (T08), allows PHOTO_RETRIES misses,
 * skips after that, picks the next stop at a fork, voices the bridge line and saves the attempt
 * and the walked path. The workflow follows the result: the same stop again (too far, try
 * again), the next stop, or the answer place, where it ends with the finale and the case file.
 *
 * The photo never enters a snapshot. Mastra stores resume data, so the route parks the photo
 * in this process's memory (`parkPhoto`) and resumes with its key only; the step takes it out,
 * and the snapshot keeps the reader's `observed` text, never the image.
 */

export const PLAY_QUEST_WORKFLOW_ID = "play-quest";
export const WALK_STEP_ID = "walk-stop";

// ---------------------------------------------------------------------------
// The photo hand-off (in memory, this process only)

/** A photo waiting for its resume, and what the step made of it. */
export type ParkedPhoto = {
  runId: string;
  input: PhotoInput;
  /** The route's options (the store, voice and test seams), passed through to `photoStep`. */
  opts: ServiceOptions;
  /** Set by the step: the result for the phone, or the error to send. */
  outcome?: { result: PhotoResult } | { error: unknown };
};

type Parking = Map<string, ParkedPhoto>;
const g = globalThis as typeof globalThis & { __forkingPathsParkedPhotos?: Parking };
const parked: Parking = (g.__forkingPathsParkedPhotos ??= new Map());

/** Parks a photo for one resume and returns its key. Call `unparkPhoto` when the request is done. */
export function parkPhoto(entry: Omit<ParkedPhoto, "outcome">): { key: string; entry: ParkedPhoto } {
  const key = crypto.randomUUID();
  const held: ParkedPhoto = { ...entry };
  parked.set(key, held);
  return { key, entry: held };
}

/** Drops a parked photo (the image goes with it). */
export function unparkPhoto(key: string): void {
  parked.delete(key);
}

/** How many photos are parked right now (tests: always 0 once a request is answered). */
export function parkedCount(): number {
  return parked.size;
}

// ---------------------------------------------------------------------------
// Schemas (what a snapshot holds: ids, counters and short text, never an image)

const WalkInputSchema = z.object({ questId: z.string().min(1), lang: LangSchema });

/** Where the walk is: the stop the player is walking to, or done. */
const WalkStateSchema = z.object({
  questId: z.string(),
  placeId: PlaceIdSchema.nullable(),
  stop: z.number().int().positive(),
  of: z.number().int().positive(),
  done: z.boolean(),
});
type WalkState = z.infer<typeof WalkStateSchema>;

/** The last photo at this stop, in short: what Studio shows while the walk is paused. */
const LastPhotoSchema = z.object({
  status: z.enum(["passed", "skipped", "too-far", "needs-retry", "error", "no-photo"]),
  placeId: z.string().nullable(),
  observed: z.string().nullable(),
  retriesLeft: z.number().int().nonnegative().nullable(),
  distanceM: z.number().nonnegative().nullable(),
});
type LastPhoto = z.infer<typeof LastPhotoSchema>;

const WalkSuspendSchema = z.object({
  placeId: PlaceIdSchema,
  stop: z.number().int().positive(),
  of: z.number().int().positive(),
  waitingFor: z.literal("photo"),
  last: LastPhotoSchema.nullable(),
});

/** Resume data: the key of a parked photo, never the photo. */
const WalkResumeSchema = z.object({ photo: z.string().min(1) });

const WalkEndSchema = z.object({
  questId: z.string(),
  finale: z.string(),
  caseFile: CaseFileSchema,
});

/** The short form of a photo result kept in a snapshot. */
export function lastPhoto(result: PhotoResult): LastPhoto {
  switch (result.status) {
    case "too-far":
      return { status: result.status, placeId: result.placeId, observed: null, retriesLeft: result.retriesLeft, distanceM: result.hint.distanceM };
    case "needs-retry":
      return { status: result.status, placeId: result.placeId, observed: result.verdict.observed, retriesLeft: result.retriesLeft, distanceM: null };
    default:
      return { status: result.status, placeId: result.placeId, observed: result.verdict?.observed ?? null, retriesLeft: null, distanceM: null };
  }
}

/** Where a photo result leaves the walk: the same stop, the next one, or the end. */
export function afterPhoto(state: WalkState, result: PhotoResult): WalkState {
  if (result.status === "too-far" || result.status === "needs-retry") return state;
  if (result.end) return { ...state, placeId: null, done: true };
  if (result.next) return { ...state, placeId: result.next.stop.placeId, stop: result.next.stop.stop, done: false };
  return state;
}

// ---------------------------------------------------------------------------
// Steps

const beginStep = createStep({
  id: "begin",
  description: "Loads the quest and sends the player to its first stop.",
  inputSchema: WalkInputSchema,
  outputSchema: WalkStateSchema,
  execute: async ({ inputData }) => {
    const quest = await loadQuest(inputData.questId);
    return { questId: inputData.questId, placeId: quest.startPlaceId, stop: 1, of: quest.stopsPerRun, done: false };
  },
});

const walkStep = createStep({
  id: WALK_STEP_ID,
  description: "Waits while the player walks to a stop, then checks their photo and moves the walk on.",
  inputSchema: WalkStateSchema,
  outputSchema: WalkStateSchema,
  suspendSchema: WalkSuspendSchema,
  resumeSchema: WalkResumeSchema,
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const state = inputData;
    const wait = (last: LastPhoto | null) =>
      suspend({ placeId: state.placeId!, stop: state.stop, of: state.of, waitingFor: "photo" as const, last });
    if (state.done || !state.placeId) return state;
    if (!resumeData) return wait(null);

    const entry = parked.get(resumeData.photo);
    if (!entry || entry.runId !== runId) {
      // Resumed without a photo in this process (e.g. by hand from Studio): keep waiting.
      return wait({ status: "no-photo", placeId: state.placeId, observed: null, retriesLeft: null, distanceM: null });
    }
    let result: PhotoResult;
    try {
      result = await photoStep(runId, entry.input, entry.opts);
    } catch (error) {
      entry.outcome = { error };
      return wait({ status: "error", placeId: entry.input.placeId, observed: null, retriesLeft: null, distanceM: null });
    } finally {
      // The image is not needed past the check: drop it now, keep only the outcome.
      entry.input = { ...entry.input, image: { data: new Uint8Array(), mediaType: entry.input.image.mediaType } };
    }
    entry.outcome = { result };
    const next = afterPhoto(state, result);
    if (next.done) return next;
    if (next.placeId === state.placeId) return wait(lastPhoto(result));
    return next; // the loop runs the step again for the next stop, which suspends there
  },
});

const finaleStep = createStep({
  id: "finale",
  description: "At the answer place: the finale and the case file (the route, the detail at each fork, the road not taken).",
  inputSchema: WalkStateSchema,
  outputSchema: WalkEndSchema,
  execute: async ({ inputData, runId }) => {
    const store = getStore();
    const quest = await loadQuest(inputData.questId, { store });
    const run = await store.getRun(runId);
    return { questId: inputData.questId, finale: quest.finale.text, caseFile: caseFile(quest, run?.path ?? []) };
  },
});

export const playQuest = createWorkflow({
  id: PLAY_QUEST_WORKFLOW_ID,
  description: "One walk: a clue, a pause while the player walks, a photo, the next stop, until the answer.",
  inputSchema: WalkInputSchema,
  outputSchema: WalkEndSchema,
})
  .then(beginStep)
  .dountil(walkStep, async ({ inputData }) => inputData.done)
  .then(finaleStep)
  .commit();
