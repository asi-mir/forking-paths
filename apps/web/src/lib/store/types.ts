import type { Attempt, Lang, PathStep, Quest, Run } from "@/quest/schema";

/** A saved quest: it always has an id and a creation time, and its centre is rounded to ~100 m. */
export type StoredQuest = Quest & { id: string; createdAt: string };

/** A quest found by `questsNear`, with its straight-line distance from the search point. */
export type NearQuest = { quest: StoredQuest; distanceM: number };

export type QuestFilter = {
  lang?: Lang;
  minutes?: number;
  /** Default "ready": failed quests are kept for evals but never offered to a player. */
  status?: Quest["status"] | "any";
  /** Default 10. */
  limit?: number;
};

export type StoredAttempt = Attempt & { id: string };

export type StartRunInput = {
  questId: string;
  userAgent?: string;
  /** Default: a new id. */
  id?: string;
  /** Default: now. */
  startedAt?: Date;
};

/** What the finish route stores: the screen-time receipt and the score. */
export type RunFinish = {
  screenOnMs: number;
  pocketMs: number;
  peeks: number;
  stopsFound: number;
  score: number;
  /** Default: now. */
  finishedAt?: Date;
};

/** A voiced line. `id` = hash(text + voice + model). */
export type Clip = {
  id: string;
  text: string;
  voiceId: string;
  modelId: string;
  mp3: Uint8Array;
  createdAt: string;
};
export type NewClip = Omit<Clip, "createdAt">;

/** Result of one atomic take on a daily counter. */
export type CounterTake = { ok: boolean; used: number };

/**
 * The repositories. Two implementations share this interface: MongoDB (MONGODB_URI set)
 * and in memory (no database: keyless development, unit tests, the desk demo).
 */
export interface Store {
  readonly kind: "mongo" | "memory";

  /** Saves (or replaces, by id) a quest. Rounds its centre; rejects a ready quest that cites an unknown fact. */
  saveQuest(quest: Quest): Promise<StoredQuest>;
  getQuest(id: string): Promise<StoredQuest | null>;
  /** Quests within `km` of a point, nearest first. `km = Infinity` searches everywhere. */
  questsNear(lat: number, lng: number, km: number, filter?: QuestFilter): Promise<NearQuest[]>;

  saveAttempt(attempt: Attempt): Promise<StoredAttempt>;
  /** A run's attempts, oldest first; with `placeId`, only that stop's. */
  attemptsFor(runId: string, placeId?: string): Promise<StoredAttempt[]>;

  startRun(input: StartRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  /** Adds a step to the walked path. A second step for the same place is ignored. Null: no such run. */
  appendToPath(runId: string, step: PathStep): Promise<Run | null>;
  /** Stores the receipt and score once; finishing again returns the run as first finished. Null: no such run. */
  finishRun(runId: string, finish: RunFinish): Promise<Run | null>;

  getClip(id: string): Promise<Clip | null>;
  putClip(clip: NewClip): Promise<void>;

  /** A cached payload younger than 7 days, or null. */
  cacheGet<T = unknown>(key: string): Promise<T | null>;
  cacheSet(key: string, source: string, payload: unknown): Promise<void>;

  /** Atomically adds `amount` to counter `key` unless that would pass `cap`. Use `budgetTake` in `@/lib/budget`. */
  counterTake(key: string, amount: number, cap: number): Promise<CounterTake>;
  counterUsed(key: string): Promise<number>;

  /** Releases connections (scripts and tests). */
  close(): Promise<void>;
}
