import type { ImageInput } from "@/lib/json";
import type { QuestLineKey } from "@/lib/audio-mix";
import { displayText } from "@/lib/voice";
import { scoreRun, screenOnShareOf } from "@/play/receipt";
import {
  PHOTO_RETRIES,
  type CaseFile,
  type CitedSpokenLine,
  type FinishResponse,
  type NextStop,
  type PhotoResult,
  type Receipt,
  type SpokenLine,
  type StartRunResponse,
  type StopPrompt,
} from "./api";
import { citedFacts } from "./bridge";
import { viewOfVerdict } from "./checker";
import type { Position } from "./check";
import type { CheckPhotoInput, CheckPhotoOptions, ChooseNextInput, ChooseNextOptions, NextChoice, PhotoCheck } from "./photo-check";
import { isFork, placeById, roadNotTaken } from "./routes";
import type { Attempt, PathStep, Place, Quest, Run, RunVoice, Verdict } from "./schema";

/**
 * The plain run record: a small state machine over a stored `Run` (its walked path) and its
 * photo attempts. No storage and no clock here: the photo check, the fork and the voice are
 * passed in, and every function returns what to save. `run-service.ts` wires it to the store.
 *
 *   startRun(quest, run, audio)          → the briefing and the first clue
 *   submitPhoto(quest, state, input, deps) → passed / skipped / too far / try again, plus the
 *                                            attempt and the path step to save
 *   finishRun(run, receipt)              → the receipt and score to save
 *
 * Rules:
 * - GPS near passes the stop, whatever the reader says. Too far: the place's hint, distance and
 *   compass direction, with no model call. GPS missing: pass when plausible and confidence ≥ 0.7.
 * - A stop allows PHOTO_RETRIES misses; the next miss skips it (the reveal is still told).
 * - At a fork the next stop is the link the fork rule picks (`chooseNext`), and it must be a
 *   link of the current place. At the answer place: the finale and the case file.
 * - The photo is used for the check and dropped: nothing here keeps or returns it.
 */

export type RunErrorCode = "not-found" | "finished" | "wrong-place" | "bad-request" | "reader-unavailable" | "not-ready" | "over-cap";

