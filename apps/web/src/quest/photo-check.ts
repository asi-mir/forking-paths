import { generateJson, type ImageInput } from "@/lib/json";
import { modelLabel, resolveModelConfig } from "@/lib/model";
import { aiTelemetry, withSpan, type TraceTags } from "@/lib/trace";
import {
  gemmaMeaningPicker,
  readPhoto,
  type ReaderInput,
  type ReadOptions,
  type ReadResult,
} from "@/mastra/agents/reader";
import type { CitedSpokenLine, Hint, VerdictView } from "./api";
import {
  acceptBridge,
  bridgeLine,
  BridgeAnswerSchema,
  bridgePrompt,
  reasonBridge,
  type Bridge,
  type BridgeAnswer,
  type BridgeContext,
} from "./bridge";
import {
  hintFor,
  passRule,
  presence,
  retryMessage,
  shouldRead,
  type PassDecision,
  type Position,
  type Presence,
} from "./check";
import { ForkError, pickNext, type ForkDecision, type MeaningPicker } from "./fork";
import { isFork, placeById } from "./routes";
import { usableObserved, type Quest, type Verdict } from "./schema";

/**
 * The photo check and the fork, wired to Gemma. T22's photo route calls these two:
 *
 *   const check = await checkPhoto({ quest, placeId, image, position });
 *   // passed, and not the answer place:
 *   const next = await chooseNext({ quest, placeId, verdict: check.verdict, position });
 *
 * The photo is used for the reader call and dropped: nothing here stores or logs it, and the
 * reader's span is marked as carrying an image, so prompts and outputs never reach a trace.
 */

export type CheckPhotoInput = {
  quest: Pick<Quest, "places">;
  placeId: string;
  /** The JPEG from the phone (≤ 1024 px, re-encoded, no EXIF). */
  image: ImageInput;
  /** One GPS reading taken with the photo; missing when location is denied or in the desk demo. */
  position?: Partial<Position> | null;
  /** The desk demo's saved verdict for a sample photo: used when the live reader fails. */
  storedVerdict?: Verdict | null;
};

/**
 * How long the reader may take, in total, when GPS already passes the stop: the verdict then only
 * feeds the fork and the bridge, so the player is not kept waiting through a slow model, a repair
 * round or backoff retries. Past it, the stop passes with no verdict (the fork falls back to the
 * nearest link).
 */
export const NEAR_READER_BUDGET_MS = 10_000;

export type CheckPhotoOptions = ReadOptions & {
  /** Total reader budget when GPS says near (default `NEAR_READER_BUDGET_MS`). */
  nearBudgetMs?: number;
  /** Test seam: the reader call (default `readPhoto`). */
  read?: (input: ReaderInput, options: ReadOptions) => Promise<ReadResult>;
};

export type PhotoCheck = {
  placeId: string;
  presence: Presence;
  decision: PassDecision;
  /** What the reader saw; null when it did not run (too far) or failed with no stored verdict. */
  verdict: Verdict | null;
  /** `live`: this call's reader result. `stored`: the desk demo's saved result. */
  verdictSource: "live" | "stored" | null;
  /** Set when GPS puts the player too far away (no model call was made). */
  hint: Hint | null;
  /** Set when GPS is missing and the photo did not pass: what to try instead. */
  retry: string | null;
  /** Whether the reader was called (false when GPS said too far). */
  readerCalled: boolean;
  /** Why the reader failed, when it did (the stop can still pass on GPS). */
  readerError: string | null;
  /** Reader latency (all requests of the call), for the attempt record. */
  latencyMs: number | null;
  /** `google/gemma-4-26b-a4b-it` style label of the reader that ran, for the attempt record. */
  provider: string | null;
};

/** The verdict as the player sees it. */
export function verdictView(check: Pick<PhotoCheck, "verdict" | "verdictSource">): VerdictView | null {
  if (!check.verdict || !check.verdictSource) return null;
  return { ...check.verdict, source: check.verdictSource };
}

/**
 * Check one photo for one stop: presence first (no model call when GPS says too far), then the
 * reader, then the pass rule. GPS near passes whatever the reader says, and a reader that fails
 * or times out never blocks a player whom GPS puts at the place: when GPS says near, the reader
 * gets `NEAR_READER_BUDGET_MS` in total, not its full timeout and retries.
 */
