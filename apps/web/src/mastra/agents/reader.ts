import type { LanguageModel } from "ai";
import { z } from "zod";
import { generateJson, type ImageInput, type ModelCallMeta } from "@/lib/json";
import { modelLabel, resolveModelConfig } from "@/lib/model";
import { aiTelemetry, tagRequest, withSpan, type TraceTags } from "@/lib/trace";
import type { MeaningPicker } from "@/quest/fork";
import { CUES, OBSERVED_FALLBACK, type Cue, type Verdict } from "@/quest/schema";

/**
 * The photo reader (Gemma vision). One call per photo: the image, the place's name and, at a
 * fork, the cues of the place's links. Gemma answers which cue fits the detail (or none), what
 * the detail is in one line, and whether the photo was plausibly taken here (not a screen, not a
 * room at home).
 *
 * A plain AI SDK call through `generateJson` (zod check, one repair, backoff, timeout), not a
 * Mastra Agent: the photo goes in as a file part, and Mastra silently swaps an image it cannot
 * decode for text. The call runs in a span marked as carrying an image, so neither the photo nor
 * the prompt and answer reach a trace. The photo is never stored.
 */

/** What each cue covers, in the words the reader sees. */
export const CUE_HINTS: Record<Cue, string> = {
  writing: "inscriptions, carved or painted words, signs, calligraphy, plaques with text",
  "date-or-number": "a date, a year or a number carved, painted or fixed on something",
  water: "a fountain, a spout or tap, a basin, running water, the sea",
  "animal-or-figure": "a carved or cast animal, a statue, a figure",
  "plant-or-tree": "a tree, its trunk or leaves, plants, carved flowers, fruit or trees",
  "symbol-or-emblem": "a tughra (a sultan's signature), a crest, a coat of arms, a monogram, a medallion",
  "door-window-arch": "a door, a gate, a window, an arch, a niche",
  material: "the material itself: tiles, marble, stone, brick, wood, iron work",
};

/** The longest `observed` line kept, in words. */
export const OBSERVED_MAX_WORDS = 15;

/** What the model returns, loosely typed: the cue and confidence are cleaned up in code. */
export const ReaderAnswerSchema = z.object({
  observed: z.string(),
  cue: z.string().nullable(),
  plausible: z.boolean(),
  confidence: z.number(),
});
export type ReaderAnswer = z.infer<typeof ReaderAnswerSchema>;

/**
 * The schema sent to the model for one photo. At a fork, `cue` is an enum of the offered cues
 * (or null), so structured output keeps a small model from answering with a word of the hint
 * ("crest") instead of the cue's name. Away from a fork it is always null.
 */
export function readerAnswerSchema(offered: readonly Cue[]): z.ZodType<ReaderAnswer> {
  // A value outside the enum (from a provider that does not enforce it) becomes null instead of
  // failing validation and costing a repair round trip; the fork then picks by meaning. (A
  // dynamic catch would be nicer, but zod cannot turn one into JSON Schema.)
  const cue = offered.length ? z.enum(offered as [Cue, ...Cue[]]).nullable().catch(null) : z.null().catch(null);
  return ReaderAnswerSchema.extend({ cue });
}

export type ReaderInput = {
  image: ImageInput;
  /** The place the player should be at. */
  placeName: string;
  /** At a fork: the cues of the place's links. Empty or absent elsewhere. */
  cues?: readonly Cue[];
};

/**
 * The reader's prompt. All of it sits in the user message, next to the image: for Gemma,
 * `@ai-sdk/google` folds a system prompt into the first user message anyway.
 */
export function readerPrompt({ placeName, cues = [] }: Omit<ReaderInput, "image">): string {
  const offered = [...new Set(cues)];
  const lines = [
    "You check one photo for a walking game played outdoors in a city.",
    `The player was asked to stand at "${placeName}" and photograph one detail there that they think matters.`,
    "",
  ];
  if (offered.length) {
    lines.push(
      "The detail can be one of these kinds (cues):",
      ...offered.map((cue) => `- ${cue}: ${CUE_HINTS[cue]}`),
      "",
    );
  }
  lines.push(
    "Answer with one JSON object:",
    `- "observed": the main detail in the photo, in at most ${OBSERVED_MAX_WORDS} words. Be concrete: what it is, its material or colour. Describe only things and places, never people.`,
    offered.length
      ? `- "cue": the name of the one cue from the list above that best fits that detail (write the name exactly, e.g. "${offered[0]}"). Use null only when the detail fits none of them.`
      : `- "cue": null.`,
    `- "plausible": true if this looks like a real photo taken outdoors at or near ${placeName} (a street, a building, a monument or its detail). false if it shows a screen, a printed picture, or a room inside a home.`,
    `- "confidence": a number from 0 to 1, how sure you are about "plausible".`,
    "",
    'Example: {"observed": "carved marble panel with a gilded inscription", "cue": "writing", "plausible": true, "confidence": 0.9}',
  );
  return lines.join("\n");
}

const PEOPLE =
  /\b(?:man|men|woman|women|person|people|persons|child|children|kid|kids|boy|boys|girl|girls|baby|face|faces|crowd|tourists?|pedestrians?|someone|somebody|selfie|he|she|his|her|him|their|they)\b/i;

/** True when a line describes people (the reader is told not to; this is the backstop). */
export function mentionsPeople(text: string): boolean {
  return PEOPLE.test(text);
}

export { OBSERVED_FALLBACK };

