/**
 * The server the browser checks run against: a production build (`pnpm build`), started by
 * Playwright with these variables on top of `.env.local`. Next.js keeps a variable that is
 * already set, even when it is empty, so an empty value here switches a key off.
 *
 * - No paid or remote call: no Google, SerpApi or ElevenLabs key; Sentry off (both DSNs empty).
 * - The photo reader is local Gemma at a closed port, so it fails at once: a stop passes on GPS
 *   alone, and a desk-demo sample photo uses its stored result (labelled on screen). Every
 *   result is the same on every run.
 * - Daily caps at 0: a new quest is never generated, the nearest saved one is offered instead.
 * - A narrator voice id with no key: lines voiced before (clips in the database) play, nothing
 *   new is voiced. The audio checks put test clips in the database for the demo quest's lines.
 */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
export const E2E_DB = process.env.E2E_DB ?? "forking-paths-qa-e2e";
export const E2E_MONGODB_URI = process.env.E2E_MONGODB_URI ?? "mongodb://127.0.0.1:27017";
/** The voice the test clips are stored under (never sent to ElevenLabs: there is no key). */
export const E2E_VOICE_ID = "e2e-test-voice";
export const E2E_TTS_MODEL = "eleven_v4";

export const E2E_SERVER_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  MONGODB_URI: E2E_MONGODB_URI,
  MONGODB_DB: E2E_DB,
  GEMMA_PROVIDER: "ollama",
  GEMMA_WRITER_PROVIDER: "ollama",
  GEMMA_READER_PROVIDER: "ollama",
  GEMMA_NARRATOR_PROVIDER: "ollama",
  OLLAMA_BASE_URL: "http://127.0.0.1:9/v1", // nothing listens here: the reader fails at once
  OLLAMA_AUTH_HEADER: "",
  GOOGLE_GENERATIVE_AI_API_KEY: "",
  SERPAPI_API_KEY: "",
  ELEVENLABS_API_KEY: "",
  ELEVENLABS_LIVE: "",
  ELEVENLABS_VOICE_ID: E2E_VOICE_ID,
  ELEVENLABS_MODEL_ID: E2E_TTS_MODEL,
  BUDGET_QUESTS_PER_DAY: "0",
  BUDGET_SERPAPI_PER_DAY: "0",
  BUDGET_TTS_CHARS_PER_DAY: "0",
  SENTRY_DSN: "",
  // The browser bundle and the server fall back to this one: empty here, and at build time
  // (build with NEXT_PUBLIC_SENTRY_DSN= set empty), so no e2e trace reaches Sentry.
  NEXT_PUBLIC_SENTRY_DSN: "",
  SENTRY_ENVIRONMENT: "e2e",
};