export async function checkPhoto(input: CheckPhotoInput, options: CheckPhotoOptions = {}): Promise<PhotoCheck> {
  const place = placeById(input.quest, input.placeId);
  if (!place) throw new ForkError(`${input.placeId} is not a place of this quest`);

  const p = presence(place, input.position);
  const base = { placeId: place.id, presence: p, hint: null, retry: null, readerError: null };

  if (!shouldRead(p)) {
    return {
      ...base,
      decision: passRule(p, null),
      verdict: null,
      verdictSource: null,
      hint: hintFor(place, p),
      readerCalled: false,
      latencyMs: null,
      provider: null,
    };
  }

  const read = options.read ?? readPhoto;
  const cues = isFork(place) ? place.links.map((l) => l.cue).filter((c) => c !== undefined) : [];
  const started = Date.now();

  let verdict: Verdict | null = null;
  let verdictSource: PhotoCheck["verdictSource"] = null;
  let readerError: string | null = null;
  let latencyMs: number | null = null;
  let provider: string | null = null;
  // GPS near: the pass is decided, so the reader gets one short budget for everything (requests,
  // repair, backoff). Past it the call is aborted and the stop passes without a verdict.
  const nearGps = p.gps && p.near;
  const budget = nearGps ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    provider = modelLabel(resolveModelConfig("reader", options.env ?? process.env));
    const signal = budget ? (options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal) : options.signal;
    const call = read(
      { image: input.image, placeName: place.name, cues },
      { ...options, signal, tags: { ...options.tags, placeId: place.id } },
    );
    const result = budget
      ? await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            const ms = options.nearBudgetMs ?? NEAR_READER_BUDGET_MS;
            timer = setTimeout(() => {
              budget.abort();
              reject(new Error(`reader stopped after ${ms} ms: GPS had already passed the stop`));
            }, ms);
          }),
        ])
      : await call;
    verdict = result.verdict;
    verdictSource = "live";
    latencyMs = result.meta.latencyMs;
  } catch (error) {
    readerError = (error as Error).message;
    latencyMs = Date.now() - started;
    if (input.storedVerdict) {
      verdict = input.storedVerdict;
      verdictSource = "stored";
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const decision = passRule(p, verdict);
  return {
    ...base,
    decision,
    verdict,
    verdictSource,
    retry: decision.passed ? null : retryMessage(decision.reason),
    readerCalled: true,
    readerError,
    latencyMs,
    provider,
  };
}

// ---------------------------------------------------------------------------
// The bridge line (narrator role)

export type WriteBridgeOptions = {
  tags?: TraceTags;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Test seam: a mock model. */
  model?: ReadOptions["model"];
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The narrator's bridge line, checked like a reveal. No observed detail (the reader failed, or
 * its line was dropped) means no call: the link's stored reason is used. A call that fails,
 * times out, or returns a line that fails the checks also falls back to the stored reason.
 */
export async function writeBridge(ctx: BridgeContext, options: WriteBridgeOptions = {}): Promise<Bridge> {
  if (!usableObserved(ctx.observed)) return reasonBridge(ctx.link);
  const env = options.env ?? process.env;
  const config = resolveModelConfig("narrator", env);
  try {
    const answer: BridgeAnswer = await withSpan(
      "fork.bridge",
      { ...options.tags, role: "narrator", provider: config.provider, model: config.modelId, placeId: ctx.place.id },
      async () =>
        (
          await generateJson("narrator", BridgeAnswerSchema, bridgePrompt(ctx), undefined, {
            env,
            model: options.model,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            sleep: options.sleep,
            maxOutputTokens: 200,
            temperature: 0.4,
            telemetry: aiTelemetry("narrator"),
          })
        ).data,
    );
    return acceptBridge(answer, ctx);
  } catch (error) {
    return acceptBridge(null, ctx, (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// The way on

export type ChooseNextInput = {
  quest: Pick<Quest, "places" | "facts" | "lang">;
  placeId: string;
  /** The reader's verdict for the photo that passed this stop (null when it did not run). */
  verdict: Pick<Verdict, "cue" | "observed"> | null;
  /** Where the player stands, for the nearest-link fallback. */
  position?: Partial<Position> | null;
};

export type ChooseNextOptions = WriteBridgeOptions & {
  /** Gemma's pick by meaning (default: the reader role, text only). */
  byMeaning?: MeaningPicker;
  /** Test seam: the bridge writer (default `writeBridge`). */
  bridge?: (ctx: BridgeContext, options: WriteBridgeOptions) => Promise<Bridge>;
  onMeaningFailure?: (reason: string) => void;
};

export type NextChoice = {
  fork: ForkDecision;
  bridge: Bridge;
  /** The bridge as the play API sends it (clipId added by the voice step). */
  line: CitedSpokenLine;
};

/**
 * The next stop out of `placeId` (fork rule, guarded to the place's links) and the bridge line
 * that leads there. Throws `ForkError` at the answer place (no links).
 */
export async function chooseNext(input: ChooseNextInput, options: ChooseNextOptions = {}): Promise<NextChoice> {
  const observed = input.verdict?.observed?.trim() || null;
  const position =
    input.position && typeof input.position.lat === "number" && typeof input.position.lng === "number"
      ? { lat: input.position.lat, lng: input.position.lng }
      : undefined;
  const fork = await pickNext(input.quest, input.placeId, input.verdict, {
    byMeaning:
      options.byMeaning ??
      gemmaMeaningPicker({
        env: options.env,
        model: options.model,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        tags: { ...options.tags, placeId: input.placeId },
      }),
    position,
    onMeaningFailure: options.onMeaningFailure,
  });
  const place = placeById(input.quest, input.placeId)!;
  const write = options.bridge ?? writeBridge;
  const bridge = await write({ quest: input.quest, place, link: fork.link, observed }, options);
  return { fork, bridge, line: bridgeLine(input.quest, bridge) };
}
