import { budgetTake, findReusableQuest, nearestSavedQuest } from "@/lib/budget";
import { roundCenter } from "@/lib/geo";
import type { Store } from "@/lib/store";
import { setTraceTags, withSpan } from "@/lib/trace";
import { type ApiError, CreateQuestRequestSchema, type CreateQuestResponse } from "./api";
import type { GenerateInput, GenerateOutput } from "./generate";

/**
 * POST /api/quests, without the HTTP layer: input check → reuse a saved quest within ~500 m →
 * daily quest cap → the generate-quest workflow. Over the cap no SerpApi or model call is made,
 * and the nearest saved quest is offered instead.
 */

export type CreateQuestResult = { status: number; body: CreateQuestResponse | ApiError };

/** Runs the generate-quest workflow. Its errors come back as a failed run, not as a throw. */
export type RunGeneration = (input: GenerateInput) => Promise<
  { ok: true; output: GenerateOutput } | { ok: false; message: string; code?: string }
>;

export type CreateQuestDeps = {
  generate: RunGeneration;
  store?: Store;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

/** Generations in progress, by rounded centre + length + language: a second request waits for the first. */
const inFlight = new Map<string, Promise<CreateQuestResult>>();

const error = (status: number, message: string, code: string): CreateQuestResult => ({
  status,
  body: { error: message, code },
});

export async function createQuest(raw: unknown, deps: CreateQuestDeps): Promise<CreateQuestResult> {
  const parsed = CreateQuestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return error(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "bad-request");
  }
  const req = parsed.data;
  const store = deps.store;

  // 1. Reuse: a saved quest this close costs nothing.
  const near = await findReusableQuest(req.lat, req.lng, { lang: req.lang, minutes: req.minutes }, { store });
  if (near) {
    return { status: 200, body: { questId: near.quest.id, reused: true, distanceM: Math.round(near.distanceM) } };
  }

  const c = roundCenter(req);
  const key = `${c.lat},${c.lng}:${req.minutes}:${req.lang}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<CreateQuestResult> => {
    // 2. The daily cap on new quests. Taken before research and kept when the generation fails
    // (few places, writer failed): research and the writer have spent by then, so the cap also
    // bounds what failed tries cost. The SerpApi daily cap limits the searches themselves.
    const budget = await budgetTake("quests", 1, { store, env: deps.env, now: deps.now });
    if (!budget.ok) {
      const nearest = await nearestSavedQuest(req.lat, req.lng, { lang: req.lang, minutes: req.minutes }, { store });
      if (nearest) {
        return {
          status: 200,
          body: { questId: nearest.quest.id, reused: true, overCap: true, distanceM: Math.round(nearest.distanceM) },
        };
      }
      return error(429, "Today's limit of new quests is used up, and no saved quest is near here. Try the desk demo.", "over-cap");
    }

    // 3. Generate. The workflow gets the centre rounded to ~100 m: its input is stored with the
    // run (Mastra snapshots and traces), and the server never keeps where the player stood.
    const result = await deps.generate({
      lat: c.lat,
      lng: c.lng,
      minutes: req.minutes,
      lang: req.lang,
      ...(req.timeZone ? { timeZone: req.timeZone } : {}),
    });
    if (!result.ok) {
      if (result.code === "few-places") return error(422, result.message, "few-places");
      return error(503, "The quest writer did not answer in time. Please try again in a minute, or try the desk demo.", "writer-failed");
    }
    const out = result.output;
    if (out.status !== "ready" || !out.questId) {
      return error(502, "Gemma's quest did not pass the checks. Please try again, or try the desk demo.", "invalid-quest");
    }
    setTraceTags({ questId: out.questId });
    return { status: 200, body: { questId: out.questId, reused: false } };
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/** Runs the workflow inside a span tagged as the writer, so each generation is one trace. */
export function tracedGeneration(run: RunGeneration): RunGeneration {
  return (input) => withSpan("quest.generate", { role: "writer" }, () => run(input));
}
