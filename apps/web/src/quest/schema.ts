import { z } from "zod";

/**
 * The quest's data shapes. Every later module imports its types from here.
 *
 * Two layers:
 * - `WriterOutput` is what Gemma returns: text and links that cite fact and place IDs.
 *   It never carries coordinates or links to pages; those come from fetched data.
 * - `Quest` is a validated quest (see `validate.ts`): the writer's text merged with the
 *   fetched facts and candidate places.
 */

// ---------------------------------------------------------------------------
// Building blocks

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** Fact IDs are F1…Fn, place IDs P1…Pn (assigned by the research step, never by the model). */
export const FactIdSchema = z.string().regex(/^F\d+$/, "a fact ID looks like F3");
export const PlaceIdSchema = z.string().regex(/^P\d+$/, "a place ID looks like P2");

export const LangSchema = z.enum(["en", "tr"]);
export type Lang = z.infer<typeof LangSchema>;

/**
 * The cue list: visual categories the photo reader can tell apart. Each fork link carries one,
 * and the cue of the detail the player photographs picks the next stop.
 */
export const CUES = [
  "writing", // inscriptions, signs, calligraphy
  "date-or-number",
  "water", // fountains, taps, the sea
  "animal-or-figure", // carvings, statues
  "plant-or-tree",
  "symbol-or-emblem", // tughras, crests
  "door-window-arch",
  "material", // tile, marble, wood, iron
] as const;
export const CueSchema = z.enum(CUES);
export type Cue = z.infer<typeof CueSchema>;

export const FactSourceSchema = z.enum(["serpapi-maps", "serpapi-search", "wikipedia"]);
export type FactSource = z.infer<typeof FactSourceSchema>;

/** A fact fetched from a source. The game states a fact only if it is one of these. */
export const FactSchema = z.object({
  id: FactIdSchema,
  text: z.string().min(1),
  sourceUrl: z.url(),
  sourceTitle: z.string().min(1),
  query: z.string().min(1), // the exact search or page lookup that found it
  source: FactSourceSchema,
  placeId: PlaceIdSchema.optional(), // the candidate place the fact is about, if any
});
export type Fact = z.infer<typeof FactSchema>;

/** A place the research step found (SerpApi place or Wikipedia page). */
export const CandidateSchema = z.object({
  id: PlaceIdSchema,
  name: z.string().min(1),
  location: LatLngSchema,
  sourceUrl: z.url(),
  gated: z.boolean().optional(), // courtyards, gardens: only used when open at play time
  openNow: z.boolean().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** A line the narrator says. Audio clip IDs are attached when a run starts (voice step). */
export const LineSchema = z.object({ text: z.string().min(1) });
export type Line = z.infer<typeof LineSchema>;

/** A line that states facts: it must cite them. */
export const CitedLineSchema = z.object({
  text: z.string().min(1),
  factIds: z.array(FactIdSchema).min(1),
});
export type CitedLine = z.infer<typeof CitedLineSchema>;

// ---------------------------------------------------------------------------
// Quest

/**
 * A way out of a place. At a fork: 2–3 links, each with a different cue.
 * The stop before the answer: one link, to the answer, no cue. The answer: no links.
 */
export const LinkSchema = z.object({
  to: PlaceIdSchema,
  cue: CueSchema.optional(),
  reason: z.string().min(1), // why this detail leads there; the bridge line is built from it
  factIds: z.array(FactIdSchema).min(1),
});
export type Link = z.infer<typeof LinkSchema>;

export const PlaceSchema = z.object({
  id: PlaceIdSchema,
  name: z.string().min(1),
  location: LatLngSchema,
  sourceUrl: z.url(),
  gated: z.boolean().optional(),
  openNow: z.boolean().optional(),
  clue: LineSchema, // how to find the place: something visible, landmark directions
  look: LineSchema, // the prompt at the place; at a fork it hints at the choices
  hint: LineSchema, // said when the player is too far away
  reveal: CitedLineSchema, // the fact the player earns here
  links: z.array(LinkSchema),
});
export type Place = z.infer<typeof PlaceSchema>;

export const StopsPerRunSchema = z.union([z.literal(3), z.literal(4)]);
export type StopsPerRun = z.infer<typeof StopsPerRunSchema>;

export const MysterySchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  factIds: z.array(FactIdSchema).min(1), // at least one fact of the answer place
});
export type Mystery = z.infer<typeof MysterySchema>;

/** Whether the writer's first draft passed, and what the repair fixed (evals report the rate). */
export const ValidationRecordSchema = z.object({
  firstTryOk: z.boolean(),
  firstTryErrors: z.array(z.string()),
  repaired: z.boolean(),
});
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export const QuestSchema = z.object({
  id: z.string().optional(), // set when the quest is saved
  createdAt: z.iso.datetime().optional(),
  lang: LangSchema,
  minutes: z.number().int().positive(),
  center: LatLngSchema, // rounded to ~100 m before it is stored
  title: z.string().min(1),
  mystery: MysterySchema,
  briefing: LineSchema,
  facts: z.array(FactSchema).min(1), // every fact the quest cites, with source, query and link
  places: z.array(PlaceSchema).min(4).max(6),
  startPlaceId: PlaceIdSchema,
  answerPlaceId: PlaceIdSchema,
  stopsPerRun: StopsPerRunSchema,
  finale: CitedLineSchema,
  validation: ValidationRecordSchema,
  model: z
    .object({ provider: z.string(), writer: z.string(), reader: z.string().optional() })
    .optional(),
  timings: z.object({ researchMs: z.number(), writeMs: z.number() }).partial().optional(),
  serpapiSearches: z.number().int().nonnegative().optional(),
  status: z.enum(["ready", "failed"]),
  demo: z.boolean().optional(),
  editedByHand: z.array(z.string()).optional(), // hand edits, listed so the write-up can say so
});
export type Quest = z.infer<typeof QuestSchema>;

