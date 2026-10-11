import type {
  FinishResponse,
  PhotoResult,
  RunEnd,
  StartRunResponse,
  StopPrompt,
} from "@/quest/api";
import { addChecker, type PhotoChecker } from "@/quest/checker";
import type { Cue } from "@/quest/schema";
import type { TimelineEvent } from "./receipt";

/**
 * The phone's record of a walk: which screen it is on, the last result and the visibility
 * timeline. Pure transitions; `run-store.ts` keeps the record in localStorage, so a reload
 * or a locked phone keeps the walk.
 */

export type Phase =
  | "briefing" // the narrator sets up the mystery
  | "clue" // how to find the next place
  | "pocket" // "Lock your phone. Go." — walking, nothing plays
  | "look" // "I'm here": the look line, then the camera
  | "checking" // the photo is being checked
  | "result" // passed or skipped: the reveal
  | "bridge" // the way on to the next stop (the fork's choice)
  | "too-far" // GPS says not here yet: hint, distance, direction
  | "needs-retry" // no GPS and the photo did not look like the place
  | "finale"; // the mystery solved

export type DoneResult = Extract<PhotoResult, { status: "passed" | "skipped" }>;
export type MissResult = Extract<PhotoResult, { status: "too-far" | "needs-retry" }>;

export type RunState = {
  v: 1;
  runId: string;
  mock: boolean;
  createdAt: number;
  start: StartRunResponse;
  stop: StopPrompt; // the stop the player is on or walking to
  phase: Phase;
  result: DoneResult | null; // the last passed or skipped stop
  miss: MissResult | null; // the last too-far or needs-retry answer
  passed: Array<{ placeId: string; name: string; status: "passed" | "skipped"; cue?: Cue | null; next?: string | null }>;
  /** The desk demo: no GPS, no walking; sample photos at each stop of the demo quest. */
  desk?: boolean;
  /** Desk demo: the sample photo sent at each stop (placeId → sample id), for its credit line. */
  samples?: Record<string, string>;
  timeline: TimelineEvent[];
  /** Which Gemma read this walk's photos, and where (live checks only), for the receipt. */
  checkers?: PhotoChecker[];
  end: RunEnd | null;
  finish: FinishResponse | null;
  finishedAt: number | null;
};

export function newRun(start: StartRunResponse, mock: boolean, now: number, opts: { desk?: boolean } = {}): RunState {
  return {
    ...(opts.desk ? { desk: true, samples: {} } : {}),
    v: 1,
    runId: start.runId,
    mock,
    createdAt: now,
    start,
    stop: start.first,
    phase: "briefing",
    result: null,
    miss: null,
    passed: [],
    timeline: [{ t: now, e: "visible" }],
    checkers: [],
    end: null,
    finish: null,
    finishedAt: null,
  };
}

const push = (s: RunState, ev: TimelineEvent): RunState => ({ ...s, timeline: [...s.timeline, ev] });

/** After a reload: a photo check in flight is lost, so go back to the camera. */
export function restore(s: RunState, now: number, visible: boolean): RunState {
  const phase = s.phase === "checking" ? "look" : s.phase;
  return visibility({ ...s, phase }, visible, now);
}

export function visibility(s: RunState, visible: boolean, now: number): RunState {
  if (s.finishedAt) return s;
  const last = [...s.timeline].reverse().find((ev) => ev.e === "visible" || ev.e === "hidden");
  if (last?.e === (visible ? "visible" : "hidden")) return s;
  return push(s, { t: now, e: visible ? "visible" : "hidden" });
}

/** Briefing → first clue, or bridge → next clue. */
export function toClue(s: RunState): RunState {
  if (s.phase === "bridge" && s.result?.next) {
    return { ...s, phase: "clue", stop: s.result.next.stop, result: null, miss: null };
  }
  return { ...s, phase: "clue", miss: null };
}

export const toPocket = (s: RunState, now: number): RunState => push({ ...s, phase: "pocket", miss: null }, { t: now, e: "walk" });

/** "I'm here": the look screen has no way back to walking, so this ends the walk for the peek rule. */
export const arrive = (s: RunState, now: number): RunState => push({ ...s, phase: "look" }, { t: now, e: "arrive" });

/** The player opened the camera at the stop (ends the walk for the peek rule). */
export const cameraOpened = (s: RunState, now: number): RunState => push(s, { t: now, e: "photo" });

export const replayed = (s: RunState, now: number): RunState => push(s, { t: now, e: "replay" });

export const checking = (s: RunState): RunState => ({ ...s, phase: "checking" });

export function applyResult(prev: RunState, r: PhotoResult): RunState {
  const s = "verdict" in r && r.verdict?.checkedBy ? { ...prev, checkers: addChecker(prev.checkers ?? [], r.verdict.checkedBy) } : prev;
  if (r.status === "too-far" || r.status === "needs-retry") {
    return { ...s, phase: r.status, miss: r };
  }
  return {
    ...s,
    phase: "result",
    result: r,
    miss: null,
    end: r.end ?? s.end,
    passed: [
      ...s.passed.filter((p) => p.placeId !== r.placeId),
      {
        placeId: r.placeId,
        name: r.name,
        status: r.status,
        // The cue that picked the way on, at a fork only.
        cue: r.next && r.next.chosenBy !== "only-link" ? (r.verdict?.cue ?? null) : null,
        next: r.next?.stop.placeId ?? null,
      },
    ],
  };
}

/** From the reveal: on to the bridge (next stop) or the finale (answer place). */
export function afterResult(s: RunState): RunState {
  if (s.result?.next) return { ...s, phase: "bridge" };
  if (s.result?.end) return { ...s, phase: "finale" };
  return s;
}

/** Desk demo: remember which sample photo was sent at a stop (null: the visitor's own photo). */
export function sampleSent(s: RunState, placeId: string, sampleId: string | null): RunState {
  const samples = { ...(s.samples ?? {}) };
  if (sampleId) samples[placeId] = sampleId;
  else delete samples[placeId];
  return { ...s, samples };
}

/** Back from a photo error: the camera again. */
export const backToLook = (s: RunState): RunState => ({ ...s, phase: "look" });

export const finishLocal = (s: RunState, now: number): RunState =>
  s.finishedAt ? s : push({ ...s, finishedAt: now }, { t: now, e: "end" });

export const withFinish = (s: RunState, f: FinishResponse): RunState => ({ ...s, finish: f });
