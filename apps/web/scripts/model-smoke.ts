/**
 * Smoke test for the Gemma provider switch. For each provider (google, ollama) it runs:
 *   1. json        generateJson (writer): a zod-validated object
 *   2. tool        a Mastra Agent calls a fake `echo` tool (proves Mastra takes our model)
 *   3. image       generateJson (reader) with a generated solid-colour PNG: "what colour?"
 *   4. tool+json   one generateText call with a tool AND a JSON output schema together
 * and prints latency and token usage. Optional: --thinking-sweep times a quest-sized writer
 * answer at each thinking level.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/model-smoke.ts [--provider google|ollama|all] [--out <dir>] [--thinking-sweep]
 *
 * A provider that is not configured is skipped ("skipped: NAME not set"), never failed.
 * Exit code 1 only when a configured provider fails the json, tool or image check.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { generateJson, type ModelCallMeta } from "../src/lib/json";
import {
  DEFAULT_MODELS,
  getModel,
  modelLabel,
  providerOptionsFor,
  resolveModelConfig,
  type Provider,
  type ThinkingLevel,
} from "../src/lib/model";
import { solidPng } from "../src/lib/solid-png";

type Env = Record<string, string | undefined>;

interface CheckResult {
  name: string;
  ok: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
  note: string;
}

// ---- args and env -----------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const secretValues = ["GOOGLE_GENERATIVE_AI_API_KEY"]
  .map((name) => process.env[name])
  .filter((v): v is string => Boolean(v && v.length > 8));

/** Never let a key reach the console or a report. */
function redact(text: string): string {
  return secretValues.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

function envFor(provider: Provider, extra: Env = {}): Env {
  return {
    ...process.env,
    GEMMA_PROVIDER: provider,
    GEMMA_WRITER_PROVIDER: provider,
    GEMMA_READER_PROVIDER: provider,
    GEMMA_NARRATOR_PROVIDER: provider,
    ...extra,
  };
}

function errorText(error: unknown): string {
  const e = error as { message?: string; responseBody?: string; cause?: { responseBody?: string; message?: string } };
  const body = e.responseBody ?? e.cause?.responseBody;
  const message = e.message ?? String(error);
  return redact(body ? `${message} | ${body.slice(0, 400)}` : message).replace(/\s+/g, " ");
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

// ---- checks -------------------------------------------------------------------------------

async function checkJson(env: Env): Promise<CheckResult> {
  const config = resolveModelConfig("writer", env);
  const schema = z.object({
    title: z.string().min(1),
    clues: z.array(z.string().min(1)).length(3),
  });
  try {
    const { data, meta } = await generateJson(
      "writer",
      schema,
      "Write a title and exactly three one-sentence clues for a tiny walking mystery about an old " +
        'drinking fountain. Answer as JSON: {"title": string, "clues": [string, string, string]}.',
      undefined,
      { env },
    );
    return fromMeta("json", meta, true, `title="${data.title.slice(0, 60)}"; repaired=${meta.repaired}`);
  } catch (error) {
    return failed("json", modelLabel(config), error);
  }
}

async function checkTool(env: Env): Promise<CheckResult> {
  const config = resolveModelConfig("narrator", env);
  let executed = 0;
  const echo = createTool({
    id: "echo",
    description: "Returns the text it is given, unchanged.",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async ({ text }) => {
      executed++;
      return { echoed: text };
    },
  });
  const agent = new Agent({
    id: "smoke-echo",
    name: "Smoke echo",
    instructions: "You test tools. When asked to use a tool, call it, then report its result briefly.",
    model: getModel("narrator", env),
    tools: { echo },
  });
  try {
    const { value: res, ms } = await timed(() =>
      agent.generate("Call the echo tool with the text 'forking paths', then tell me what it returned.", {
        maxSteps: 3,
        providerOptions: providerOptionsFor(config),
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      }),
    );
    const calls = (res.toolCalls ?? []).map((c) => {
      const p = (c as { payload?: { toolName?: string; args?: unknown } }).payload ?? (c as { toolName?: string; args?: unknown });
      return { name: p.toolName, args: JSON.stringify(p.args ?? "") };
    });
    const ok = executed > 0 && calls.some((c) => c.name === "echo" && /forking paths/i.test(c.args));
    return {
      name: "tool (Mastra agent)",
      ok,
      latencyMs: ms,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      model: modelLabel(config),
      note: `echo executed ${executed}x; calls=${JSON.stringify(calls)}; reply="${redact(res.text ?? "").slice(0, 80).replace(/\s+/g, " ")}"`,
    };
  } catch (error) {
    return failed("tool (Mastra agent)", modelLabel(config), error);
  }
}

const COLOURS: Record<string, [number, number, number]> = {
  red: [220, 20, 20],
  green: [20, 170, 40],
  blue: [20, 60, 220],
  yellow: [240, 220, 20],
};

async function checkImage(env: Env): Promise<CheckResult> {
  const config = resolveModelConfig("reader", env);
  const names = Object.keys(COLOURS);
  const colour = names[Math.floor(Math.random() * names.length)];
  const png = solidPng(64, 64, COLOURS[colour]);
  try {
    const { data, meta } = await generateJson(
      "reader",
      z.object({ colour: z.string() }),
      'What single colour fills this image? Answer as JSON: {"colour": "<one lowercase word>"}.',
      [{ data: png, mediaType: "image/png" }],
      { env },
    );
    const ok = data.colour.toLowerCase().includes(colour);
    return fromMeta("image", meta, ok, `sent ${colour} PNG (${png.byteLength} B); model said "${data.colour}"`);
  } catch (error) {
    return failed("image", modelLabel(config), error);
  }
}

async function checkToolAndJson(env: Env): Promise<CheckResult> {
  const config = resolveModelConfig("writer", env);
  let executed = 0;
  try {
    const { value: res, ms } = await timed(() =>
      generateText({
        model: getModel("writer", env),
        tools: {
          echo: tool({
            description: "Returns the text it is given, unchanged.",
            inputSchema: z.object({ text: z.string() }),
            execute: async ({ text }) => {
              executed++;
              return { echoed: text };
            },
          }),
        },
        output: Output.object({ schema: z.object({ echoed: z.string(), wordCount: z.number() }) }),
        stopWhen: stepCountIs(4),
        include: { requestBody: true },
        prompt:
          "Call the echo tool with the text 'paths that fork'. Then answer with JSON: the echoed text " +
          "and how many words it has.",
        providerOptions: providerOptionsFor(config),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      }),
    );
    const first = res.steps[0]?.request?.body;
    const body = typeof first === "string" ? first : JSON.stringify(first ?? {});
    const sentTools = /"tools"/.test(body);
    const sentSchema = /responseJsonSchema|responseSchema|"response_format"|json_schema/.test(body);
    const ok = executed > 0 && /paths that fork/i.test(res.output.echoed);
    return {
      name: "tool + JSON schema, one call",
      ok,
      latencyMs: ms,
      inputTokens: res.totalUsage.inputTokens,
      outputTokens: res.totalUsage.outputTokens,
      model: modelLabel(config),
      note: `first request had tools=${sentTools} schema=${sentSchema}; steps=${res.steps.length}; echo executed ${executed}x; output=${JSON.stringify(res.output)}`,
    };
  } catch (error) {
    return failed("tool + JSON schema, one call", modelLabel(config), error, `echo executed ${executed}x`);
  }
}

// A quest-sized writer answer, to time each thinking level. The facts are placeholders.
const QUEST_SCHEMA = z.object({
  title: z.string(),
  mystery: z.string(),
  stops: z
    .array(
      z.object({
        placeId: z.string(),
        clue: z.string(),
        reveal: z.string(),
        factIds: z.array(z.string()),
      }),
    )
    .min(4)
    .max(6),
  finale: z.string(),
});

const QUEST_PROMPT = `You write short walking mysteries. Use only these facts and places.
Places: P1 "Old fountain", P2 "Clock tower", P3 "Corner bakery", P4 "Stone bridge", P5 "Library steps".
Facts:
F1 (P1) The fountain was built by the town council.
F2 (P2) The clock tower has four faces.
F3 (P3) The bakery has a carved wooden sign.
F4 (P4) The bridge crosses a small canal.
F5 (P5) The library steps face east.
F6 (P2) The tower bell rings on the hour.
Write a mystery whose answer is P2. Give 5 stops (one per place, P2 last). Each stop has a
clue (at most 30 words, never asking the player to enter a road or photograph people), a
reveal that cites its facts by id in factIds, and a one-sentence finale.
Answer as one JSON object: {"title", "mystery", "stops": [{"placeId","clue","reveal","factIds"}], "finale"}.`;

async function thinkingSweep(provider: Provider): Promise<CheckResult[]> {
  const levels: ThinkingLevel[] = ["minimal", "high"];
  // On Google, time both Gemma 4 sizes so the writer default is chosen from data.
  const models =
    provider === "google"
      ? [...new Set([resolveModelConfig("writer", envFor(provider)).modelId, ...Object.values(DEFAULT_MODELS.google)])]
      : [resolveModelConfig("writer", envFor(provider)).modelId];
  const out: CheckResult[] = [];
  for (const model of models) {
    for (const level of levels) {
      const env = envFor(provider, { GEMMA_WRITER_THINKING: level, GEMMA_WRITER_MODEL: model });
      const config = resolveModelConfig("writer", env);
      const name = `quest-sized writer, thinking=${level}`;
      try {
        const { data, meta } = await generateJson("writer", QUEST_SCHEMA, QUEST_PROMPT, undefined, { env });
        out.push(fromMeta(name, meta, true, `${data.stops.length} stops; repaired=${meta.repaired}`));
      } catch (error) {
        out.push(failed(name, `${modelLabel(config)} (thinking ${level})`, error));
      }
      print(out[out.length - 1]);
    }
  }
  return out;
}

// ---- reporting ------------------------------------------------------------------------------

function fromMeta(name: string, meta: ModelCallMeta, ok: boolean, note: string): CheckResult {
  return {
    name,
    ok,
    latencyMs: meta.latencyMs,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    model: `${meta.provider}/${meta.model} (thinking ${meta.thinking})`,
    note: `${note}; reasoning tokens=${meta.reasoningTokens}; requests=${meta.requests}`,
  };
}

function failed(name: string, model: string, error: unknown, extra = ""): CheckResult {
  const meta = (error as { meta?: ModelCallMeta }).meta;
  return {
    name,
    ok: false,
    latencyMs: meta?.latencyMs ?? 0,
    inputTokens: meta?.inputTokens,
    outputTokens: meta?.outputTokens,
    model,
    note: `${extra ? `${extra}; ` : ""}error: ${errorText(error)}`,
  };
}

function print(r: CheckResult) {
  const tokens = `${r.inputTokens ?? "?"} in / ${r.outputTokens ?? "?"} out`;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(36)} ${String(r.latencyMs).padStart(7)} ms  ${tokens.padEnd(18)} ${r.model}`);
  console.log(`        ${r.note.slice(0, 400)}`);
}

function report(provider: Provider, results: CheckResult[], sweep: CheckResult[]): string {
  const row = (r: CheckResult) =>
    `| ${r.name} | ${r.ok ? "pass" : "FAIL"} | ${r.latencyMs} | ${r.inputTokens ?? "?"} | ${r.outputTokens ?? "?"} | ${r.model} | ${r.note.replace(/\|/g, "\\|").slice(0, 500)} |`;
  const header = "| Check | Result | Latency (ms) | Input tokens | Output tokens | Model | Notes |\n|---|---|---|---|---|---|---|";
  const lines = [
    `## Run ${new Date().toISOString()}`,
    "",
    `- Command: \`pnpm exec tsx scripts/model-smoke.ts --provider ${provider}${sweep.length ? " --thinking-sweep" : ""}\``,
    `- Node ${process.version}`,
    "",
    header,
    ...results.map(row),
  ];
  if (sweep.length) lines.push("", "### Writer thinking sweep (quest-sized answer)", "", header, ...sweep.map(row));
  return redact(lines.join("\n")) + "\n";
}

