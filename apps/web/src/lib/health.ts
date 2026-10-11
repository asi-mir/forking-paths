import { APP_SLUG } from "./app";
import { BUDGET_SERVICES, budgetCap, type BudgetService } from "./budget";
import { dbName, mongoClient } from "./db";
import { ModelConfigError, ROLES, modelLabel, resolveModelConfig, type Provider, type Role } from "./model";
import { voiceConfig } from "./voice";

/**
 * What `GET /api/health` reports: which provider and Gemma model each role uses, whether the
 * database answers, and which optional services are configured. It never carries a secret: keys
 * appear only as true/false, and no URL, host name or error text from a driver is included.
 *
 * Cheap on purpose (a host pings it every few seconds): no model call and no paid request; the
 * database ping is cached for `DB_PING_CACHE_MS`.
 */

export type RoleHealth =
  | { ok: true; provider: Provider; model: string }
  | { ok: false; error: string };

export type DatabaseHealth =
  | { kind: "memory"; ok: true }
  | { kind: "mongodb"; ok: boolean; ms?: number; error?: string };

export type HealthReport = {
  /** The app can serve: false only when the configured database does not answer (HTTP 503). */
  ok: boolean;
  /** Every role has a valid Gemma setting (and its key, on Google). False is reported, not a 503. */
  ready: boolean;
  app: string;
  /** The deployed commit (Render sets RENDER_GIT_COMMIT), short form; null elsewhere. */
  commit: string | null;
  models: Record<Role, RoleHealth>;
  database: DatabaseHealth;
  /** Which optional services have their settings (true/false only, never a value). */
  services: {
    google: boolean;
    serpapi: boolean;
    voice: { configured: boolean; live: boolean };
    sentry: boolean;
  };
  /** Today's caps on paid calls (not secrets). */
  caps: Record<BudgetService, number>;
};

/** How long one database ping answers for every health check. */
export const DB_PING_CACHE_MS = 10_000;
/** A ping that takes longer than this counts as down. */
export const DB_PING_TIMEOUT_MS = 3_000;

type Env = NodeJS.ProcessEnv;
export type DbPing = () => Promise<void>;

function has(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function roleHealth(role: Role, env: Env): RoleHealth {
  try {
    const config = resolveModelConfig(role, env);
    if (config.provider === "google" && !has(env, "GOOGLE_GENERATIVE_AI_API_KEY")) {
      return { ok: false, error: "GOOGLE_GENERATIVE_AI_API_KEY is not set" };
    }
    return { ok: true, provider: config.provider, model: modelLabel(config) };
  } catch (error) {
    // ModelConfigError messages name the setting, never its value.
    return { ok: false, error: error instanceof ModelConfigError ? error.message : "invalid model settings" };
  }
}

/** Pings MongoDB through the app's shared client. */
export function mongoPing(env: Env = process.env): DbPing {
  return async () => {
    const uri = env.MONGODB_URI?.trim();
    if (!uri) return;
    const client = await mongoClient(uri);
    await client.db(dbName(env)).command({ ping: 1 });
  };
}

type PingCache = { at: number; result: DatabaseHealth };
const g = globalThis as typeof globalThis & { __forkingPathsHealthPing?: PingCache };

/** Clears the cached database ping (tests). */
export function resetHealthCache(): void {
  delete g.__forkingPathsHealthPing;
}

async function databaseHealth(env: Env, ping: DbPing, now: number): Promise<DatabaseHealth> {
  if (!has(env, "MONGODB_URI")) return { kind: "memory", ok: true };
  const cached = g.__forkingPathsHealthPing;
  if (cached && now - cached.at < DB_PING_CACHE_MS) return cached.result;

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: DatabaseHealth;
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DB_PING_TIMEOUT_MS);
      }),
    ]);
    result = { kind: "mongodb", ok: true, ms: Date.now() - started };
  } catch (error) {
    // The driver's message can name hosts; report only what kind of failure it was.
    const timedOut = error instanceof Error && error.message === "timeout";
    result = { kind: "mongodb", ok: false, error: timedOut ? "no answer in time" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  g.__forkingPathsHealthPing = { at: now, result };
  return result;
}

export type HealthOptions = { env?: Env; ping?: DbPing; now?: number };

/**
 * The health report and its HTTP status: 200 when `ok`, else 503. A missing model key does not
 * fail the check (the desk demo still works, and a restart would not fix it); a database that does
 * not answer does, so a host stops sending players to an instance that cannot save their walk.
 */
export async function healthReport(opts: HealthOptions = {}): Promise<{ status: number; body: HealthReport }> {
  const env = opts.env ?? process.env;
  const models = Object.fromEntries(ROLES.map((role) => [role, roleHealth(role, env)])) as Record<Role, RoleHealth>;
  const database = await databaseHealth(env, opts.ping ?? mongoPing(env), opts.now ?? Date.now());
  const voice = voiceConfig(env);
  const commit = env.RENDER_GIT_COMMIT?.trim();

  const body: HealthReport = {
    ok: database.ok,
    ready: ROLES.every((role) => models[role].ok),
    app: APP_SLUG,
    commit: commit ? commit.slice(0, 7) : null,
    models,
    database,
    services: {
      google: has(env, "GOOGLE_GENERATIVE_AI_API_KEY"),
      serpapi: has(env, "SERPAPI_API_KEY"),
      voice: { configured: has(env, "ELEVENLABS_API_KEY") && voice.voiceId !== null, live: voice.live },
      sentry: has(env, "SENTRY_DSN") || has(env, "NEXT_PUBLIC_SENTRY_DSN"),
    },
    caps: Object.fromEntries(BUDGET_SERVICES.map((s) => [s, budgetCap(s, env)])) as Record<BudgetService, number>,
  };
  return { status: body.ok ? 200 : 503, body };
}
