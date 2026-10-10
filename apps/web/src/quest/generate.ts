import { z } from "zod";
import { roundCenter } from "@/lib/geo";
import { getStore, type Store } from "@/lib/store";
import { research as runResearch, type ResearchInput, type ResearchResult } from "@/research";
import { repairPrompt, writeDraft, writerPrompt, type WriterCall } from "@/mastra/agents/writer";
import { QUEST_DEADLINE_MS } from "./api";
import { routeOptions } from "./plan";
import {
  CandidateSchema,
  FactSchema,
  LangSchema,
  LatLngSchema,
  type Quest,
  StopsPerRunSchema,
  ValidationRecordSchema,
} from "./schema";
import { LIMITS, validateQuest } from "./validate";

/**
 * The steps of the generate-quest workflow (`src/mastra/workflows/generate-quest.ts`), as plain
 * functions: research (code, ≤ 6 SerpApi searches) → write (one Gemma call) → validate (one
 * repair with the error list) → save. No voice here: a quest is voiced when a run starts.
 */

// ---------------------------------------------------------------------------
// Data between the steps

export const GenerateInputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  minutes: z.union([z.literal(15), z.literal(25)]),
  lang: LangSchema.default("en"),
  /** The player's IANA time zone: gated places (courtyards, gardens) are used only when open. */
  timeZone: z.string().max(64).optional(),
  /** The total time for this generation (default QUEST_DEADLINE_MS); scripts on a slow local model raise it. */
  deadlineMs: z.number().int().positive().optional(),
});
export type GenerateInput = z.input<typeof GenerateInputSchema>;

const ResearchCandidateSchema = CandidateSchema.extend({
  distanceM: z.number(),
  types: z.array(z.string()),
  description: z.string().optional(),
  sources: z.array(z.string()),
  altNames: z.array(z.string()),
  factIds: z.array(z.string()),
});

const RouteOptionSchema = z.object({
  stopsPerRun: StopsPerRunSchema,
  start: z.string(),
  firstFork: z.tuple([z.string(), z.string()]),
  secondFork: z.tuple([z.string(), z.string()]).optional(),
  answer: z.string(),
  longestM: z.number(),
  places: z.array(z.string()),
});

const CallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
  latencyMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
});
export type WriterCallLog = z.infer<typeof CallSchema>;

export const ResearchedSchema = z.object({
  center: LatLngSchema, // rounded to ~100 m before anything leaves the server
  minutes: z.union([z.literal(15), z.literal(25)]),
  lang: LangSchema,
  candidates: z.array(ResearchCandidateSchema),
  facts: z.array(FactSchema),
  options: z.array(RouteOptionSchema),
  serpapiSearches: z.number().int().nonnegative(),
  serpapiCacheHits: z.number().int().nonnegative(),
  serpapiOnlyCandidates: z.number().int().nonnegative(),
  researchMs: z.number(),
  warnings: z.array(z.string()),
  /** When the generation must be done (epoch ms): writer calls get what is left. */
  deadlineAt: z.number(),
});
export type Researched = z.infer<typeof ResearchedSchema>;

export const DraftedSchema = ResearchedSchema.extend({
  prompt: z.string(),
  draft: z.unknown(),
  calls: z.array(CallSchema),
});
export type Drafted = z.infer<typeof DraftedSchema>;

export const CheckedSchema = DraftedSchema.omit({ prompt: true, draft: true }).extend({
  ok: z.boolean(),
  /** The validated quest (not saved yet), when ok. */
  quest: z.unknown().optional(),
  validation: ValidationRecordSchema,
  /** The last errors, when the repaired draft failed too. */
  errors: z.array(z.string()),
  /** The writer's raw drafts (first, and the repair if any), for evals and debugging. */
  drafts: z.array(z.unknown()),
});
export type Checked = z.infer<typeof CheckedSchema>;

