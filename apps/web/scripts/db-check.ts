/**
 * Checks the database: connects with MONGODB_URI, creates the app's indexes, starts Mastra's
 * storage, and lists the collections. Prints no connection string.
 *
 *   pnpm db:check
 */
import { existsSync } from "node:fs";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.MONGODB_URI?.trim()) {
    console.log("skipped: MONGODB_URI not set (the app keeps its data in memory)");
    return;
  }

  const { closeMongo, collections, dbName, getDb } = await import("../src/lib/db");
  const { mastra } = await import("../src/mastra/index");

  const started = Date.now();
  const db = await getDb(process.env.MONGODB_URI.trim(), dbName());
  console.log(`connected to database "${db.databaseName}" in ${Date.now() - started} ms; app indexes ensured`);

  const storage = mastra.getStorage();
  if (!storage) throw new Error("Mastra has no storage although MONGODB_URI is set");
  await storage.init();
  const workflows = await storage.getStore("workflows");
  console.log(`Mastra storage ready (workflow snapshots: ${workflows ? "yes" : "no"})`);

  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const app = Object.keys(collections(db));
  console.log(`app collections: ${app.filter((n) => names.includes(n)).join(", ") || "(none yet: created on first write)"}`);
  console.log(`Mastra collections: ${names.filter((n) => n.startsWith("mastra_")).length}`);

  await closeMongo();
  await (storage as { close?: () => Promise<void> }).close?.();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`db check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
