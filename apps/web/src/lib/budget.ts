import type { Lang } from "@/quest/schema";
import { getStore, type NearQuest, type Store } from "./store";

/**
 * The budget guard: daily caps on paid calls, and reuse of saved quests near a player.
 *
 * Call `budgetTake` before the call it pays for. Over a cap it refuses, and the caller
 * makes no SerpApi or ElevenLabs request: "generate near me" offers the nearest saved
 * quest, and lines show as text.
 */

export const BUDGET_SERVICES = ["quests", "serpapi", "tts-chars"] as const;
export type BudgetService = (typeof BUDGET_SERVICES)[number];

/** Daily caps when the environment does not set them. */
export const BUDGET_DEFAULTS: Record<BudgetService, number> = {
  quests: 3, // new quests per day
  serpapi: 40, // SerpApi searches per day
  "tts-chars": 4000, // ElevenLabs characters per day
};

export const BUDGET_ENV: Record<BudgetService, string> = {
  quests: "BUDGET_QUESTS_PER_DAY",
  serpapi: "BUDGET_SERPAPI_PER_DAY",
  "tts-chars": "BUDGET_TTS_CHARS_PER_DAY",
};

/** Today's cap for a service: its environment variable (a whole number ≥ 0), else the default. */
export function budgetCap(service: BudgetService, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BUDGET_ENV[service]]?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return BUDGET_DEFAULTS[service];
}

/** The UTC day, yyyy-mm-dd. Caps reset at 00:00 UTC. */
export function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The counter's id: "<yyyy-mm-dd>:<service>". */
export function budgetKey(service: BudgetService, now: Date = new Date()): string {
  return `${dayKey(now)}:${service}`;
}

export type BudgetResult = {
  ok: boolean; // false: over the cap, nothing was taken
  service: BudgetService;
  used: number; // today's total after this take (or as it stands, when refused)
  cap: number;
  left: number;
};

type BudgetOpts = { store?: Store; now?: Date; env?: NodeJS.ProcessEnv };

/**
 * Takes `amount` from today's budget for `service`, atomically. Refuses (ok: false, nothing
 * taken) when the take would pass the cap; concurrent requests can never take more than the cap.
 */
export async function budgetTake(service: BudgetService, amount = 1, opts: BudgetOpts = {}): Promise<BudgetResult> {
  const store = opts.store ?? getStore();
  const cap = budgetCap(service, opts.env);
  const { ok, used } = await store.counterTake(budgetKey(service, opts.now), amount, cap);
  return { ok, service, used, cap, left: Math.max(0, cap - used) };
}

/** Today's use of a service, without taking anything. */
export async function budgetStatus(service: BudgetService, opts: BudgetOpts = {}): Promise<Omit<BudgetResult, "ok">> {
  const store = opts.store ?? getStore();
  const cap = budgetCap(service, opts.env);
  const used = await store.counterUsed(budgetKey(service, opts.now));
  return { service, used, cap, left: Math.max(0, cap - used) };
}

// ---------------------------------------------------------------------------
// Reuse

/** A saved quest this close to the player is reused instead of generating a new one. */
export const REUSE_RADIUS_KM = 0.5;

/** The nearest ready quest within ~500 m with the same language and length, or null. */
export async function findReusableQuest(
  lat: number,
  lng: number,
  want: { lang: Lang; minutes: number },
  opts: { store?: Store } = {},
): Promise<NearQuest | null> {
  const store = opts.store ?? getStore();
  const [hit] = await store.questsNear(lat, lng, REUSE_RADIUS_KM, { ...want, status: "ready", limit: 1 });
  return hit ?? null;
}

/** How far a saved quest offered over today's cap may be: a short ride away, never another city. */
export const OVER_CAP_RADIUS_KM = 3;

/**
 * Offered when today's quest cap is hit: the nearest ready quest within ~3 km in the player's
 * language, of the same length when one exists (else the nearest of the other length), or null.
 */
export async function nearestSavedQuest(
  lat: number,
  lng: number,
  want: { lang: Lang; minutes: number },
  opts: { store?: Store } = {},
): Promise<NearQuest | null> {
  const store = opts.store ?? getStore();
  const filter = { lang: want.lang, status: "ready" as const, limit: 1 };
  const [same] = await store.questsNear(lat, lng, OVER_CAP_RADIUS_KM, { ...filter, minutes: want.minutes });
  if (same) return same;
  const [other] = await store.questsNear(lat, lng, OVER_CAP_RADIUS_KM, filter);
  return other ?? null;
}