export const GenerateOutputSchema = z.object({
  status: z.enum(["ready", "failed"]),
  /** Set when the quest was saved. */
  questId: z.string().optional(),
  validation: ValidationRecordSchema,
  errors: z.array(z.string()),
  model: z.object({ provider: z.string(), writer: z.string() }),
  timings: z.object({ researchMs: z.number(), writeMs: z.number() }),
  serpapiSearches: z.number().int().nonnegative(),
  serpapiCacheHits: z.number().int().nonnegative(),
  calls: z.array(CallSchema),
  drafts: z.array(z.unknown()),
  candidates: z.number().int().nonnegative(),
  routeOptions: z.number().int().nonnegative(),
});
export type GenerateOutput = z.infer<typeof GenerateOutputSchema>;

/** Generation stopped before the writer (too few places) or the writer call failed. */
export class GenerateError extends Error {
  override name = "GenerateError";
  constructor(
    message: string,
    readonly code: "few-places" | "writer-failed",
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Dependencies (tests and scripts swap them)

export type GenerateDeps = {
  research: (input: ResearchInput) => Promise<ResearchResult>;
  /** `maxMs`: the time left of the deadline, a cap on the call's own timeout. */
  write: (prompt: string, opts: { maxMs: number }) => Promise<WriterCall>;
  store: () => Store;
};

const DEFAULT_DEPS: GenerateDeps = {
  research: (input) => runResearch(input),
  write: (prompt, opts) => writeDraft(prompt, opts),
  store: () => getStore(),
};

const g = globalThis as typeof globalThis & { __forkingPathsGenerateDeps?: Partial<GenerateDeps> };

/** Swap some of the workflow's dependencies (tests, eval scripts). Undefined restores the defaults. */
export function setGenerateDeps(deps: Partial<GenerateDeps> | undefined): void {
  g.__forkingPathsGenerateDeps = deps;
}

function deps(): GenerateDeps {
  return { ...DEFAULT_DEPS, ...g.__forkingPathsGenerateDeps };
}

// ---------------------------------------------------------------------------
// Steps

/** Candidates asked from research (its default is 8). */
export const RESEARCH_CANDIDATES = 12;

/** Places a quest needs: 4 (3 stops) or 6 (4 stops). */
const MIN_PLACES = { 15: 4, 25: 6 } as const;

/**
 * A repair call starts only with this much of the deadline left: a writer call on the free
 * Google tier took 52–148 s, so a shorter repair would mostly time out after spending the tokens.
 */
export const MIN_REPAIR_MS = 60_000;

export async function researchStep(raw: GenerateInput): Promise<Researched> {
  const input = GenerateInputSchema.parse(raw);
  const deadlineAt = Date.now() + (input.deadlineMs ?? QUEST_DEADLINE_MS);
  // Round first: research, the validator and the stored quest all use the ~100 m centre.
  const center = roundCenter({ lat: input.lat, lng: input.lng });
  const r = await deps().research({
    ...center,
    lang: input.lang,
    minutes: input.minutes,
    // More candidates cost no SerpApi searches (Search runs on the top 4 only) and give the route
    // planner more ways to fit the 250 m hops; the prompt lists only the places of the options.
    maxCandidates: RESEARCH_CANDIDATES,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });
  const factCount = Object.fromEntries(r.candidates.map((c) => [c.id, c.factIds.length]));
  const options = routeOptions(r.candidates, center, input.minutes, { factCount, limit: 4 });
  const out: Researched = {
    center,
    minutes: input.minutes,
    lang: input.lang,
    candidates: r.candidates,
    facts: r.facts,
    options,
    serpapiSearches: r.stats.serpapiSearches,
    serpapiCacheHits: r.stats.serpapiCacheHits,
    serpapiOnlyCandidates: r.stats.serpapiOnlyCandidates,
    researchMs: r.stats.researchMs,
    warnings: r.warnings,
    deadlineAt,
  };
  if (!options.length) {
    const need = MIN_PLACES[input.minutes];
    throw new GenerateError(
      `Not enough places close together here for a ${input.minutes}-minute walk: found ${r.candidates.length} place(s) with facts, ` +
        `and no ${need} of them are close enough (≤ ${LIMITS.maxHopM} m apart) to make the route. Try a busier street or the desk demo.`,
      "few-places",
    );
  }
  return out;
}

function logCall(c: WriterCall): WriterCallLog {
  return {
    provider: c.provider,
    model: c.model,
    thinking: c.thinking,
    latencyMs: c.latencyMs,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    reasoningTokens: c.reasoningTokens,
  };
}

async function write(prompt: string, deadlineAt: number): Promise<WriterCall> {
  const maxMs = deadlineAt - Date.now();
  if (maxMs <= 0) throw new GenerateError("The quest writer failed: no time was left for it.", "writer-failed");
  try {
    return await deps().write(prompt, { maxMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GenerateError(`The quest writer failed: ${reason}`, "writer-failed");
  }
}

export async function writeStep(r: Researched): Promise<Drafted> {
  const prompt = writerPrompt({
    center: r.center,
    minutes: r.minutes,
    lang: r.lang,
    candidates: r.candidates,
    facts: r.facts,
    options: r.options,
  });
  const call = await write(prompt, r.deadlineAt);
  return { ...r, prompt, draft: call.draft, calls: [logCall(call)] };
}

export async function validateStep(d: Drafted): Promise<Checked> {
  const { prompt, draft, ...rest } = d;
  const opts = { center: d.center, minutes: d.minutes, lang: d.lang };
  const first = validateQuest(draft ?? {}, d.facts, d.candidates, opts);
  if (first.ok) {
    return { ...rest, ok: true, quest: first.quest, validation: first.quest.validation, errors: [], drafts: [draft] };
  }
  const firstTryErrors = draft == null ? ["The answer was not a JSON object."] : first.errors;
  // No repair when too little of the deadline is left: the phone would stop waiting first.
  const leftMs = d.deadlineAt - Date.now();
  if (leftMs < MIN_REPAIR_MS) {
    return {
      ...rest,
      ok: false,
      validation: { firstTryOk: false, firstTryErrors, repaired: false },
      errors: [...firstTryErrors, `No repair: ${Math.max(0, Math.round(leftMs / 1000))} s of the time limit were left.`],
      drafts: [draft],
    };
  }
  // One repair with the error list.
  const call = await write(repairPrompt(prompt, draft, firstTryErrors), d.deadlineAt);
  const calls = [...d.calls, logCall(call)];
  const drafts = [draft, call.draft];
  const second = validateQuest(call.draft ?? {}, d.facts, d.candidates, { ...opts, firstTryErrors });
  if (second.ok) {
    return { ...rest, calls, drafts, ok: true, quest: second.quest, validation: second.quest.validation, errors: [] };
  }
  return {
    ...rest,
    calls,
    drafts,
    ok: false,
    validation: { firstTryOk: false, firstTryErrors, repaired: false },
    errors: second.errors,
  };
}

export async function saveStep(c: Checked): Promise<GenerateOutput> {
  const writer = c.calls[c.calls.length - 1];
  const base = {
    validation: c.validation,
    errors: c.errors,
    model: { provider: writer?.provider ?? "unknown", writer: writer?.model ?? "unknown" },
    timings: { researchMs: c.researchMs, writeMs: c.calls.reduce((s, x) => s + x.latencyMs, 0) },
    serpapiSearches: c.serpapiSearches,
    serpapiCacheHits: c.serpapiCacheHits,
    calls: c.calls,
    drafts: c.drafts,
    candidates: c.candidates.length,
    routeOptions: c.options.length,
  };
  if (!c.ok || !c.quest) return { ...base, status: "failed" };
  const quest: Quest = {
    ...(c.quest as Quest),
    center: c.center,
    model: base.model,
    timings: base.timings,
    serpapiSearches: c.serpapiSearches,
  };
  const saved = await deps().store().saveQuest(quest);
  return { ...base, status: "ready", questId: saved.id };
}

/** Research → write → validate → save, without Mastra (unit tests use it; the app runs the workflow). */
export async function generateQuestDirect(input: GenerateInput): Promise<GenerateOutput> {
  return saveStep(await validateStep(await writeStep(await researchStep(input))));
}
