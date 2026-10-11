import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CACHE_TTL_S, closeMongo, collections, ensureIndexes, getDb } from "../db";
import { createMongoStore } from "./mongo";
import { storeContract } from "./store.contract";

/**
 * Integration tests against a real MongoDB. They run only when MONGODB_URI is set:
 *   MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=forking-paths-test pnpm test
 * The database is dropped before and after the run, so never point it at real data.
 */
const uri = process.env.MONGODB_URI;
const name = `${process.env.MONGODB_DB || "forking-paths"}-itest`;

describe.skipIf(!uri)("MongoDB integration", () => {
  const drop = async () => {
    const client = await new MongoClient(uri!).connect();
    await client.db(name).dropDatabase();
    await client.close();
  };

  beforeAll(drop);
  afterAll(async () => {
    await closeMongo();
    await drop();
  });

  storeContract(
    "mongo",
    (opts) => createMongoStore({ uri: uri!, dbName: name, ...opts }),
    async () => {
      const c = collections(await getDb(uri!, name));
      await Promise.all(Object.values(c).map((col) => col.deleteMany({})));
    },
  );

  it("creates the indexes, and creating them again changes nothing", async () => {
    const db = await getDb(uri!, name);
    await ensureIndexes(db);
    const c = collections(db);
    const quests = await c.quests.indexes();
    expect(quests.find((i) => i.name === "center_2dsphere")?.key).toEqual({ center: "2dsphere" });
    const cache = await c.cache.indexes();
    expect(cache.find((i) => i.name === "createdAt_ttl")?.expireAfterSeconds).toBe(CACHE_TTL_S);
    expect((await c.attempts.indexes()).map((i) => i.name)).toEqual(expect.arrayContaining(["questId", "runId_placeId"]));
    expect((await c.runs.indexes()).map((i) => i.name)).toContain("questId");
  });
});
