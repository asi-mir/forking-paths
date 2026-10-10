/**
 * Shared bits of the voice scripts (design-voice, make-sounds, seed-demo-voice, voice-sample):
 * env loading, arguments, the ElevenLabs client, a mock client for --dry-run, the clip store,
 * and printing without secrets.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { VoiceClient } from "../src/lib/voice";

export const ENV_FILE = resolve(process.cwd(), ".env.local");

/** Loads `.env.local` (variables already set in the shell win, also when set to empty). */
export function loadEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

/** The real path of `.env.local` (it may be a symlink in a worktree). */
export function envFilePath(): string {
  return existsSync(ENV_FILE) ? realpathSync(ENV_FILE) : ENV_FILE;
}

const argv = process.argv.slice(2);
export const flag = (name: string) => argv.includes(`--${name}`);
export const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
export const numberOption = (name: string, fallback: number): number => {
  const raw = option(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** --dry-run: a mock ElevenLabs client, an in-memory store, nothing written to the project. */
export const DRY_RUN = flag("dry-run");

export function has(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

/** The SDK client, or null when ELEVENLABS_API_KEY is not set. */
export function sdkClient(): ElevenLabsClient | null {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  return new ElevenLabsClient({ apiKey });
}

/** Prints "skipped: NAME not set" and exits 0. */
export function skip(name: string, extra = ""): never {
  console.log(`skipped: ${name} not set${extra ? ` (${extra})` : ""}`);
  process.exit(0);
}

/** True when `ffmpeg` is on the PATH (used to mix the sample, and for dry-run tones). */
export function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/**
 * A stand-in clip for dry runs: a quiet sine tone as a real MP3 when ffmpeg is there (so the
 * mix and the audio route can be checked end to end), else a few bytes that do not play.
 */
export function fakeMp3(label: string, seconds = 1.5, freq = 330): Uint8Array {
  if (hasFfmpeg()) {
    const res = spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-af", "volume=0.2",
        "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (res.status === 0 && res.stdout.byteLength > 0) return new Uint8Array(res.stdout);
  }
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new TextEncoder().encode(label)]);
}

/** A mock `VoiceClient` that counts requests and characters (dry runs). */
export function mockVoiceClient(): VoiceClient & { requests: number; chars: number } {
  const mock = {
    requests: 0,
    chars: 0,
    async speech({ text }: { text: string }) {
      mock.requests += 1;
      mock.chars += text.length;
      return fakeMp3(`speech:${text.slice(0, 20)}`, Math.min(6, 0.5 + text.length / 20), 330);
    },
    async sound({ text, durationSeconds }: { text: string; durationSeconds: number }) {
      mock.requests += 1;
      return fakeMp3(`sound:${text.slice(0, 20)}`, durationSeconds, 110);
    },
  };
  return mock;
}

/** An output directory: `--out`, else a folder in the system temp directory. Created. */
export function outDir(name: string): string {
  const dir = resolve(option("out") ?? join(tmpdir(), "forking-paths-voice", name));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The store the app uses (MongoDB when MONGODB_URI is set), or memory for a dry run. */
export async function openStore() {
  const { createMemoryStore, getStore } = await import("../src/lib/store");
  const store = DRY_RUN ? createMemoryStore() : getStore();
  const where = DRY_RUN || !has("MONGODB_URI") ? "memory" : `MongoDB database "${process.env.MONGODB_DB?.trim() || "forking-paths"}"`;
  return { store, where };
}

/** Closes the MongoDB connection if one was opened. */
export async function closeStore(): Promise<void> {
  if (DRY_RUN || !has("MONGODB_URI")) return;
  const { closeMongo } = await import("../src/lib/db");
  await closeMongo();
}

/** An error as one line, with any secret value from the environment masked. */
export function describeError(err: unknown): string {
  const e = err as { statusCode?: number; message?: string; body?: unknown };
  let text = e?.statusCode ? `HTTP ${e.statusCode}: ` : "";
  const body = e?.body as { detail?: { message?: string; status?: string } | string } | undefined;
  const detail = typeof body?.detail === "string" ? body.detail : (body?.detail?.message ?? body?.detail?.status);
  text += detail ?? e?.message ?? String(err);
  for (const name of ["ELEVENLABS_API_KEY", "MONGODB_URI", "SENTRY_AUTH_TOKEN"]) {
    const v = process.env[name];
    if (v && v.length > 8) text = text.split(v).join(`<${name}>`);
  }
  return text.replace(/\s+/g, " ").slice(0, 300);
}

export function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}

export const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Runs `main`, closes the store, and exits (0 on success, 1 on an error, printed without secrets). */
export function run(main: () => Promise<void>): void {
  main()
    .then(async () => {
      await closeStore();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      console.error(`error: ${describeError(err)}`);
      await closeStore().catch(() => undefined);
      process.exit(1);
    });
}