async function ollamaReachable(env: Env): Promise<string | undefined> {
  const base = resolveModelConfig("reader", envFor("ollama", env)).baseURL!;
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? undefined : `Ollama answered HTTP ${res.status} at ${base}`;
  } catch {
    return `Ollama not reachable at ${base}`;
  }
}

async function main() {
  const which = option("provider") ?? "all";
  const providers: Provider[] = which === "all" ? ["ollama", "google"] : [which as Provider];
  const outDir = option("out");
  let failedAny = false;

  for (const provider of providers) {
    console.log(`\n== ${provider} ==`);
    if (provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
      console.log("skipped: GOOGLE_GENERATIVE_AI_API_KEY not set");
      continue;
    }
    if (provider === "ollama") {
      const why = await ollamaReachable(process.env);
      if (why) {
        console.log(`skipped: ${why}`);
        continue;
      }
    }
    const env = envFor(provider);
    const results: CheckResult[] = [];
    // One at a time: Ollama on a laptop serves one request well, and AI Studio has a low RPM.
    for (const check of [checkJson, checkTool, checkImage, checkToolAndJson]) {
      const r = await check(env);
      results.push(r);
      print(r);
    }
    const sweep = flag("thinking-sweep")
      ? await thinkingSweep(provider)
      : [];
    if (results.slice(0, 3).some((r) => !r.ok)) failedAny = true;

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `${new Date().toISOString().slice(0, 10)}-model-smoke-${provider}.md`);
      // One file per provider and day; each run is appended as its own section.
      const title = `# Model smoke: ${provider}\n\n`;
      const previous = existsSync(file) ? readFileSync(file, "utf8").replace(/\n*$/, "\n\n") : title;
      writeFileSync(file, previous + report(provider, results, sweep));
      console.log(`wrote ${file}`);
    }
  }
  process.exit(failedAny ? 1 : 0);
}

main().catch((error) => {
  console.error(errorText(error));
  process.exit(1);
});
