import type { Attempt, PathStep, Quest } from "@/quest/schema";
import { dbName } from "../db";
import { createMemoryStore } from "./memory";
import { createMongoStore } from "./mongo";
import type { NewClip, QuestFilter, RunFinish, StartRunInput, Store } from "./types";

export type * from "./types";
export { cacheKey, citationErrors } from "./shared";
export { createMemoryStore } from "./memory";
export { createMongoStore } from "./mongo";

/**
 * The repositories. MONGODB_URI set → MongoDB (MONGODB_DB, default "forking-paths");
 * unset → in memory, so the app runs with no database (data is lost on restart).
 *
 * The store is kept on globalThis, so every route and a Next.js hot reload share it.
 */
const g = globalThis as typeof globalThis & {
  __forkingPathsStore?: { key: string; store: Store };
  __forkingPathsStoreOverride?: Store;
};

export function getStore(env: NodeJS.ProcessEnv = process.env): Store {
  if (g.__forkingPathsStoreOverride) return g.__forkingPathsStoreOverride;
  const uri = env.MONGODB_URI?.trim();
  const key = uri ? `mongo:${uri}:${dbName(env)}` : "memory";
  if (g.__forkingPathsStore?.key !== key) {
    if (!uri) console.warn("MONGODB_URI is not set: quests, runs and caches are kept in memory only.");
    g.__forkingPathsStore = {
      key,
      store: uri ? createMongoStore({ uri, dbName: dbName(env) }) : createMemoryStore(),
    };
  }
  return g.__forkingPathsStore.store;
}

/** Makes every repository function use `store` (tests and scripts). Undefined restores the default. */
export function setStore(store: Store | undefined): void {
  g.__forkingPathsStoreOverride = store;
}

// Repository functions on the shared store, under the names the other modules use.
export const saveQuest = (quest: Quest) => getStore().saveQuest(quest);
export const getQuest = (id: string) => getStore().getQuest(id);
export const questsNear = (lat: number, lng: number, km: number, filter?: QuestFilter) =>
  getStore().questsNear(lat, lng, km, filter);
export const saveAttempt = (attempt: Attempt) => getStore().saveAttempt(attempt);
export const attemptsFor = (runId: string, placeId?: string) => getStore().attemptsFor(runId, placeId);
export const startRun = (input: StartRunInput) => getStore().startRun(input);
export const getRun = (id: string) => getStore().getRun(id);
export const appendToPath = (runId: string, step: PathStep) => getStore().appendToPath(runId, step);
export const finishRun = (runId: string, finish: RunFinish) => getStore().finishRun(runId, finish);
export const getClip = (id: string) => getStore().getClip(id);
export const putClip = (clip: NewClip) => getStore().putClip(clip);
export const cacheGet = <T = unknown>(key: string) => getStore().cacheGet<T>(key);
export const cacheSet = (key: string, source: string, payload: unknown) => getStore().cacheSet(key, source, payload);
