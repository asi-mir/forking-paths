/**
 * Makes the game's sounds once with ElevenLabs sound effects: the ambience bed (12 s, loops)
 * that plays under the briefing and the clues, a "found it" stinger and a "not here" stinger.
 *
 *   pnpm exec tsx scripts/make-sounds.ts [--export] [--out <dir>] [--dry-run]
 *
 * Each sound is stored as a clip (MongoDB `clips` when MONGODB_URI is set). A sound that
 * exists already (in the store or in `public/audio/`) is not made again, so a rerun costs
 * nothing. `--export` copies the sounds into `public/audio/` for the desk demo.
 * Without ELEVENLABS_API_KEY it prints "skipped" for each missing sound and exits 0.
 * `--dry-run` uses a mock client and an in-memory store; `--export` then writes to `--out`
 * (default: a temp folder), never to `public/audio/`.
 */
import { elevenLabsVoiceClient, makeSound, readClipAudio, SOUNDS, type SoundKind, type VoiceClient } from "../src/lib/voice";
import { STATIC_AUDIO_DIR, writeStaticClips, type StaticClipEntry } from "../src/lib/voice-static";
import { DRY_RUN, flag, kb, loadEnv, mockVoiceClient, openStore, outDir, run, sdkClient } from "./voice-cli";

run(async () => {
  loadEnv();
  const sdk = sdkClient();
  const client: VoiceClient | null = DRY_RUN ? mockVoiceClient() : sdk ? elevenLabsVoiceClient(sdk) : null;
  const { store, where } = await openStore();
  const staticDir = DRY_RUN ? null : STATIC_AUDIO_DIR;
  console.log(`clip store: ${where}${DRY_RUN ? " (dry run: mock ElevenLabs)" : ""}`);

  const made: { kind: SoundKind; id: string }[] = [];
  let requests = 0;
  for (const kind of Object.keys(SOUNDS) as SoundKind[]) {
    const spec = SOUNDS[kind];
    const res = await makeSound(kind, { store, client, live: true, budget: false, staticDir });
    if (!res.clipId) {
      console.log(`${kind}: skipped: ELEVENLABS_API_KEY not set`);
      continue;
    }
    if (res.requested) requests += 1;
    const mp3 = await readClipAudio(res.clipId, { store, staticDir });
    console.log(
      `${kind}: ${res.requested ? "made" : "cached"} ${res.clipId} (${spec.durationSeconds} s${spec.loop ? ", loops" : ""}, ${kb(mp3?.byteLength ?? 0)})`,
    );
    made.push({ kind, id: res.clipId });
  }
  console.log(`ElevenLabs sound requests: ${requests}`);

  if (flag("export") && made.length > 0) {
    const entries: StaticClipEntry[] = [];
    for (const m of made) {
      const mp3 = await readClipAudio(m.id, { store, staticDir });
      if (mp3) entries.push({ id: m.id, kind: "sound", text: `${m.kind}: ${SOUNDS[m.kind].text}`, mp3 });
    }
    const dir = DRY_RUN ? outDir("sounds") : STATIC_AUDIO_DIR;
    const res = writeStaticClips(entries, null, dir);
    console.log(`exported ${res.written} sounds (${kb(res.bytes)}) to ${dir}`);
  }
});
