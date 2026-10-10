import { MongoClient } from "mongodb";
import { E2E_DB, E2E_MONGODB_URI } from "./env";

/**
 * A fresh test database for every run (forking-paths-qa-e2e by default, never the app's own):
 * no saved quests, runs or clips, so every check starts from the same state. The server has made
 * no database call yet (it only served the start page), so it creates the indexes again.
 */
export default async function globalSetup() {
  if (!/^forking-paths-[a-z0-9-]+$/.test(E2E_DB) || E2E_DB === "forking-paths") {
    throw new Error(`E2E_DB must be a test database (forking-paths-<name>), got "${E2E_DB}"`);
  }
  const client = new MongoClient(E2E_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(E2E_DB).dropDatabase();
  } catch (error) {
    throw new Error(`The browser checks need MongoDB at ${E2E_MONGODB_URI} (${(error as Error).message})`);
  } finally {
    await client.close();
  }
}
