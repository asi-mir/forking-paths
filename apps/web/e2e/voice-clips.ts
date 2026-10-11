/**
 * Test clips for the audio checks: every line of the demo quest and the three sounds, stored in
 * the test database under the test voice (e2e/env.ts), as short tones from e2e/fixtures/. With
 * them a run starts with voice on and no ElevenLabs request (every line is cached).
 *
 *   pnpm exec tsx e2e/voice-clips.ts seed | clear
 *
 * Run by e2e/audio.spec.ts; MONGODB_URI and MONGODB_DB name the test database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMongoStore } from "@/lib/store";
import { clipIdFor, questLines, soundClipId, SOUNDS, SFX_MODEL, SFX_VOICE_ID } from "@/lib/voice";
import { demoQuest } from "@/quest/demo";
import { E2E_DB, E2E_MONGODB_URI, E2E_TTS_MODEL, E2E_VOICE_ID } from "./env";

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", name)));

/** Every clip id the demo quest's run asks for, with its text and audio. */
export function demoClips() {
  const line = fixture("line.mp3");
  const lines = questLines(demoQuest()).map((l) => ({
    id: clipIdFor(l.text, E2E_VOICE_ID, E2E_TTS_MODEL),
    text: l.text,
    voiceId: E2E_VOICE_ID,
    modelId: E2E_TTS_MODEL,
    mp3: line,
  }));
  const sounds = (Object.keys(SOUNDS) as (keyof typeof SOUNDS)[]).map((kind) => ({
    id: soundClipId(SOUNDS[kind]),
    text: SOUNDS[kind].text,
    voiceId: SFX_VOICE_ID,
    modelId: SFX_MODEL,
    mp3: fixture(kind === "ambience" ? "ambience.mp3" : "sting.mp3"),
  }));
  return [...lines, ...sounds];
}

async function main() {
  const command = process.argv[2];
  if (command !== "seed" && command !== "clear") throw new Error("usage: voice-clips.ts seed | clear");
  const dbName = process.env.MONGODB_DB ?? E2E_DB;
  if (!/^forking-paths-[a-z0-9-]+$/.test(dbName) || dbName === "forking-paths") throw new Error(`not a test database: ${dbName}`);
  const store = createMongoStore({ uri: process.env.MONGODB_URI ?? E2E_MONGODB_URI, dbName });
  try {
    const clips = demoClips();
    if (command === "seed") {
      for (const clip of clips) await store.putClip(clip);
    } else {
      const { MongoClient } = await import("mongodb");
      const client = await MongoClient.connect(process.env.MONGODB_URI ?? E2E_MONGODB_URI);
      await client.db(dbName).collection<{ _id: string }>("clips").deleteMany({ _id: { $in: clips.map((c) => c.id) } });
      await client.close();
    }
    console.log(`${command}: ${clips.length} clips`);
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
