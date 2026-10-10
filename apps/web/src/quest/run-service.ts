import { resolveModelConfig } from "@/lib/model";
import { getStore, type Store } from "@/lib/store";
import { runAudio, speak, voiceQuest, type QuestVoice, type VoiceOptions } from "@/lib/voice";
import type { FinishResponse, PhotoResult, Receipt, StartRunResponse } from "./api";
import { DEMO_QUEST_ID, demoQuest } from "./demo";
import { checkPhoto, chooseNext } from "./photo-check";
import {
  finishResponse,
  finishRun,
  ReaderDownError,
  replayResult,
  RunError,
  startRun,
  submitPhoto,
  type PhotoInput,
  type RunDeps,
} from "./run";
import type { Quest, RunVoice } from "./schema";

/**
 * The play routes' engine: the plain run record (`run.ts`) over the store (MongoDB or memory),
 * the voice (ElevenLabs, budget-guarded) and the photo check (Gemma). Route handlers parse the
 * request, call one of these and send the result. The start and photo routes go through the
 * paused walk (`walk.ts`, the `play-quest` workflow), which calls `photoStep` for each photo.
 */

/**
 * The phone gives up on a photo request after 60 s (`src/play/client.ts`), so the server answers
 * well before that: the reader gets 40 s in total (with GPS near, `checkPhoto` already cuts it to
 * 10 s and passes), and the fork's meaning pick plus the bridge line get 12 s; past that the
 * fork takes the nearest link and the bridge is the link's stored reason.
 */
export const READER_DEADLINE_MS = 40_000;
export const BRIDGE_DEADLINE_MS = 12_000;

/** How long Ollama keeps the reader loaded after the warm-up: about one walk. */
export const WARM_KEEP_ALIVE = "30m";
let lastWarm = 0;

/**
 * Loads the local reader model in the background when a run starts (Ollama only), so the first
 * photo is read within `checkPhoto`'s 10 s near-GPS budget. A cold `gemma4:e4b` takes longer
 * than that to load, and the first fork then fell back to the nearest link. An empty prompt
 * makes Ollama load the model without generating anything. Never awaited, never throws; at most
 * once a minute. Returns whether a request was sent.
 */
