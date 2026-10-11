/**
 * Shared plumbing for the eval scripts (`scripts/eval-*.ts`): env, flags, where reports go, and
 * reading generated quests (MongoDB databases and `generate-quest.ts --out` records).
 * Scripts run from apps/web.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MongoClient } from "mongodb";
import { fromPoint, type GeoPoint } from "../src/lib/geo";
import { PathStepSchema, QuestSchema, type PathStep, type Quest } from "../src/quest/schema";

// ---------------------------------------------------------------------------
// Env and flags

/** Loads .env.local; variables already set (MONGODB_DB=…, GEMMA_PROVIDER=…) win. */
export function loadEnv(): void {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
}

const argv = process.argv.slice(2);
export const flag = (name: string) => argv.includes(`--${name}`);
export function option(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
export const listOption = (name: string) => option(name)?.split(",").map((s) => s.trim()).filter(Boolean);
export const numberOption = (name: string, fallback: number) => {
  const v = Number(option(name));
  return Number.isFinite(v) && option(name) !== undefined ? v : fallback;
};

/** Today's date in the machine's time zone, YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Reports

/**
 * Writes `<out-dir>/<date>-<name>.md` and `.json` (default out-dir: eval/runs, git-ignored).
 * Flags: --out-dir <dir>, --date YYYY-MM-DD.
 */
export function writeReport(name: string, markdown: string, data: unknown): { md: string; json: string } {
  const dir = resolve(option("out-dir") ?? "eval/runs");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${option("date") ?? today()}-${name}`);
  writeFileSync(`${base}.md`, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  writeFileSync(`${base}.json`, `${JSON.stringify(data, null, 2)}\n`);
  return { md: `${base}.md`, json: `${base}.json` };
}

/** The command line the report was made with (no secrets ever reach argv). */
export const commandLine = () => `pnpm exec tsx ${process.argv.slice(1).map((a) => a.replace(process.cwd() + "/", "")).join(" ")}`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Generated quests

/** One quest generation: a record from generate-quest.ts, a stored quest, or both. */
export type Generation = {
  id: string; // quest id, or the record file name for a generation that saved no quest
  source: string; // where it was read from
  createdAt?: string;
  center?: { lat: number; lng: number };
  minutes?: number;
  writer?: string;
  status: "ready" | "failed" | "no-draft";
  validation?: { firstTryOk: boolean; firstTryErrors: string[]; repaired: boolean };
  finalErrors: string[];
  error?: string;
  quest?: Quest;
  demo: boolean;
};

/** Databases to read: --dbs a,b (or "all": every forking-paths* database); default MONGODB_DB. */
export async function databaseNames(client: MongoClient): Promise<string[]> {
  const want = listOption("dbs");
  if (want && !(want.length === 1 && want[0] === "all")) return want;
  if (!want) return [process.env.MONGODB_DB?.trim() || "forking-paths"];
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  return databases.map((d) => d.name).filter((n) => n.startsWith("forking-paths")).sort();
}

export type Sources = { quests: Quest[]; runs: Array<{ questId: string; path: PathStep[]; db: string }>; dbs: string[] };

/** Quests (any status) and walked paths from the databases. No MONGODB_URI: none. */
export async function readDatabases(): Promise<Sources> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return { quests: [], runs: [], dbs: [] };
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  try {
    const dbs = await databaseNames(client);
    const quests = new Map<string, Quest>();
    const runs: Sources["runs"] = [];
    // Plain reads (no store): opening a store would create indexes in other databases.
    for (const db of dbs) {
      for (const doc of await client.db(db).collection("quests").find({}).toArray()) {
        const { _id, center, createdAt, ...rest } = doc as unknown as { _id: string; center: GeoPoint; createdAt: Date } & Record<string, unknown>;
        const parsed = QuestSchema.safeParse({
          ...rest,
          id: String(_id),
          center: fromPoint(center),
          ...(createdAt instanceof Date ? { createdAt: createdAt.toISOString() } : {}),
        });
        if (parsed.success && !quests.has(parsed.data.id!)) quests.set(parsed.data.id!, parsed.data);
      }
      for (const r of await client.db(db).collection("runs").find({}, { projection: { questId: 1, path: 1 } }).toArray()) {
        const path = PathStepSchema.array().safeParse(r.path);
        if (path.success && typeof r.questId === "string") runs.push({ questId: r.questId, path: path.data, db });
      }
    }
    return { quests: [...quests.values()], runs, dbs };
  } finally {
    await client.close();
  }
}

type RecordFile = {
  input?: { lat?: number; lng?: number; minutes?: number };
  createdAt?: string;
  status?: string;
  error?: string;
  output?: {
    status?: "ready" | "failed";
    questId?: string;
    validation?: Generation["validation"];
    errors?: string[];
    model?: { writer?: string; provider?: string };
  };
  quest?: unknown;
};

/** A record's error: generate-quest.ts stores the workflow error as JSON ({"message": …}) or text. */
function errorText(error: string | undefined): string | undefined {
  if (!error) return undefined;
  try {
    const parsed = JSON.parse(error) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : error;
  } catch {
    return error;
  }
}

/** Generation records and quest dumps (*.json) in --records <dir>. */
export function readRecords(dir: string | undefined): { records: Array<RecordFile & { file: string }>; quests: Quest[] } {
  if (!dir || !existsSync(dir)) return { records: [], quests: [] };
  const records: Array<RecordFile & { file: string }> = [];
  const quests: Quest[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    if ("input" in raw) {
      records.push({ ...(raw as RecordFile), file });
      const q = QuestSchema.safeParse(raw.quest);
      if (q.success) quests.push(q.data);
    } else {
      const q = QuestSchema.safeParse(raw);
      if (q.success) quests.push(q.data);
    }
  }
  return { records, quests };
}

/**
 * Every generation once: records first (they include failed generations, which save no quest),
 * then stored quests no record names. The desk demo quest is marked `demo` (drafted by its own
 * script and edited by hand, so evals of generated quests leave it out).
 */
export function generations(sources: Sources, recordsDir: string | undefined): Generation[] {
  const { records, quests: dumped } = readRecords(recordsDir);
  const byId = new Map<string, Quest>();
  for (const q of [...dumped, ...sources.quests]) if (q.id && !byId.has(q.id)) byId.set(q.id, q);
  const out: Generation[] = [];
  const named = new Set<string>();
  for (const r of records) {
    const qid = r.output?.questId;
    if (qid) named.add(qid);
    const quest = qid ? byId.get(qid) : undefined;
    const base = {
      source: `record ${r.file}`,
      createdAt: r.createdAt,
      center: r.input?.lat !== undefined && r.input?.lng !== undefined ? { lat: r.input.lat, lng: r.input.lng } : undefined,
      minutes: r.input?.minutes,
      quest,
      demo: false,
    };
    if (!r.output) {
      out.push({ ...base, id: r.file, status: "no-draft", finalErrors: [], error: errorText(r.error) ?? `workflow ${r.status}` });
      continue;
    }
    out.push({
      ...base,
      id: qid ?? r.file,
      writer: r.output.model?.writer,
      status: r.output.status ?? "failed",
      validation: r.output.validation,
      finalErrors: r.output.errors ?? [],
    });
  }
  for (const q of byId.values()) {
    if (named.has(q.id!)) continue;
    out.push({
      id: q.id!,
      source: "stored quest",
      createdAt: q.createdAt,
      center: q.center,
      minutes: q.minutes,
      writer: q.model?.writer,
      status: q.status,
      validation: q.validation,
      finalErrors: [],
      quest: q,
      demo: q.demo === true || q.id === "demo-karakoy",
    });
  }
  return out;
}

/** A rough place label for a quest centre (the tested cities), for the tables. */
export function cityOf(center: { lat: number; lng: number } | undefined): string {
  if (!center) return "?";
  const cities: Array<[string, number, number]> = [
    ["Istanbul", 41.02, 28.98],
    ["Rome", 41.9, 12.48],
    ["Prague", 50.08, 14.43],
    ["Mexico City", 19.43, -99.13],
    ["Nairobi", -1.29, 36.82],
    ["Lisbon", 38.72, -9.14],
    ["London", 51.51, -0.12],
    ["New York", 40.73, -73.99],
  ];
  let best: [string, number] = ["elsewhere", Infinity];
  for (const [name, lat, lng] of cities) {
    const d = Math.hypot(center.lat - lat, center.lng - lng);
    if (d < best[1]) best = [name, d];
  }
  return best[1] < 0.5 ? best[0] : `${center.lat.toFixed(2)}, ${center.lng.toFixed(2)}`;
}
