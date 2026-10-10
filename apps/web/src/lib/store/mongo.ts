import { Binary, ObjectId, type Document } from "mongodb";
import type { Attempt, PathStep, Quest, Run } from "@/quest/schema";
import {
  CACHE_TTL_S,
  closeMongo,
  collections,
  getDb,
  isDuplicateKey,
  type AttemptDoc,
  type Collections,
  type QuestDoc,
  type RunDoc,
} from "../db";
import { fromPoint, toPoint } from "../geo";
import { assertAmount, newRunId, prepareQuest } from "./shared";
import type {
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

function questFromDoc(doc: QuestDoc): StoredQuest {
  const { _id, createdAt, center, ...rest } = doc;
  return { ...rest, id: _id, createdAt: createdAt.toISOString(), center: fromPoint(center) };
}

function runFromDoc(doc: RunDoc): Run {
  const { _id, startedAt, finishedAt, ...rest } = doc;
  return {
    ...rest,
    id: _id,
    startedAt: startedAt.toISOString(),
    ...(finishedAt ? { finishedAt: finishedAt.toISOString() } : {}),
  };
}

function attemptFromDoc(doc: AttemptDoc): StoredAttempt {
  const { _id, at, ...rest } = doc;
  return { ...rest, id: _id.toHexString(), at: at.toISOString() };
}

/** The MongoDB store. Connects on first use through the shared client in `lib/db.ts`. */
export function createMongoStore(opts: { uri: string; dbName: string; now?: () => Date }): Store {
  const now = opts.now ?? (() => new Date());
  let cols: Promise<Collections> | undefined;
  const c = () =>
    (cols ??= getDb(opts.uri, opts.dbName).then(collections, (err: unknown) => {
      cols = undefined; // retry on the next call
      throw err;
    }));

  return {
    kind: "mongo",

    async saveQuest(input: Quest) {
      const { id, createdAt, center, ...rest } = prepareQuest(input, now());
      const doc: QuestDoc = { ...rest, _id: id, createdAt: new Date(createdAt), center: toPoint(center) };
      await (await c()).quests.replaceOne({ _id: id }, doc, { upsert: true });
      return questFromDoc(doc);
    },

    async getQuest(id) {
      const doc = await (await c()).quests.findOne({ _id: id });
      return doc ? questFromDoc(doc) : null;
    },

    async questsNear(lat, lng, km, filter: QuestFilter = {}) {
      const { lang, minutes, status = "ready", limit = 10 } = filter;
      const query: Document = {};
      if (status !== "any") query.status = status;
      if (lang) query.lang = lang;
      if (minutes !== undefined) query.minutes = minutes;
      const docs = await (await c()).quests
        .aggregate<QuestDoc & { distanceM: number }>([
          {
            // $geoNear must be the first stage. GeoJSON order: [lng, lat]. Distances in metres.
            $geoNear: {
              near: toPoint({ lat, lng }),
              key: "center",
              distanceField: "distanceM",
              spherical: true,
              query,
              ...(Number.isFinite(km) ? { maxDistance: km * 1000 } : {}),
            },
          },
          { $limit: limit },
        ])
        .toArray();
      return docs.map(({ distanceM, ...doc }): NearQuest => ({ quest: questFromDoc(doc), distanceM }));
    },

    async saveAttempt(attempt: Attempt) {
      const doc: AttemptDoc = { ...attempt, _id: new ObjectId(), at: new Date(attempt.at) };
      await (await c()).attempts.insertOne(doc);
      return attemptFromDoc(doc);
    },

    async attemptsFor(runId, placeId) {
      const docs = await (await c()).attempts
        .find(placeId === undefined ? { runId } : { runId, placeId })
        .sort({ at: 1, _id: 1 })
        .toArray();
      return docs.map(attemptFromDoc);
    },

    async startRun(input: StartRunInput) {
      const doc: RunDoc = {
        _id: input.id ?? newRunId(),
        questId: input.questId,
        path: [],
        startedAt: input.startedAt ?? now(),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        ...(input.voice ? { voice: structuredClone(input.voice) } : {}),
      };
      await (await c()).runs.insertOne(doc);
      return runFromDoc(doc);
    },

    async getRun(id) {
      const doc = await (await c()).runs.findOne({ _id: id });
      return doc ? runFromDoc(doc) : null;
    },

    async appendToPath(runId, step: PathStep) {
      const { runs } = await c();
      // The filter skips a second step for the same place (a double tap, a retried request).
      const doc = await runs.findOneAndUpdate(
        { _id: runId, "path.placeId": { $ne: step.placeId } },
        { $push: { path: step } },
        { returnDocument: "after" },
      );
      if (doc) return runFromDoc(doc);
      const existing = await runs.findOne({ _id: runId });
      return existing ? runFromDoc(existing) : null;
    },

    async finishRun(runId, finish: RunFinish) {
      const { runs } = await c();
      const { finishedAt, ...rest } = finish;
      const doc = await runs.findOneAndUpdate(
        { _id: runId, finishedAt: { $exists: false } },
        { $set: { ...rest, finishedAt: finishedAt ?? now() } },
        { returnDocument: "after" },
      );
      if (doc) return runFromDoc(doc);
      const existing = await runs.findOne({ _id: runId });
      return existing ? runFromDoc(existing) : null;
    },

    async getClip(id) {
      const doc = await (await c()).clips.findOne({ _id: id });
      if (!doc) return null;
      const { _id, mp3, createdAt, ...rest } = doc;
      return { ...rest, id: _id, mp3: mp3.value(), createdAt: createdAt.toISOString() };
    },

    async putClip(clip: NewClip) {
      const { id, mp3, ...rest } = clip;
      await (await c()).clips.replaceOne(
        { _id: id },
        { ...rest, mp3: new Binary(mp3), createdAt: now() },
        { upsert: true },
      );
    },

    async cacheGet<T>(key: string) {
      // The TTL monitor deletes expired entries about once a minute; the filter covers the gap.
      const fresh = new Date(now().getTime() - CACHE_TTL_S * 1000);
      const doc = await (await c()).cache.findOne({ _id: key, createdAt: { $gt: fresh } });
      return doc ? (doc.payload as T) : null;
    },

    async cacheSet(key, source, payload) {
      await (await c()).cache.replaceOne(
        { _id: key },
        { source, payload, createdAt: now() },
        { upsert: true },
      );
    },

    async counterTake(key, amount, cap): Promise<CounterTake> {
      assertAmount(amount);
      const { budget } = await c();
      if (amount <= cap) {
        // Two tries. The filter matches only while the take fits under the cap. When it does not
        // match, the upsert tries to insert `key` and fails with a duplicate key if the counter
        // exists: that is a refusal. On the day's first takes, two requests can both insert;
        // the loser gets a duplicate key although the cap is not reached, so it tries once more,
        // now against the existing counter.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const doc = await budget.findOneAndUpdate(
              { _id: key, used: { $lte: cap - amount } },
              { $inc: { used: amount } },
              { upsert: true, returnDocument: "after" },
            );
            if (doc) return { ok: true, used: doc.used };
          } catch (err) {
            if (!isDuplicateKey(err)) throw err;
          }
        }
      }
      return { ok: false, used: (await budget.findOne({ _id: key }))?.used ?? 0 };
    },

    async counterUsed(key) {
      return (await (await c()).budget.findOne({ _id: key }))?.used ?? 0;
    },

    async close() {
      cols = undefined;
      await closeMongo();
    },
  };
}
