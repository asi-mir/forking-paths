import { z } from "zod";
import { COMPASS_8 } from "@/lib/geo";
import {
  CueSchema,
  FactIdSchema,
  FactSourceSchema,
  ForkChoiceSchema,
  LangSchema,
  PlaceIdSchema,
  StopsPerRunSchema,
} from "./schema";

/**
 * The play loop's client–server contract: request and response shapes of the play routes.
 * The phone UI parses responses with these schemas; the route handlers parse requests
 * with them and build responses that match them. Keep them stable: the engine behind the
 * routes may change, these shapes should not.
 */

export const API = {
  quests: "/api/quests",
  runs: "/api/runs",
  photo: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/photo`,
  finish: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/finish`,
  audio: (clipId: string) => `/api/audio/${encodeURIComponent(clipId)}`,
} as const;

/** How many times a player may try again when GPS says they are too far, before the stop is skipped. */
export const PHOTO_RETRIES = 2;
/** The longest side of the photo the phone sends; it is re-encoded as JPEG, which drops EXIF. */
export const PHOTO_MAX_PX = 1024;
/** Upload limit for one photo. */
export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const PHOTO_TYPE = "image/jpeg";

// ---------------------------------------------------------------------------
// Shared pieces

/** Anything the narrator says: text always, audio when a clip exists (no clip = text only). */
export const SpokenLineSchema = z.object({
  text: z.string(), // shown on screen, always
  clipId: z.string().optional(), // play from API.audio(clipId); absent when voice is off or over budget
});
export type SpokenLine = z.infer<typeof SpokenLineSchema>;

/** A fact as the player sees it, with where it came from. */
export const CitedFactSchema = z.object({
  id: FactIdSchema, // F1…Fn
  text: z.string(), // the fact as fetched
  source: FactSourceSchema, // Google Maps or Google Search via SerpApi, or Wikipedia
  sourceTitle: z.string(), // the page or result title, for the link label
  query: z.string(), // the exact query that found it
  url: z.url(), // the link
});
export type CitedFact = z.infer<typeof CitedFactSchema>;

/** A line that states facts, with the facts it cites. */
export const CitedSpokenLineSchema = z.object({
  line: SpokenLineSchema, // what the narrator says
  facts: z.array(CitedFactSchema), // the facts behind it, each with its link
});
export type CitedSpokenLine = z.infer<typeof CitedSpokenLineSchema>;

/** The prompt for the stop the player is walking to. The place name stays hidden until the reveal. */
export const StopPromptSchema = z.object({
  placeId: PlaceIdSchema, // send back as placeId with the photo
  stop: z.number().int().positive(), // 1-based stop number on this walk
  of: StopsPerRunSchema, // how many stops the walk has
  isFork: z.boolean(), // true: the detail the player photographs picks the next stop
  clue: SpokenLineSchema, // how to find the place (said before "Lock your phone. Go.")
  look: SpokenLineSchema, // said after "I'm here"; at a fork it hints at the choices
});
export type StopPrompt = z.infer<typeof StopPromptSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(), // a plain sentence the UI can show
  code: z.string().optional(), // e.g. "over-cap", "not-found", "bad-request"
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// POST /api/quests

export const CreateQuestRequestSchema = z.object({
  lat: z.number().min(-90).max(90), // where the player stands
  lng: z.number().min(-180).max(180),
  minutes: z.union([z.literal(15), z.literal(25)]), // 15 = 3 stops, 25 = 4 stops
  lang: LangSchema.default("en"),
});
export type CreateQuestRequest = z.input<typeof CreateQuestRequestSchema>;

export const CreateQuestResponseSchema = z.object({
  questId: z.string(), // pass to POST /api/runs
  reused: z.boolean(), // true: a saved quest within ~500 m was reused (no new research)
  overCap: z.boolean().optional(), // true: today's quest cap was hit, so the nearest saved quest is offered
});
export type CreateQuestResponse = z.infer<typeof CreateQuestResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/runs

