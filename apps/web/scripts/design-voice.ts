/**
 * Designs the narrator's voice with ElevenLabs Voice Design, once.
 *
 *   pnpm exec tsx scripts/design-voice.ts [--pick <n>] [--seed <n>] [--out <dir>] [--write-env] [--force] [--dry-run]
 *   pnpm exec tsx scripts/design-voice.ts --previews-only [--seed <n>] [--out <dir>]
 *   pnpm exec tsx scripts/design-voice.ts --generated-id <id> [--write-env] [--force]
 *
 * 1. `textToVoice.design` makes a few previews from the description in
 *    `src/mastra/agents/narrator-style.md`; they are saved as `preview-<n>.mp3` in `--out`
 *    (default: a folder in the system temp directory), and each preview's id is printed.
 *    `--previews-only` stops here, so the previews can be heard before one is chosen.
 * 2. Preview `--pick` (1-based, default 1) becomes a saved voice (`textToVoice.create`).
 *    `--generated-id` saves a preview from an earlier `--previews-only` run instead (no new previews).
 * 3. The voice id is printed. `--write-env` replaces only the ELEVENLABS_VOICE_ID line in
 *    `.env.local`.
 *
 * When Voice Design is not on the plan, it picks a premade voice instead and says so.
 * Safe to rerun: with ELEVENLABS_VOICE_ID already set it does nothing unless `--force`.
 * Without ELEVENLABS_API_KEY it prints "skipped" and exits 0. `--dry-run` uses a mock client
 * and writes nothing but the previews.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setEnvLine } from "../src/lib/env-file";
import { NARRATOR_VOICE_DESCRIPTION, NARRATOR_VOICE_NAME } from "../src/mastra/agents/narrator-style";
import {
  DRY_RUN,
  describeError,
  envFilePath,
  flag,
  has,
  kb,
  loadEnv,
  numberOption,
  option,
  outDir,
  run,
  sdkClient,
  skip,
  statusOf,
} from "./voice-cli";

/** Premade voices that suit the narrator, best first (used only when Voice Design is refused). */
const PREMADE_PREFERENCE = ["George", "Bill", "Brian", "Daniel", "Roger"];

/**
 * ElevenLabs' default voice ids, for a key that may not list voices (no `voices_read`
 * permission). The first text-to-speech call checks that the id still works.
 */
const KNOWN_PREMADE = [
  { voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", labels: { gender: "male", accent: "british" } },
  { voiceId: "nPczCjzI2devNBz1zQrb", name: "Brian", labels: { gender: "male", accent: "american" } },
  { voiceId: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", labels: { gender: "male", accent: "british" } },
];

type Preview = { generatedVoiceId: string; audioBase64: string; durationSecs: number };
type Designer = {
  design(seed?: number): Promise<Preview[]>;
  create(generatedVoiceId: string): Promise<string>;
  premade(): Promise<{ voiceId: string; name: string; labels: Record<string, string> }[]>;
};

function sdkDesigner(): Designer | null {
  const client = sdkClient();
  if (!client) return null;
  return {
    async design(seed) {
      const res = await client.textToVoice.design(
        { voiceDescription: NARRATOR_VOICE_DESCRIPTION, modelId: "eleven_ttv_v3", autoGenerateText: true, seed },
        { timeoutInSeconds: 180, maxRetries: 0 },
      );
      return res.previews;
    },
    async create(generatedVoiceId) {
      const voice = await client.textToVoice.create(
        {
          voiceName: NARRATOR_VOICE_NAME,
          voiceDescription: NARRATOR_VOICE_DESCRIPTION,
          generatedVoiceId,
          labels: { use: "narrator", project: "forking-paths" },
        },
        { timeoutInSeconds: 60, maxRetries: 0 },
      );
      return voice.voiceId;
    },
    async premade() {
      try {
        const res = await client.voices.search({ category: "premade", pageSize: 100 });
        return res.voices.map((v) => ({ voiceId: v.voiceId, name: v.name ?? "", labels: v.labels ?? {} }));
      } catch (err) {
        if (!notOnPlan(err)) throw err;
        console.log(`cannot list voices (${describeError(err)}): using ElevenLabs' default voice ids`);
        return KNOWN_PREMADE;
      }
    },
  };
}

function mockDesigner(): Designer {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]).toString("base64");
  return {
    async design() {
      return [1, 2, 3].map((n) => ({ generatedVoiceId: `dry-run-preview-${n}`, audioBase64: audio, durationSecs: 7 }));
    },
    async create() {
      return "dry-run-voice";
    },
    async premade() {
      return [{ voiceId: "dry-run-premade", name: "George", labels: { gender: "male", age: "middle_aged" } }];
    },
  };
}

