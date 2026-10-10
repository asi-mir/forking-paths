import { mastra } from "@/mastra";
import { parkPhoto, unparkPhoto, WALK_STEP_ID } from "@/mastra/workflows/play-quest";
import { getStore } from "@/lib/store";
import type { PhotoResult, StartRunResponse } from "./api";
import type { PhotoInput } from "./run";
import { beginRun, loadQuest, photoStep, type ServiceOptions } from "./run-service";

/**
 * The play routes over the paused walk. `POST /api/runs` stores the run (T22's plain record,
 * which the phone, the end page and the finish route read) and starts a `play-quest` workflow
 * run with the same id; it suspends at the first stop. `POST /api/runs/[runId]/photo` resumes it
 * with the photo, and the workflow moves the walk on through the plain engine.
 *
 * The response shapes are T22's. The run record stays the source of truth: when the workflow
 * cannot take a photo (no snapshot, not suspended, or a resume that fails before the check),
 * the plain engine answers it, so a walk never stops because of the workflow. A photo for a stop
 * already done, or for a finished walk, is answered from the record without a resume.
 */

const workflow = () => mastra.getWorkflow("playQuest");

/** One photo at a time per walk in this process: a second request waits for the first. */
type Queue = Map<string, Promise<unknown>>;
const g = globalThis as typeof globalThis & { __forkingPathsWalkQueue?: Queue };
const queue: Queue = (g.__forkingPathsWalkQueue ??= new Map());

async function oneAtATime<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const before = queue.get(runId) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(fn);
  const tail = mine.catch(() => undefined);
  queue.set(runId, tail);
  try {
    return await mine;
  } finally {
    if (queue.get(runId) === tail) queue.delete(runId);
  }
}

/** POST /api/runs: stores the run, voices the quest (T22), and starts its paused walk. */
export async function startWalk(questId: string, userAgent: string | undefined, opts: ServiceOptions = {}): Promise<StartRunResponse> {
  const started = await beginRun(questId, userAgent, opts);
  try {
    const quest = await loadQuest(started.questId, { store: opts.store });
    const run = await workflow().createRun({ runId: started.runId });
    const out = await run.start({ inputData: { questId: started.questId, lang: quest.lang } });
    if (out.status !== "suspended") console.warn(`walk: the walk did not pause at its first stop (${out.status}); plain record only`);
  } catch (error) {
    console.warn(`walk: could not start the paused walk (${(error as Error).message}); plain record only`);
  }
  return started;
}

/** POST /api/runs/[runId]/photo: resumes the paused walk with the photo (in memory only). */
export function walkPhoto(runId: string, input: PhotoInput, opts: ServiceOptions = {}): Promise<PhotoResult> {
  return oneAtATime(runId, async () => {
    const store = opts.store ?? getStore();
    const run = await store.getRun(runId);
    // Unknown, finished, or a stop already done (a lost response): the record answers.
    if (!run || run.finishedAt || run.path.some((s) => s.placeId === input.placeId)) return photoStep(runId, input, opts);

    const wf = workflow();
    const snapshot = await wf.getWorkflowRunById(runId).catch(() => null);
    if (snapshot?.status !== "suspended") {
      console.warn(`walk: run ${runId} has no paused walk (${snapshot?.status ?? "none"}); plain record`);
      return photoStep(runId, input, opts);
    }

    const { key, entry } = parkPhoto({ runId, input, opts });
    try {
      try {
        const live = await wf.createRun({ runId });
        await live.resume({ step: WALK_STEP_ID, resumeData: { photo: key } });
      } catch (error) {
        if (!entry.outcome) {
          console.warn(`walk: could not resume run ${runId} (${(error as Error).message}); plain record`);
          return photoStep(runId, input, opts);
        }
        console.warn(`walk: run ${runId} took the photo but did not save its pause (${(error as Error).message})`);
      }
      if (!entry.outcome) {
        console.warn(`walk: run ${runId} resumed without checking the photo; plain record`);
        return photoStep(runId, input, opts);
      }
      if ("error" in entry.outcome) throw entry.outcome.error;
      return entry.outcome.result;
    } finally {
      unparkPhoto(key);
    }
  });
}