/** Match the model's cue to one of the offered cues ("Water", "door/window/arch" → the cue). */
export function matchCue(raw: string | null | undefined, offered: readonly Cue[]): Cue | null {
  if (!raw) return null;
  const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const k = key(raw);
  if (!k || k === "null" || k === "none") return null;
  return offered.find((cue) => key(cue) === k) ?? null;
}

function shorten(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const kept = words.slice(0, maxWords).join(" ");
  return kept.replace(/[\s,;:–-]+$/, "").replace(/\.$/, "");
}

/**
 * The reader's answer as a Verdict: cue limited to the offered cues, confidence clamped to
 * 0..1, observed cut to 15 words, and never a line about people.
 */
export function toVerdict(answer: ReaderAnswer, offered: readonly Cue[]): Verdict {
  const raw = answer.confidence;
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  // A model that answers on a 0..100 scale: 85 means 0.85. Only whole numbers from 2 to 100
  // count as percentages; a slip such as 1.2 is clamped to 1, not read as 1.2 %.
  const scaled = Number.isInteger(raw) && raw >= 2 && raw <= 100 ? raw / 100 : confidence;
  let observed = shorten(answer.observed, OBSERVED_MAX_WORDS);
  if (!observed || mentionsPeople(observed)) observed = OBSERVED_FALLBACK;
  return {
    plausible: answer.plausible,
    confidence: Math.round(scaled * 100) / 100,
    observed,
    cue: matchCue(answer.cue, offered),
  };
}

export type ReadOptions = {
  /** Trace tags (quest, run, place). Role, provider and model are added here. */
  tags?: TraceTags;
  signal?: AbortSignal;
  /** Per-attempt timeout; default: the reader role's timeout for its provider. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Test seam: a mock model. */
  model?: LanguageModel;
  sleep?: (ms: number) => Promise<void>;
};

export type ReadResult = { verdict: Verdict; meta: ModelCallMeta; raw: ReaderAnswer };

function spanTags(role: "reader", env: Record<string, string | undefined> | undefined, tags: TraceTags = {}): TraceTags {
  const config = resolveModelConfig(role, env ?? process.env);
  return { ...tags, role, provider: config.provider, model: config.modelId };
}

/** The reader's span tags plus `checkedBy` (`ollama/gemma4:e4b`): only the photo read sets it. */
export function photoCheckTags(env: Record<string, string | undefined> | undefined, tags: TraceTags = {}): TraceTags {
  const t = spanTags("reader", env, tags);
  return { ...t, checkedBy: `${t.provider}/${t.model}` };
}

/** Read one photo. Throws `ModelCallError` / `ModelOutputError` (from `generateJson`) on failure. */
export async function readPhoto(input: ReaderInput, options: ReadOptions = {}): Promise<ReadResult> {
  const offered = [...new Set(input.cues ?? [])].filter((c) => (CUES as readonly string[]).includes(c));
  const tags = photoCheckTags(options.env, options.tags);
  // Where the photo went: google (AI Studio) or ollama (the owner's machine), on every span of the
  // request and as tags of its transaction, so traces can be filtered by where photos were read.
  tagRequest({ "photo_check.provider": tags.provider, "photo_check.model": tags.model });
  return withSpan(
    "photo.read",
    tags,
    async () => {
      const { data, meta } = await generateJson("reader", readerAnswerSchema(offered), readerPrompt({ ...input, cues: offered }), [input.image], {
        env: options.env,
        model: options.model,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        sleep: options.sleep,
        maxOutputTokens: 300,
        temperature: 0,
        telemetry: aiTelemetry("reader", { image: true }),
      });
      return { verdict: toVerdict(data, offered), meta, raw: data };
    },
    { op: "gen_ai.photo_check", image: true },
  );
}

// ---------------------------------------------------------------------------
// The meaning pick: no cue matched, so Gemma picks the closest link by meaning (text only).

export const MeaningAnswerSchema = z.object({ to: z.string().nullable() });

export function meaningPrompt(input: Parameters<MeaningPicker>[0]): string {
  return [
    "You help a walking game choose the next stop.",
    `At ${input.place.name}, the player photographed this detail: "${input.observed}".`,
    "Each way on starts from a different kind of detail. Pick the one whose detail and reason is closest in meaning to what the player photographed.",
    "",
    ...input.links.map((l) => `- ${l.to}: detail "${l.cue ?? "any"}" (${l.cue ? CUE_HINTS[l.cue] : "any detail"}); reason: ${l.reason}`),
    "",
    `Answer with JSON only: {"to": "<one of ${input.links.map((l) => l.to).join(", ")}>"}, or {"to": null} if none is close.`,
  ].join("\n");
}

/** A meaning picker backed by Gemma (reader role, text only). Errors propagate to `pickNext`. */
export function gemmaMeaningPicker(options: Omit<ReadOptions, "sleep"> = {}): MeaningPicker {
  return async (input) =>
    withSpan("fork.meaning", spanTags("reader", options.env, options.tags), async () => {
      const { data } = await generateJson("reader", MeaningAnswerSchema, meaningPrompt(input), undefined, {
        env: options.env,
        model: options.model,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxOutputTokens: 60,
        temperature: 0,
        telemetry: aiTelemetry("reader"),
      });
      const to = data.to?.trim().toUpperCase() ?? null;
      return to && /^P\d+$/.test(to) ? to : null;
    });
}

/** `google/gemma-4-26b-a4b-it`: the reader's model label for logs and the attempt record. */
export function readerLabel(env?: Record<string, string | undefined>): string {
  return modelLabel(resolveModelConfig("reader", env ?? process.env));
}
