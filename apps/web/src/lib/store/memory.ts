import type { Attempt, PathStep, Quest, Run } from "@/quest/schema";
import { CACHE_TTL_S } from "../db";
import { distanceM } from "../geo";
import { assertAmount, newId, prepareQuest } from "./shared";
import type {
  Clip,
  CounterTake,
  NearQuest,
  NewClip,
  QuestFilter,
  RunFinish,
  StartRunInput,
  Store,
  StoredAttempt,
  StoredQuest,
} from "./types";

/**
 * The in-memory store: same behaviour as the MongoDB store, nothing survives a restart.
 * Used when MONGODB_URI is not set, and by unit tests (`createMemoryStore()` per test).
 * Every value is copied in and out, so callers cannot change stored data by accident.
 */
export function createMemoryStore(opts: { now?: () => Date } = {}): Store {
  const now = opts.now ?? (() => new Date());
  const quests = new Map<string, StoredQuest>();
  const attempts: StoredAttempt[] = [];
  const runs = new Map<string, Run>();
  const clips = new Map<string, Clip>();
  const cache = new Map<string, { source: string; payload: unknown; createdAt: number }>();
  const counters = new Map<string, number>();

  const copy = structuredClone;

  return {
    kind: "memory",

    async saveQuest(input: Quest) {
      const quest = prepareQuest(input, now());
      quests.set(quest.id, copy(quest));
      return copy(quest);
    },

    async getQuest(id) {
      const q = quests.get(id);
      return q ? copy(q) : null;
    },

    async questsNear(lat, lng, km, filter: QuestFilter = {}) {
      const { lang, minutes, status = "ready", limit = 10 } = filter;
      const maxM = km * 1000;
      const found: NearQuest[] = [];
      for (const q of quests.values()) {
        if (status !== "any" && q.status !== status) continue;
        if (lang && q.lang !== lang) continue;
        if (minutes !== undefined && q.minutes !== minutes) continue;
        const d = distanceM({ lat, lng }, q.center);
        if (d <= maxM) found.push({ quest: copy(q), distanceM: d });
      }
      return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
    },

    async saveAttempt(attempt: Attempt) {
      const stored = { ...copy(attempt), id: newId() };
      attempts.push(stored);
      return copy(stored);
    },

    async attemptsFor(runId, placeId) {
      return attempts
        .filter((a) => a.runId === runId && (placeId === undefined || a.placeId === placeId))
        .map((a) => copy(a));
    },

    async startRun(input: StartRunInput) {
      const run: Run = {
        id: input.id ?? newId(),
        questId: input.questId,
        path: [],
        startedAt: (input.startedAt ?? now()).toISOString(),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        ...(input.voice ? { voice: structuredClone(input.voice) } : {}),
      };
      if (runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
      runs.set(run.id, run);
      return copy(run);
    },

    async getRun(id) {
      const r = runs.get(id);
      return r ? copy(r) : null;
    },

    async appendToPath(runId, step: PathStep) {
      const run = runs.get(runId);
      if (!run) return null;
      if (!run.path.some((s) => s.placeId === step.placeId)) run.path.push(copy(step));
      return copy(run);
    },

    async finishRun(runId, finish: RunFinish) {
      const run = runs.get(runId);
      if (!run) return null;
      if (!run.finishedAt) {
        const { finishedAt, ...rest } = finish;
        Object.assign(run, rest, { finishedAt: (finishedAt ?? now()).toISOString() });
      }
      return copy(run);
    },

    async getClip(id) {
      const c = clips.get(id);
      return c ? copy(c) : null;
    },

    async putClip(clip: NewClip) {
      clips.set(clip.id, { ...copy(clip), createdAt: now().toISOString() });
    },

    async cacheGet<T>(key: string) {
      const hit = cache.get(key);
      if (!hit) return null;
      if (now().getTime() - hit.createdAt > CACHE_TTL_S * 1000) {
        cache.delete(key);
        return null;
      }
      return copy(hit.payload) as T;
    },

    async cacheSet(key, source, payload) {
      cache.set(key, { source, payload: copy(payload), createdAt: now().getTime() });
    },

    // Synchronous between the read and the write, so atomic within this process.
    async counterTake(key, amount, cap): Promise<CounterTake> {
      assertAmount(amount);
      const used = counters.get(key) ?? 0;
      if (used + amount > cap) return { ok: false, used };
      counters.set(key, used + amount);
      return { ok: true, used: used + amount };
    },

    async counterUsed(key) {
      return counters.get(key) ?? 0;
    },

    async close() {},
  };
}
