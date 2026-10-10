/**
 * Pre-voices the desk demo's quest (Karaköy), so "Try it from your desk" never waits for a voice.
 *
 *   pnpm exec tsx scripts/seed-demo-voice.ts [--export] [--max-chars <n>] [--out <dir>] [--dry-run]
 *
 * Voices the briefing, each place's clue, look, hint and reveal, and the finale with the
 * designed voice (ELEVENLABS_VOICE_ID) and stores the clips (MongoDB `clips` when MONGODB_URI
 * is set). Lines already voiced cost nothing, so a rerun is free. It refuses to spend more
 * than `--max-chars` (default 3000) characters in one run. This script does not take from the
 * app's daily `tts-chars` budget: it is run by hand, once.
 *
 * `--export` copies the demo's clips and the sounds into `public/audio/` (with
 * `manifest.json`), so a fresh deployment plays the demo with an empty database and no
 * ElevenLabs credits. Without ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID it prints "skipped"
 * and exits 0 (after exporting what is already voiced, with `--export`). `--dry-run` uses a
 * mock client and an in-memory store, and exports to `--out` (default: a temp folder).
 */
import { demoQuest } from "../src/quest/demo";
import {
  clipIdFor,
  elevenLabsVoiceClient,
  findSounds,
  questLines,
  questVoiceCost,
  readClipAudio,
  SOUNDS,
  voiceConfig,
  voiceQuest,
  type SoundKind,
  type VoiceClient,
} from "../src/lib/voice";
import { STATIC_AUDIO_DIR, writeStaticClips, type StaticClipEntry } from "../src/lib/voice-static";
import { DRY_RUN, flag, has, kb, loadEnv, mockVoiceClient, numberOption, openStore, outDir, run, sdkClient } from "./voice-cli";

run(async () => {
  loadEnv();
  if (DRY_RUN && !has("ELEVENLABS_VOICE_ID")) process.env.ELEVENLABS_VOICE_ID = "dry-run-voice";
  const sdk = sdkClient();
  const client: VoiceClient | null = DRY_RUN ? mockVoiceClient() : sdk ? elevenLabsVoiceClient(sdk) : null;
  const { store, where } = await openStore();
  const staticDir = DRY_RUN ? null : STATIC_AUDIO_DIR;
  const maxChars = numberOption("max-chars", 3000);
  const quest = demoQuest();
  const config = voiceConfig(process.env, staticDir);
  console.log(`clip store: ${where}${DRY_RUN ? " (dry run: mock ElevenLabs)" : ""}; model ${config.modelId}`);

  if (!config.voiceId) {
    console.log("skipped: ELEVENLABS_VOICE_ID not set (run scripts/design-voice.ts --write-env first)");
    return;
  }

  const cost = await questVoiceCost(quest, { store, staticDir });
  console.log(
    `demo quest "${quest.title}": ${cost.lines} lines, ${cost.chars} characters; not voiced yet: ${cost.missing} lines, ${cost.missingChars} characters`,
  );

  let voiced = cost.missing === 0;
  if (!voiced && !client) {
    console.log("skipped: ELEVENLABS_API_KEY not set (the demo shows text)");
  } else if (!voiced && cost.missingChars > maxChars) {
    console.log(`not voiced: ${cost.missingChars} characters is more than --max-chars ${maxChars}`);
  } else {
    const res = await voiceQuest(quest, { store, client, live: true, budget: false, staticDir });
    console.log(
      `voiced: ${Object.keys(res.clips).length}/${cost.lines} lines; ElevenLabs requests: ${res.requests}; characters: ${res.charsSpent}` +
        (res.failed.length ? `; failed (text only): ${res.failed.join(", ")}` : "") +
        (res.reason ? `; voice off: ${res.reason}` : ""),
    );
    voiced = res.voice;
  }

  if (!flag("export")) return;
  const entries: StaticClipEntry[] = [];
  if (voiced) {
    for (const l of questLines(quest)) {
      const id = clipIdFor(l.text, config.voiceId, config.modelId);
      const mp3 = await readClipAudio(id, { store, staticDir });
      if (mp3 && !entries.some((e) => e.id === id)) entries.push({ id, kind: "line", text: l.text, mp3 });
    }
  }
  const sounds = await findSounds({ store, staticDir });
  for (const [kind, id] of Object.entries(sounds) as [SoundKind, string][]) {
    const mp3 = await readClipAudio(id, { store, staticDir });
    if (mp3) entries.push({ id, kind: "sound", text: `${kind}: ${SOUNDS[kind].text}`, mp3 });
  }
  if (entries.length === 0) {
    console.log("nothing to export yet");
    return;
  }
  const dir = DRY_RUN ? outDir("demo") : STATIC_AUDIO_DIR;
  const lines = entries.filter((e) => e.kind === "line").length;
  const res = writeStaticClips(entries, lines ? { voiceId: config.voiceId, modelId: config.modelId } : null, dir);
  console.log(`exported ${lines} lines and ${entries.length - lines} sounds (${kb(res.bytes)}) to ${dir}`);
});