export const StartRunRequestSchema = z.object({
  questId: z.string().min(1), // from POST /api/quests, or a desk demo quest ID
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({
  runId: z.string(), // used in the photo and finish routes
  questId: z.string(),
  title: z.string(), // the quest's title
  mystery: z.string(), // the mystery question, shown under the briefing
  briefing: SpokenLineSchema, // the narrator's setup, played over the ambience
  first: StopPromptSchema, // the first clue and look line
  preload: z.array(z.string()), // every clip ID of this run: fetch them all now (Cache Storage)
  ambienceClipId: z.string().optional(), // plays under the briefing and clues only, never while walking
  stingers: z.object({
    found: z.string().optional(), // clip ID played when a stop passes
    notHere: z.string().optional(), // clip ID played on "too far"
  }),
  voice: z.boolean(), // false: no audio this run (voice off or over the daily cap), text only
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/runs/[runId]/photo (multipart/form-data)

const optionalNumber = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(min).max(max).optional(),
  );

/** The form fields next to the `image` file. GPS is optional (denied, or the desk demo). */
export const PhotoFieldsSchema = z
  .object({
    placeId: PlaceIdSchema, // the stop the photo is for (StopPrompt.placeId)
    lat: optionalNumber(-90, 90), // one GPS reading, taken with the photo
    lng: optionalNumber(-180, 180),
    accuracy: optionalNumber(0, 100_000), // metres, as the browser reports it
    sampleId: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()), // a desk demo sample photo: lets the server fall back to its stored result
  })
  .refine((f) => (f.lat === undefined) === (f.lng === undefined), {
    message: "send lat and lng together, or neither",
  });
export type PhotoFields = z.infer<typeof PhotoFieldsSchema>;

export type PhotoForm = { image: Blob; fields: PhotoFields };

/** Parse the photo form: a JPEG `image` (≤ PHOTO_MAX_BYTES) plus PhotoFields. */
export function parsePhotoForm(form: FormData): { ok: true; value: PhotoForm } | { ok: false; error: string } {
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size === 0) return { ok: false, error: "The photo is missing." };
  if (image.type !== PHOTO_TYPE) return { ok: false, error: "The photo must be a JPEG, re-encoded on the phone." };
  if (image.size > PHOTO_MAX_BYTES) return { ok: false, error: "The photo is too large; resize it to 1024 px first." };
  const fields = PhotoFieldsSchema.safeParse({
    placeId: form.get("placeId") ?? undefined,
    lat: form.get("lat") ?? undefined,
    lng: form.get("lng") ?? undefined,
    accuracy: form.get("accuracy") ?? undefined,
    sampleId: form.get("sampleId") ?? undefined,
  });
  if (!fields.success) return { ok: false, error: fields.error.issues.map((i) => i.message).join("; ") };
  return { ok: true, value: { image, fields: fields.data } };
}

/** What the photo reader saw, as shown to the player. */
export const VerdictViewSchema = z.object({
  observed: z.string(), // the detail Gemma saw, in one line
  cue: CueSchema.nullable(), // the cue it matched at a fork, or null
  plausible: z.boolean(), // plausibly a photo taken here
  confidence: z.number().min(0).max(1),
  source: z.enum(["live", "stored"]), // stored = the desk demo's saved result (live model failed or was rate-limited)
});
export type VerdictView = z.infer<typeof VerdictViewSchema>;

/** The way on to the next stop. */
export const NextStopSchema = z.object({
  bridge: CitedSpokenLineSchema, // names the detail and says why it leads there, with the link's facts
  chosenBy: z.enum(["cue", "meaning", "nearest", "only-link"]), // how the next stop was picked
  stop: StopPromptSchema, // the next clue and look line
});
export type NextStop = z.infer<typeof NextStopSchema>;

/** The case file at the end of a walk. */
export const CaseFileSchema = z.object({
  mystery: z.object({ question: z.string(), answer: z.string() }), // the case and its solution
  route: z.array(
    z.object({
      placeId: PlaceIdSchema,
      name: z.string(), // the place's name
      status: z.enum(["passed", "skipped"]),
      observed: z.string().nullable(), // the detail the player chose here, as Gemma saw it
      cue: CueSchema.nullable(), // the cue that picked the next stop (forks only)
    }),
  ),
  notTaken: z.array(ForkChoiceSchema), // per fork: the link taken and the others, with place, cue and reason
  facts: z.array(CitedFactSchema), // every fact of the quest, with source, query and link
});
export type CaseFile = z.infer<typeof CaseFileSchema>;

/** The end of the walk, at the answer place. */
export const RunEndSchema = z.object({
  finale: CitedSpokenLineSchema, // the narrator solves the mystery, citing facts
  caseFile: CaseFileSchema,
});
export type RunEnd = z.infer<typeof RunEndSchema>;

/** Said when GPS puts the player too far from the place. */
export const HintSchema = z.object({
  line: SpokenLineSchema, // the place's hint, with landmark directions
  distanceM: z.number().nonnegative(), // straight-line distance to the place, shown on screen
  direction: z.enum(COMPASS_8), // compass direction to the place, shown on screen
});
export type Hint = z.infer<typeof HintSchema>;

const placeRef = {
  placeId: PlaceIdSchema, // the stop this result is for
  name: z.string(), // the place's name (revealed once the stop is done)
};

/** The stop passed (GPS near, or GPS missing and the photo plausible): reveal, then next stop or end. */
export const PassedResultSchema = z.object({
  status: z.literal("passed"),
  ...placeRef,
  verdict: VerdictViewSchema.nullable(), // null if the reader failed; GPS alone still passes
  reveal: CitedSpokenLineSchema, // the fact earned here, with its links
  next: NextStopSchema.nullable(), // set unless this was the answer place
  end: RunEndSchema.nullable(), // set at the answer place
});

/** Out of retries: the stop is skipped and the walk moves on (the reveal is still told). */
export const SkippedResultSchema = PassedResultSchema.extend({ status: z.literal("skipped") });

/** GPS puts the player too far away. No model call. */
export const TooFarResultSchema = z.object({
  status: z.literal("too-far"),
  placeId: PlaceIdSchema,
  hint: HintSchema,
  retriesLeft: z.number().int().nonnegative(), // 0: the next miss skips the stop
});

/** GPS missing and the photo not plausible (a screen, indoors): try another photo. */
export const NeedsRetryResultSchema = z.object({
  status: z.literal("needs-retry"),
  placeId: PlaceIdSchema,
  verdict: VerdictViewSchema, // what the reader saw, so the player knows why
  message: SpokenLineSchema, // what to try instead
  retriesLeft: z.number().int().nonnegative(),
});

export const PhotoResultSchema = z
  .discriminatedUnion("status", [
    PassedResultSchema,
    SkippedResultSchema,
    TooFarResultSchema,
    NeedsRetryResultSchema,
  ])
  .refine((r) => !("next" in r) || (r.next === null) !== (r.end === null), {
    message: "a passed or skipped result has either next or end, not both",
  });
export type PhotoResult = z.infer<typeof PhotoResultSchema>;
export type PhotoStatus = PhotoResult["status"];

// ---------------------------------------------------------------------------
// POST /api/runs/[runId]/finish

/** The screen-time receipt, measured on the phone. */
export const ReceiptSchema = z.object({
  screenOnMs: z.number().int().nonnegative(), // time the page was visible
  pocketMs: z.number().int().nonnegative(), // time the page was hidden (phone locked or in a pocket)
  peeks: z.number().int().nonnegative(), // unlocks without a photo within 20 s, and clue replays
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const FinishRequestSchema = z.object({ receipt: ReceiptSchema });
export type FinishRequest = z.infer<typeof FinishRequestSchema>;

export const FinishResponseSchema = z.object({
  runId: z.string(),
  stopsFound: z.number().int().nonnegative(), // stops passed (not skipped)
  score: z.number(), // points per stop, minus peeks, plus a low screen-on bonus
  screenOnShare: z.number().min(0).max(1), // screenOnMs / (screenOnMs + pocketMs)
  receipt: ReceiptSchema, // as saved
});
export type FinishResponse = z.infer<typeof FinishResponseSchema>;