// ---------------------------------------------------------------------------
// What Gemma returns

/**
 * The writer's JSON. Text fields are plain strings (less for a small model to get wrong);
 * cues are plain strings so the validator can name a wrong cue in its repair message.
 * Places refer to candidate IDs; names and coordinates come from the candidates.
 */
export const WriterLinkSchema = z.object({
  to: z.string(),
  cue: z.string().nullish(),
  reason: z.string().min(1),
  factIds: z.array(z.string()),
});
export type WriterLink = z.infer<typeof WriterLinkSchema>;

export const WriterPlaceSchema = z.object({
  id: z.string(),
  clue: z.string().min(1),
  look: z.string().min(1),
  hint: z.string().min(1),
  reveal: z.object({ text: z.string().min(1), factIds: z.array(z.string()) }),
  links: z.array(WriterLinkSchema),
});
export type WriterPlace = z.infer<typeof WriterPlaceSchema>;

export const WriterOutputSchema = z.object({
  title: z.string().min(1),
  mystery: z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
    factIds: z.array(z.string()),
  }),
  briefing: z.string().min(1),
  places: z.array(WriterPlaceSchema).min(1),
  startPlaceId: z.string(),
  answerPlaceId: z.string(),
  finale: z.object({ text: z.string().min(1), factIds: z.array(z.string()) }),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

// ---------------------------------------------------------------------------
// Photo check

/** What the photo reader (Gemma vision) says about one photo. */
export const VerdictSchema = z.object({
  plausible: z.boolean(), // plausibly taken here (not a screen, not indoors at home)
  confidence: z.number().min(0).max(1),
  observed: z.string(), // the detail, in one line
  cue: CueSchema.nullable(), // which of the fork's cues fits the detail, if any
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Said instead of an `observed` line that describes people (or is empty): names nothing. */
export const OBSERVED_FALLBACK = "a detail of the place";

/** The reader's `observed` line, or null when it names nothing usable (missing or the fallback). */
export function usableObserved(observed: string | null | undefined): string | null {
  const t = observed?.trim();
  return t && t !== OBSERVED_FALLBACK ? t : null;
}

// ---------------------------------------------------------------------------
// Runs

/** One fork on a walked path: the link taken and the ones not taken (the case file shows them). */
export const ForkChoiceSchema = z.object({
  at: PlaceIdSchema, // the fork place
  atName: z.string(),
  taken: z.object({ to: PlaceIdSchema, name: z.string(), cue: CueSchema.nullable() }),
  // How the way on was picked (from the path step); "nearest" means the photo did not pick it.
  chosenBy: z.enum(["cue", "meaning", "nearest", "only-link"]).optional(),
  notTaken: z.array(
    z.object({
      to: PlaceIdSchema,
      name: z.string(),
      cue: CueSchema.nullable(),
      reason: z.string(), // "Had you photographed the water, …" is built from this
      factIds: z.array(FactIdSchema),
    }),
  ),
});
export type ForkChoice = z.infer<typeof ForkChoiceSchema>;

export const PathStepSchema = z.object({
  placeId: PlaceIdSchema,
  status: z.enum(["passed", "skipped"]),
  observed: z.string().nullable(), // the detail the reader saw, if it ran
  cue: CueSchema.nullable(), // the cue that picked the next stop, at a fork
  bridge: z.string().nullable(), // the line said on the way to the next stop
  notTaken: z.array(z.object({ to: PlaceIdSchema, cue: CueSchema.nullable() })),
  // Set by the play routes, so a lost response can be sent again without a model call:
  to: PlaceIdSchema.nullable().optional(), // the next stop (null at the answer place)
  chosenBy: z.enum(["cue", "meaning", "nearest", "only-link"]).optional(), // how the next stop was picked
  bridgeFactIds: z.array(FactIdSchema).optional(), // the facts the bridge line cites
  bridgeClipId: z.string().optional(), // the bridge line's audio, when it was voiced
});
export type PathStep = z.infer<typeof PathStepSchema>;

/** A run's voice, fixed when it starts: clip id per quest line key (`briefing`, `P1.clue`, …). */
export const RunVoiceSchema = z.object({
  on: z.boolean(), // false: text only (voice off, no key, or over the daily cap)
  clips: z.record(z.string(), z.string()),
});
export type RunVoice = z.infer<typeof RunVoiceSchema>;

export const RunSchema = z.object({
  id: z.string(),
  questId: z.string(),
  path: z.array(PathStepSchema),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  screenOnMs: z.number().nonnegative().optional(),
  pocketMs: z.number().nonnegative().optional(),
  peeks: z.number().int().nonnegative().optional(),
  stopsFound: z.number().int().nonnegative().optional(),
  score: z.number().optional(),
  userAgent: z.string().optional(),
  voice: RunVoiceSchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;

/** One photo attempt. The photo itself is never stored. */
export const AttemptSchema = z.object({
  questId: z.string(),
  runId: z.string(),
  placeId: PlaceIdSchema,
  at: z.iso.datetime(),
  distanceM: z.number().nullable(), // null when GPS is missing
  accuracyM: z.number().nullable(),
  verdict: VerdictSchema.nullable(), // null when presence failed and the reader did not run
  passed: z.boolean(),
  provider: z.string().nullable(),
  latencyMs: z.number().nullable(),
  storedVerdict: z.boolean().optional(), // the desk demo's stored result was used
});
export type Attempt = z.infer<typeof AttemptSchema>;
