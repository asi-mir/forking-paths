/**
 * Voices the narrator's 3-line sample (with audio tags) and mixes it over the ambience, to hear
 * the designed voice once.
 *
 *   pnpm exec tsx scripts/voice-sample.ts [--out <dir>] [--dry-run]
 *
 * Writes `sample-1.mp3` … `sample-3.mp3` and, when ffmpeg is installed and the ambience exists
 * (scripts/make-sounds.ts), `sample-over-ambience.mp3`: the three lines with short pauses, the
 * ambience looped under them at the app's level (AMBIENCE_GAIN), faded in and out.
 * The lines are cached clips like any other, so a rerun costs nothing. It does not take from
 * the app's daily budget. Without ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID: "skipped", exit 0.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AMBIENCE_FADE_MS, AMBIENCE_GAIN } from "../src/lib/audio-mix";
import { elevenLabsVoiceClient, findSounds, makeSound, readClipAudio, speakDetailed, type VoiceClient } from "../src/lib/voice";
import { STATIC_AUDIO_DIR } from "../src/lib/voice-static";
import { SAMPLE_LINES } from "../src/mastra/agents/narrator-style";
import { DRY_RUN, has, hasFfmpeg, kb, loadEnv, mockVoiceClient, openStore, outDir, run, sdkClient, skip } from "./voice-cli";

const PAUSE_S = 0.7;

run(async () => {
  loadEnv();
  if (DRY_RUN && !has("ELEVENLABS_VOICE_ID")) process.env.ELEVENLABS_VOICE_ID = "dry-run-voice";
  if (!DRY_RUN && !has("ELEVENLABS_VOICE_ID")) skip("ELEVENLABS_VOICE_ID", "run scripts/design-voice.ts --write-env first");
  const sdk = sdkClient();
  const client: VoiceClient | null = DRY_RUN ? mockVoiceClient() : sdk ? elevenLabsVoiceClient(sdk) : null;
  const { store } = await openStore();
  const staticDir = DRY_RUN ? null : STATIC_AUDIO_DIR;
  const opts = { store, client, live: true, budget: false, staticDir };
  const dir = outDir("sample");

  const files: string[] = [];
  for (const [i, line] of SAMPLE_LINES.entries()) {
    const started = performance.now();
    const res = await speakDetailed(line, opts);
    const ms = Math.round(performance.now() - started);
    if (!res.clipId) {
      if (res.reason === "no-key") skip("ELEVENLABS_API_KEY", "nothing voiced");
      throw new Error(`line ${i + 1} was not voiced (${res.reason})`);
    }
    const mp3 = (await readClipAudio(res.clipId, opts))!;
    const file = join(dir, `sample-${i + 1}.mp3`);
    writeFileSync(file, mp3);
    files.push(file);
    console.log(`line ${i + 1}: ${res.charsSpent ? `voiced (${res.charsSpent} characters, ${ms} ms)` : "cached"}, ${kb(mp3.byteLength)}`);
  }

  if (DRY_RUN) await makeSound("ambience", opts);
  const ambienceId = (await findSounds(opts)).ambience;
  if (!ambienceId) {
    console.log("mix skipped: no ambience yet (run scripts/make-sounds.ts)");
    return;
  }
  if (!hasFfmpeg()) {
    console.log("mix skipped: ffmpeg not installed (the app mixes in the browser)");
    return;
  }
  const ambience = join(dir, "ambience.mp3");
  writeFileSync(ambience, (await readClipAudio(ambienceId, opts))!);

  const out = join(dir, "sample-over-ambience.mp3");
  const fade = AMBIENCE_FADE_MS / 1000;
  const n = files.length;
  // Each line, then a pause (a longer one after the last, for the ambience to fade out under).
  const pads = files.map(
    (_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${i === n - 1 ? PAUSE_S + 2 * fade : PAUSE_S}[l${i}]`,
  );
  const voice = `${files.map((_, i) => `[l${i}]`).join("")}concat=n=${n}:v=0:a=1,adelay=${Math.round(fade * 1000)}:all=1[v]`;
  const bed =
    `[${n}:a]aresample=44100,aformat=channel_layouts=mono,volume=${AMBIENCE_GAIN},afade=t=in:d=${fade}[bed]`;
  // The bed ends with the voice track; reversing twice fades out its last `fade` seconds.
  const mix = `[v][bed]amix=inputs=2:duration=first:normalize=0,areverse,afade=t=in:d=${fade},areverse[m]`;
  const res = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      ...files.flatMap((f) => ["-i", f]),
      "-stream_loop", "-1", "-i", ambience,
      "-filter_complex", [...pads, voice, bed, mix].join(";"),
      "-map", "[m]", "-ac", "1", "-b:a", "96k", out,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr.trim().slice(0, 300)}`);
  console.log(`mixed: ${out}`);
});