/** A refusal that means "not on this plan" rather than a bad request or an outage. */
function notOnPlan(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401 || status === 402 || status === 403) return true;
  return /plan|subscription|upgrade|not allowed|permission/i.test(describeError(err));
}

function choosePremade(voices: { voiceId: string; name: string; labels: Record<string, string> }[]) {
  for (const want of PREMADE_PREFERENCE) {
    const v = voices.find((x) => x.name.toLowerCase().startsWith(want.toLowerCase()));
    if (v) return v;
  }
  return voices.find((v) => v.labels.gender === "male") ?? voices[0];
}

run(async () => {
  loadEnv();
  const designer = DRY_RUN ? mockDesigner() : sdkDesigner();
  if (!designer) skip("ELEVENLABS_API_KEY", "the app shows text");
  if (has("ELEVENLABS_VOICE_ID") && !flag("force") && !DRY_RUN) {
    console.log("ELEVENLABS_VOICE_ID is already set: nothing to do (pass --force to design a new voice)");
    return;
  }

  const dir = outDir("design");
  const pick = Math.max(1, Math.floor(numberOption("pick", 1)));
  const seedRaw = option("seed");
  let voiceId: string;
  let kind: "designed" | "premade";

  const generatedId = option("generated-id");
  if (generatedId) {
    voiceId = await designer.create(generatedId);
    kind = "designed";
    console.log(`saved preview ${generatedId} as "${NARRATOR_VOICE_NAME}"`);
  } else try {
    const previews = await designer.design(seedRaw ? Number(seedRaw) : undefined);
    if (previews.length === 0) throw new Error("Voice Design returned no previews");
    previews.forEach((p, i) => {
      const mp3 = Buffer.from(p.audioBase64, "base64");
      writeFileSync(join(dir, `preview-${i + 1}.mp3`), mp3);
      console.log(`preview ${i + 1}: ${p.durationSecs.toFixed(1)} s, ${kb(mp3.byteLength)}, id ${p.generatedVoiceId}`);
    });
    if (flag("previews-only")) {
      console.log(`previews saved in ${dir}; save one with --generated-id <id>`);
      return;
    }
    const chosen = previews[Math.min(pick, previews.length) - 1];
    console.log(`previews saved in ${dir}; using preview ${Math.min(pick, previews.length)}`);
    voiceId = await designer.create(chosen.generatedVoiceId);
    kind = "designed";
  } catch (err) {
    if (!notOnPlan(err)) throw err;
    console.log(`Voice Design is not available on this plan (${describeError(err)}): using a premade voice`);
    const voice = choosePremade(await designer.premade());
    if (!voice) throw new Error("no premade voice found");
    console.log(`premade voice: ${voice.name}`);
    voiceId = voice.voiceId;
    kind = "premade";
  }

  console.log(`voice (${kind}): ELEVENLABS_VOICE_ID=${voiceId}`);
  if (flag("write-env")) {
    if (DRY_RUN) {
      console.log("dry run: .env.local not changed");
    } else {
      const file = envFilePath();
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        content = "";
      }
      writeFileSync(file, setEnvLine(content, "ELEVENLABS_VOICE_ID", voiceId));
      console.log("wrote ELEVENLABS_VOICE_ID in .env.local (no other line changed)");
    }
  }
});