/** A request the run cannot take, with a sentence the phone can show and an HTTP status. */
export class RunError extends Error {
  override name = "RunError";
  constructor(
    message: string,
    readonly code: RunErrorCode,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A stored run and its attempts so far: everything the next photo needs. */
export type RunState = { run: Run; attempts: readonly Attempt[] };

// ---------------------------------------------------------------------------
// Lines

/** A quest line as the API sends it: display text, and its clip when the run has voice. */
export function questLine(voice: RunVoice | undefined, key: QuestLineKey, text: string): SpokenLine {
  const clipId = voice?.on ? voice.clips[key] : undefined;
  return clipId ? { text: displayText(text), clipId } : { text: displayText(text) };
}

function citedLine(quest: Quest, voice: RunVoice | undefined, key: QuestLineKey, line: { text: string; factIds: string[] }): CitedSpokenLine {
  return { line: questLine(voice, key, line.text), facts: citedFacts(quest, line.factIds) };
}

function stopPrompt(quest: Quest, voice: RunVoice | undefined, place: Place, stop: number): StopPrompt {
  return {
    placeId: place.id,
    stop,
    of: quest.stopsPerRun,
    isFork: isFork(place),
    clue: questLine(voice, `${place.id}.clue`, place.clue.text),
    look: questLine(voice, `${place.id}.look`, place.look.text),
  };
}

// ---------------------------------------------------------------------------
// Start

/** The audio fields of the start response (`runAudio` in `@/lib/voice`). */
export type RunAudio = Pick<StartRunResponse, "voice" | "preload" | "ambienceClipId" | "stingers">;

/** The briefing and the first clue for a run that was just stored. */
export function startRun(quest: Quest, run: Pick<Run, "id" | "questId" | "voice">, audio: RunAudio): StartRunResponse {
  const start = placeById(quest, quest.startPlaceId);
  if (!start) throw new RunError("This quest has no start place.", "not-ready", 409);
  return {
    runId: run.id,
    questId: run.questId,
    title: quest.title,
    mystery: quest.mystery.question,
    briefing: questLine(run.voice, "briefing", quest.briefing.text),
    first: stopPrompt(quest, run.voice, start, 1),
    preload: audio.voice ? audio.preload : [],
    ...(audio.voice && audio.ambienceClipId ? { ambienceClipId: audio.ambienceClipId } : {}),
    stingers: audio.voice ? audio.stingers : {},
    voice: audio.voice,
  };
}

// ---------------------------------------------------------------------------
// Where the run is

export type RunPosition = { done: false; place: Place; stop: number } | { done: true; stop: number };

/** The next stop a step leads to: its saved `to`, else the one link not in `notTaken`. */
function nextOf(place: Place, step: PathStep): string | null {
  if (step.to !== undefined) return step.to;
  return place.links.find((l) => !step.notTaken.some((n) => n.to === l.to))?.to ?? null;
}

/** The stop the player is walking to, from the walked path. Throws when the path does not fit the quest. */
export function runPosition(quest: Quest, run: Pick<Run, "path">): RunPosition {
  let at: string | null = quest.startPlaceId;
  for (const step of run.path) {
    if (at === null || step.placeId !== at) throw new RunError("This walk's record does not fit its quest.", "not-ready", 409);
    const place = placeById(quest, at);
    if (!place) throw new RunError("This walk's record does not fit its quest.", "not-ready", 409);
    at = place.id === quest.answerPlaceId ? null : nextOf(place, step);
  }
  if (at === null) return { done: true, stop: run.path.length };
  const place = placeById(quest, at);
  if (!place) throw new RunError("This walk's record does not fit its quest.", "not-ready", 409);
  return { done: false, place, stop: run.path.length + 1 };
}

/**
 * Misses so far at a stop: too far (GPS) or not plausible (no GPS). An attempt with neither a
 * distance nor a verdict (the reader failed with GPS missing) is the server's fault, not the
 * player's, so it does not use up a retry.
 */
export function missesAt(attempts: readonly Attempt[], placeId: string): number {
  return attempts.filter((a) => a.placeId === placeId && !a.passed && (a.distanceM !== null || a.verdict !== null)).length;
}

/** Attempts at a stop where GPS was missing and the reader gave no answer. */
export function noVerdictsAt(attempts: readonly Attempt[], placeId: string): number {
  return attempts.filter((a) => a.placeId === placeId && !a.passed && a.distanceM === null && a.verdict === null).length;
}

/**
 * Reader calls one walk may make: every stop's misses, plus two spare per stop. Past it, the
 * reader is not called (a script that loops photos cannot use up the model quota).
 */
export function readerCallsPerRun(quest: Pick<Quest, "places">): number {
  return quest.places.length * (PHOTO_RETRIES + 2);
}

// ---------------------------------------------------------------------------
// Case file

/** The case file for a walked path: the route, the road not taken and every fact with its link. */
export function caseFile(quest: Quest, path: readonly PathStep[]): CaseFile {
  return {
    mystery: { question: quest.mystery.question, answer: quest.mystery.answer },
    route: path.map((step) => ({
      placeId: step.placeId,
      name: placeById(quest, step.placeId)?.name ?? step.placeId,
      status: step.status,
      observed: step.observed,
      cue: step.cue,
    })),
    notTaken: roadNotTaken(quest, path),
    facts: citedFacts(
      quest,
      quest.facts.map((f) => f.id),
    ),
  };
}

// ---------------------------------------------------------------------------
// A photo

export type PhotoInput = {
  placeId: string;
  /** The photo, in memory only: it goes to the reader and is dropped. */
  image: ImageInput;
  /** One GPS reading taken with the photo; missing when location is denied or in the desk demo. */
  position?: Position | null;
  /** The desk demo's saved verdict for a sample photo: used when the live reader fails. */
  storedVerdict?: Verdict | null;
};

export type RunDeps = {
  check: (input: CheckPhotoInput, options?: CheckPhotoOptions) => Promise<PhotoCheck>;
  choose: (input: ChooseNextInput, options?: ChooseNextOptions) => Promise<NextChoice>;
  /** Voices a bridge line; null = text only. Called only when the run has voice. */
  speak: (text: string) => Promise<string | null>;
  now: () => Date;
};

export type PhotoStep = {
  result: PhotoResult;
  /** The attempt to save (null when a lost response is sent again). */
  attempt: Attempt | null;
  /** The path step to save when the stop is done (passed or skipped). */
  step: PathStep | null;
};

const verdictOf = (check: PhotoCheck) =>
  check.verdict && check.verdictSource ? viewOfVerdict(check.verdict, check.verdictSource, check.provider) : null;

/**
 * One photo for the stop the player is at. Returns the result for the phone, the attempt and,
 * when the stop is done, the path step. A photo for a stop already done is answered from the
 * record (a phone whose response was lost sends it again), without a model call.
 */
export async function submitPhoto(quest: Quest, state: RunState, input: PhotoInput, deps: RunDeps): Promise<PhotoStep> {
  const { run } = state;
  if (run.finishedAt) throw new RunError("This walk is already over.", "finished", 409);
  const done = run.path.find((s) => s.placeId === input.placeId);
  if (done) return { result: replayResult(quest, run, state.attempts, input.placeId), attempt: null, step: null };

  const pos = runPosition(quest, run);
  if (pos.done) throw new RunError("This walk is already over.", "finished", 409);
  const place = pos.place;
  if (input.placeId !== place.id) throw new RunError("That photo is for a different stop.", "wrong-place", 409);

  const tags = { questId: run.questId, runId: run.id, placeId: place.id };
  const check = await deps.check(
    { quest, placeId: place.id, image: input.image, position: input.position ?? null, storedVerdict: input.storedVerdict ?? null },
    { tags },
  );
  const attempt: Attempt = {
    questId: run.questId,
    runId: run.id,
    placeId: place.id,
    at: deps.now().toISOString(),
    distanceM: check.presence.gps ? Math.round(check.presence.distanceM) : null,
    accuracyM: check.presence.gps ? check.presence.accuracyM : null,
    verdict: check.verdict,
    passed: check.decision.passed,
    provider: check.provider,
    latencyMs: check.latencyMs,
    ...(check.verdictSource === "stored" ? { storedVerdict: true } : {}),
  };

  const misses = missesAt(state.attempts, place.id);
  if (!check.decision.passed) {
    // GPS missing and the reader gave no answer: not the player's miss. Save it, say try again;
    // after PHOTO_RETRIES + 1 such answers at a stop, skip it so the player is never stuck.
    if (check.decision.reason === "no-verdict" && noVerdictsAt(state.attempts, place.id) < PHOTO_RETRIES) {
      throw new ReaderDownError(attempt, check.readerCapped === true);
    }
    if (check.decision.reason !== "no-verdict" && misses < PHOTO_RETRIES) {
      const retriesLeft = PHOTO_RETRIES - (misses + 1);
      if (check.hint) {
        const hint = { ...check.hint, line: questLine(run.voice, `${place.id}.hint`, place.hint.text) };
        return { result: { status: "too-far", placeId: place.id, hint, retriesLeft }, attempt, step: null };
      }
      const verdict = verdictOf(check)!;
      return {
        result: {
          status: "needs-retry",
          placeId: place.id,
          verdict,
          message: { text: check.retry ?? "Try another photo of the detail." },
          retriesLeft,
        },
        attempt,
        step: null,
      };
    }
  }

  // Passed, or out of retries (skipped): the reveal, then the way on or the end.
  const status = check.decision.passed ? ("passed" as const) : ("skipped" as const);
  const verdict = status === "passed" ? check.verdict : null;
  const base = {
    status,
    placeId: place.id,
    name: place.name,
    verdict: status === "passed" ? verdictOf(check) : null,
    reveal: citedLine(quest, run.voice, `${place.id}.reveal`, place.reveal),
  };

  if (place.id === quest.answerPlaceId || place.links.length === 0) {
    const step: PathStep = {
      placeId: place.id,
      status,
      observed: verdict?.observed ?? null,
      cue: null,
      bridge: null,
      notTaken: [],
      to: null,
    };
    const end = { finale: citedLine(quest, run.voice, "finale", quest.finale), caseFile: caseFile(quest, [...run.path, step]) };
    return { result: { ...base, next: null, end }, attempt, step };
  }

  const choice = await deps.choose(
    { quest, placeId: place.id, verdict, position: input.position ?? null },
    { tags },
  );
  // The guard: whatever the fork rule returns must be one of this place's links.
  const link = place.links.find((l) => l.to === choice.fork.link.to);
  const nextPlace = link ? placeById(quest, link.to) : undefined;
  if (!link || !nextPlace) throw new Error(`the fork chose ${choice.fork.link.to}, which is not a link of ${place.id}`);

  const bridgeClipId = run.voice?.on ? await deps.speak(choice.bridge.text).catch(() => null) : null;
  const bridge: CitedSpokenLine = {
    line: bridgeClipId ? { text: displayText(choice.bridge.text), clipId: bridgeClipId } : { text: displayText(choice.bridge.text) },
    facts: citedFacts(quest, choice.bridge.factIds),
  };
  const step: PathStep = {
    placeId: place.id,
    status,
    observed: verdict?.observed ?? null,
    cue: isFork(place) ? (link.cue ?? null) : null,
    bridge: bridge.line.text,
    notTaken: place.links.filter((l) => l.to !== link.to).map((l) => ({ to: l.to, cue: l.cue ?? null })),
    to: link.to,
    chosenBy: choice.fork.chosenBy,
    bridgeFactIds: choice.bridge.factIds,
    ...(bridgeClipId ? { bridgeClipId } : {}),
  };
  const next: NextStop = {
    bridge,
    chosenBy: choice.fork.chosenBy,
    stop: stopPrompt(quest, run.voice, nextPlace, pos.stop + 1),
  };
  return { result: { ...base, next, end: null }, attempt, step };
}

/** GPS missing and the reader failed: no verdict to decide with. Carries the attempt to save. */
export class ReaderDownError extends RunError {
  override name = "ReaderDownError";
  constructor(
    readonly attempt: Attempt,
    capped = false,
  ) {
    super(
      capped
        ? "Today's photo checks are used up. Allow location and take the photo again: GPS can pass the stop on its own."
        : "The photo check is not answering right now. Try the photo again in a moment.",
      "reader-unavailable",
      503,
    );
  }
}

/**
 * The result of a stop already done, rebuilt from the record (no model call, no new attempt):
 * the answer for a phone that sends the same photo again because the first response was lost.
 */
export function replayResult(quest: Quest, run: Pick<Run, "path" | "voice">, attempts: readonly Attempt[], placeId: string): PhotoResult {
  const i = run.path.findIndex((s) => s.placeId === placeId);
  const step = run.path[i];
  const place = step ? placeById(quest, placeId) : undefined;
  if (!step || !place) throw new RunError("That photo is for a different stop.", "wrong-place", 409);
  const last = [...attempts].reverse().find((a) => a.placeId === placeId && a.passed && a.verdict);
  const verdict =
    step.status === "passed" && last?.verdict ? viewOfVerdict(last.verdict, last.storedVerdict ? "stored" : "live", last.provider) : null;
  const base = {
    status: step.status,
    placeId,
    name: place.name,
    verdict,
    reveal: citedLine(quest, run.voice, `${place.id}.reveal`, place.reveal),
  };
  const to = nextOf(place, step);
  const nextPlace = to && place.id !== quest.answerPlaceId ? placeById(quest, to) : undefined;
  if (!nextPlace) {
    return {
      ...base,
      next: null,
      end: { finale: citedLine(quest, run.voice, "finale", quest.finale), caseFile: caseFile(quest, run.path.slice(0, i + 1)) },
    };
  }
  const link = place.links.find((l) => l.to === nextPlace.id)!;
  const text = step.bridge ?? link.reason;
  return {
    ...base,
    next: {
      bridge: {
        line: step.bridgeClipId ? { text, clipId: step.bridgeClipId } : { text },
        facts: citedFacts(quest, step.bridgeFactIds ?? link.factIds),
      },
      chosenBy: step.chosenBy ?? (place.links.length === 1 ? "only-link" : "nearest"),
      stop: stopPrompt(quest, run.voice, nextPlace, i + 2),
    },
    end: null,
  };
}

// ---------------------------------------------------------------------------
// Finish

/** What the finish route saves, and the response built from the run as saved. */
export function finishRun(run: Pick<Run, "path">, receipt: Receipt) {
  const stopsFound = run.path.filter((s) => s.status === "passed").length;
  return { stopsFound, score: scoreRun({ stopsFound, receipt }).total, ...receipt };
}

/** The finish response from the stored run (a second finish returns the first one's numbers). */
export function finishResponse(run: Run): FinishResponse {
  const receipt: Receipt = {
    screenOnMs: Math.round(run.screenOnMs ?? 0),
    pocketMs: Math.round(run.pocketMs ?? 0),
    peeks: run.peeks ?? 0,
  };
  return {
    runId: run.id,
    stopsFound: run.stopsFound ?? run.path.filter((s) => s.status === "passed").length,
    score: run.score ?? 0,
    screenOnShare: screenOnShareOf(receipt),
    receipt,
  };
}
