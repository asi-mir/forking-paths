import { MongoClient, type Binary, type Collection, type Db, type ObjectId } from "mongodb";
import type { Attempt, Quest, Run } from "@/quest/schema";
import { APP_SLUG } from "./app";
import type { GeoPoint } from "./geo";

/**
 * The MongoDB client and the app's collections. Server only.
 *
 * Code outside `lib/store` should use the repositories in `@/lib/store`, which also work
 * without a database (in memory) when MONGODB_URI is not set.
 */

// ---------------------------------------------------------------------------
// Documents as stored

/** A quest as stored: the centre is a GeoJSON point ([lng, lat]) with a 2dsphere index. */
export type QuestDoc = Omit<Quest, "id" | "createdAt" | "center"> & {
  _id: string;
  createdAt: Date;
  center: GeoPoint;
};

/** One photo attempt. The photo itself is never stored. */
export type AttemptDoc = Omit<Attempt, "at"> & { _id: ObjectId; at: Date };

export type RunDoc = Omit<Run, "id" | "startedAt" | "finishedAt"> & {
  _id: string;
  startedAt: Date;
  finishedAt?: Date;
};

/** A voiced line. `_id` = hash(text + voice + model), so the same line is never paid for twice. */
export type ClipDoc = {
  _id: string;
  text: string;
  voiceId: string;
  modelId: string;
  mp3: Binary;
  createdAt: Date;
};

/** A cached search or page lookup. `_id` = "<source>:<rounded lat,lng>:<query>". Expires after 7 days. */
export type CacheDoc = { _id: string; source: string; payload: unknown; createdAt: Date };

/** A daily counter. `_id` = "<yyyy-mm-dd>:<quests|serpapi|tts-chars>" (UTC day). */
export type BudgetDoc = { _id: string; used: number };

export type Collections = {
  quests: Collection<QuestDoc>;
  attempts: Collection<AttemptDoc>;
  runs: Collection<RunDoc>;
  clips: Collection<ClipDoc>;
  cache: Collection<CacheDoc>;
  budget: Collection<BudgetDoc>;
};

export function collections(db: Db): Collections {
  return {
    quests: db.collection<QuestDoc>("quests"),
    attempts: db.collection<AttemptDoc>("attempts"),
    runs: db.collection<RunDoc>("runs"),
    clips: db.collection<ClipDoc>("clips"),
    cache: db.collection<CacheDoc>("cache"),
    budget: db.collection<BudgetDoc>("budget"),
  };
}

/** How long a cached search lives (TTL index on cache.createdAt). */
export const CACHE_TTL_S = 7 * 24 * 60 * 60;

/**
 * Creates the indexes. Idempotent: createIndexes with the same keys and options is a no-op.
 * Runs once per database per process (see `getDb`).
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const c = collections(db);
  await Promise.all([
    c.quests.createIndexes([
      { key: { center: "2dsphere" }, name: "center_2dsphere" },
    ]),
    c.cache.createIndexes([
      { key: { createdAt: 1 }, name: "createdAt_ttl", expireAfterSeconds: CACHE_TTL_S },
    ]),
    c.attempts.createIndexes([
      { key: { questId: 1 }, name: "questId" },
      { key: { runId: 1, placeId: 1 }, name: "runId_placeId" },
    ]),
    c.runs.createIndexes([{ key: { questId: 1 }, name: "questId" }]),
  ]);
}

// ---------------------------------------------------------------------------
// One client per process, kept on globalThis so Next.js hot reloads do not open new pools

type MongoCache = {
  clients: Map<string, Promise<MongoClient>>;
  indexed: Map<string, Promise<void>>;
};

const g = globalThis as typeof globalThis & { __forkingPathsMongo?: MongoCache };
const cache: MongoCache = (g.__forkingPathsMongo ??= { clients: new Map(), indexed: new Map() });

/** The database name: MONGODB_DB, or the app slug. */
export function dbName(env: NodeJS.ProcessEnv = process.env): string {
  return env.MONGODB_DB || APP_SLUG;
}

/** The shared client for a connection string (connects on first use). */
export function mongoClient(uri: string): Promise<MongoClient> {
  let client = cache.clients.get(uri);
  if (!client) {
    client = new MongoClient(uri, {
      appName: APP_SLUG,
      // Optional fields that are undefined are left out instead of stored as null,
      // so documents read back parse with the zod schemas.
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 5_000,
      maxPoolSize: 10,
    })
      .connect()
      .catch((err: unknown) => {
        cache.clients.delete(uri); // let the next request try again
        throw err;
      });
    cache.clients.set(uri, client);
  }
  return client;
}

/** The database, with its indexes ensured once per process. */
export async function getDb(uri: string, name: string): Promise<Db> {
  const db = (await mongoClient(uri)).db(name);
  const key = `${uri}\u0000${name}`;
  let indexed = cache.indexed.get(key);
  if (!indexed) {
    indexed = ensureIndexes(db).catch((err: unknown) => {
      cache.indexed.delete(key);
      throw err;
    });
    cache.indexed.set(key, indexed);
  }
  await indexed;
  return db;
}

/** Closes every cached client (scripts and tests; the app keeps its client open). */
export async function closeMongo(): Promise<void> {
  const clients = [...cache.clients.values()];
  cache.clients.clear();
  cache.indexed.clear();
  await Promise.all(clients.map(async (c) => (await c.catch(() => null))?.close()));
}

/** True for a MongoDB duplicate key error (E11000). */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}