export function warmLocalReader(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): boolean {
  let config;
  try {
    config = resolveModelConfig("reader", env);
  } catch {
    return false;
  }
  if (config.provider !== "ollama" || !config.baseURL || now - lastWarm < 60_000) return false;
  lastWarm = now;
  const root = config.baseURL.replace(/\/v1$/, "");
  void fetchImpl(`${root}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.modelId, keep_alive: WARM_KEEP_ALIVE }),
    signal: AbortSignal.timeout(180_000),
  })
    .then((res) => res.body?.cancel())
    .catch((error: unknown) => console.warn(`run: could not warm the local reader (${(error as Error).message})`));
  return true;
}

export type ServiceOptions = {
  store?: Store;
  /** Voice options for `voiceQuest` and the bridge lines (tests pass `client: null`). */
  voice?: VoiceOptions;
  /** Test seams: the photo check, the fork and the clock. */
  deps?: Partial<RunDeps>;
};

/**
 * A playable quest by id: from the store, or the desk demo's fixture when the store has no copy
 * yet (then the fixture is saved, so MongoDB holds it too). A quest that failed validation is
 * never played.
 */
export async function loadQuest(questId: string, opts: Pick<ServiceOptions, "store"> = {}): Promise<Quest> {
  const store = opts.store ?? getStore();
  let quest: Quest | null = null;
  try {
    quest = await store.getQuest(questId);
  } catch (error) {
    if (questId !== DEMO_QUEST_ID) throw error;
    console.warn(`run: the store is unavailable (${(error as Error).message}); playing the demo quest from its fixture`);
    return demoQuest();
  }
  if (!quest && questId === DEMO_QUEST_ID) {
    quest = demoQuest();
    try {
      await store.saveQuest(quest);
    } catch (error) {
      console.warn(`run: could not save the demo quest (${(error as Error).message}); playing it from its fixture`);
    }
  }
  if (!quest) throw new RunError("That quest does not exist.", "not-found", 404);
  if (quest.status !== "ready") throw new RunError("That quest is not ready to play.", "not-ready", 409);
  return quest;
}

async function voiceFor(quest: Quest, opts: ServiceOptions): Promise<QuestVoice> {
  try {
    return await voiceQuest(quest, { store: opts.store, ...opts.voice });
  } catch (error) {
    console.warn(`run: voice failed (${(error as Error).message}); text only`);
    return { voice: false, reason: "error", clips: {}, sounds: {}, charsSpent: 0, requests: 0, failed: [] };
  }
}

/** POST /api/runs: loads the quest, voices its lines (budget-aware, text only otherwise), stores the run. */
export async function beginRun(questId: string, userAgent: string | undefined, opts: ServiceOptions = {}): Promise<StartRunResponse> {
  const store = opts.store ?? getStore();
  const quest = await loadQuest(questId, { store });
  if (!opts.deps && process.env.NODE_ENV !== "test") warmLocalReader(); // unit tests make no network calls
  const qv = await voiceFor(quest, { ...opts, store });
  const clips = Object.fromEntries(Object.entries(qv.clips).filter((e): e is [string, string] => typeof e[1] === "string"));
  const voice: RunVoice = { on: qv.voice, clips: qv.voice ? clips : {} };
  const run = await store.startRun({ questId: quest.id ?? questId, ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}), voice });
  return startRun(quest, run, runAudio(qv));
}

/** POST /api/runs/[runId]/photo: checks one photo and moves the run on. The image is never stored. */
export async function photoStep(runId: string, input: PhotoInput, opts: ServiceOptions = {}): Promise<PhotoResult> {
  const store = opts.store ?? getStore();
  const run = await store.getRun(runId);
  if (!run) throw new RunError("This walk was not found. Start a new one.", "not-found", 404);
  const quest = await loadQuest(run.questId, { store });
  const attempts = await store.attemptsFor(runId);
  const deps: RunDeps = {
    check: (i, o) => checkPhoto(i, { ...o, signal: AbortSignal.timeout(READER_DEADLINE_MS) }),
    choose: (i, o) => chooseNext(i, { ...o, signal: AbortSignal.timeout(BRIDGE_DEADLINE_MS) }),
    speak: (text) => speak(text, { store, lang: quest.lang, ...opts.voice }),
    now: () => new Date(),
    ...opts.deps,
  };

  let out;
  try {
    out = await submitPhoto(quest, { run, attempts }, input, deps);
  } catch (error) {
    if (error instanceof ReaderDownError) await store.saveAttempt(error.attempt);
    throw error;
  }
  if (out.attempt) await store.saveAttempt(out.attempt);
  if (out.step) {
    const saved = await store.appendToPath(runId, out.step);
    // Two requests for the same stop at once: the first one saved wins, and both get its answer.
    const kept = saved?.path.find((s) => s.placeId === out.step!.placeId);
    if (saved && kept && (kept.to !== out.step.to || kept.bridge !== out.step.bridge || kept.status !== out.step.status)) {
      return replayResult(quest, saved, await store.attemptsFor(runId), out.step.placeId);
    }
  }
  return out.result;
}

/** POST /api/runs/[runId]/finish: saves the receipt and score once; finishing again returns the first. */
export async function finishWalk(runId: string, receipt: Receipt, opts: Pick<ServiceOptions, "store"> = {}): Promise<FinishResponse> {
  const store = opts.store ?? getStore();
  const run = await store.getRun(runId);
  if (!run) throw new RunError("This walk was not found.", "not-found", 404);
  const saved = await store.finishRun(runId, finishRun(run, receipt));
  if (!saved) throw new RunError("This walk was not found.", "not-found", 404);
  return finishResponse(saved);
}
