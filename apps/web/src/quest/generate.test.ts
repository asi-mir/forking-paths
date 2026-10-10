import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/store/memory";
import type { WriterCall } from "@/mastra/agents/writer";
import { generateQuestWorkflow } from "@/mastra/workflows/generate-quest";
import { research } from "@/research";
import { KARAKOY, testDeps } from "@/research/__fixtures__";
import generatedDraft from "./__fixtures__/karakoy-generated-draft.json";
import { WRITER_GOOGLE_TIMEOUT_MS } from "@/mastra/agents/writer";
import { TIMEOUT_MS } from "@/play/client";
import { QUEST_CLIENT_TIMEOUT_MS, QUEST_DEADLINE_MS } from "./api";
import { GenerateError, generateQuestDirect, MIN_REPAIR_MS, rateLimitWaitMs, setGenerateDeps } from "./generate";
import { citationErrors } from "@/lib/store";

/**
 * The generate-quest steps on recorded Karaköy research (no network) and a scripted writer.
 * The draft is the first draft Gemma 4 31B wrote for this research on 2026-10-10.
 */

const draft = () => structuredClone(generatedDraft);

function call(d: unknown, latencyMs = 1000): WriterCall {
  return { draft: d, provider: "google", model: "gemma-4-31b-it", thinking: "high", latencyMs, inputTokens: 3690, outputTokens: 1156, reasoningTokens: 0 };
}

/** Deps: recorded research, a writer that answers `drafts` in order, a fresh memory store. */
function setup(drafts: unknown[]) {
  const store = createMemoryStore();
  const prompts: string[] = [];
  const maxMs: number[] = [];
  const { deps } = testDeps({ store });
  setGenerateDeps({
    research: (input) => research(input, deps),
    write: async (prompt, opts) => {
      prompts.push(prompt);
      maxMs.push(opts.maxMs);
      if (!drafts.length) throw new Error("no more drafts");
      return call(drafts.shift());
    },
    store: () => store,
  });
  return { store, prompts, maxMs };
}

const INPUT = { ...KARAKOY, minutes: 15 as const, lang: "en" as const, timeZone: "Europe/Istanbul" };

afterEach(() => setGenerateDeps(undefined));

describe("generate-quest steps", () => {
  it("saves a first-try quest with its validation record, model, timings, SerpApi count and a rounded centre", async () => {
    const { store, prompts } = setup([draft()]);
    const out = await generateQuestDirect(INPUT);
    expect(out.status).toBe("ready");
    expect(out.validation).toEqual({ firstTryOk: true, firstTryErrors: [], repaired: false });
    expect(prompts).toHaveLength(1);
    expect(out.serpapiSearches).toBeLessThanOrEqual(6);

    const q = (await store.getQuest(out.questId!))!;
    expect(q.center).toEqual({ lat: 41.025, lng: 28.974 });
    expect(q.validation.firstTryOk).toBe(true);
    expect(q.model).toEqual({ provider: "google", writer: "gemma-4-31b-it" });
    expect(q.timings?.writeMs).toBe(1000);
    expect(q.serpapiSearches).toBe(out.serpapiSearches);
    expect(q.stopsPerRun).toBe(3);
    expect(citationErrors(q)).toEqual([]);
    // Every fact the quest carries has its source, query and link.
    for (const f of q.facts) {
      expect(f.sourceUrl).toMatch(/^https?:\/\//);
      expect(f.query.length).toBeGreaterThan(0);
    }
  });

  it("sends the validator's errors back once and records the repair", async () => {
    const bad = draft();
    bad.places[0].clue = "Cross the road to the north and enter the courtyard of the tower, then photograph the people by the door.";
    const { store, prompts } = setup([bad, draft()]);
    const out = await generateQuestDirect(INPUT);
    expect(out.status).toBe("ready");
    expect(out.validation.firstTryOk).toBe(false);
    expect(out.validation.repaired).toBe(true);
    expect(out.validation.firstTryErrors.join("\n")).toMatch(/across a road/);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("The validator rejected it:");
    for (const e of out.validation.firstTryErrors) expect(prompts[1]).toContain(e);
    expect((await store.getQuest(out.questId!))!.validation.repaired).toBe(true);
  });

  it("fails without saving when the repaired draft fails too", async () => {
    const bad = draft();
    bad.mystery.factIds = ["F999"];
    const { store } = setup([bad, structuredClone(bad)]);
    const out = await generateQuestDirect(INPUT);
    expect(out.status).toBe("failed");
    expect(out.questId).toBeUndefined();
    expect(out.errors.join("\n")).toMatch(/F999/);
    expect(out.validation).toMatchObject({ firstTryOk: false, repaired: false });
    expect(await store.questsNear(KARAKOY.lat, KARAKOY.lng, 1, { status: "any" })).toEqual([]);
  });

  it("treats an answer with no JSON as a failed first try", async () => {
    setup([null, draft()]);
    const out = await generateQuestDirect(INPUT);
    expect(out.status).toBe("ready");
    expect(out.validation.firstTryErrors).toEqual(["The answer was not a JSON object."]);
  });

  it("stops before the writer when no route fits (too few places close together)", async () => {
    const { prompts } = setup([draft()]);
    const store = createMemoryStore();
    const { deps } = testDeps({ store });
    setGenerateDeps({
      research: async (input) => {
        const r = await research(input, deps);
        return { ...r, candidates: r.candidates.slice(0, 2) };
      },
      write: async () => call(draft()),
      store: () => store,
    });
    await expect(generateQuestDirect(INPUT)).rejects.toBeInstanceOf(GenerateError);
    expect(prompts).toHaveLength(0);
  });

  it("caps each writer call at the time left of the deadline", async () => {
    const bad = draft();
    bad.mystery.factIds = ["F999"];
    const { maxMs } = setup([bad, draft()]);
    const out = await generateQuestDirect({ ...INPUT, deadlineMs: 200_000 });
    expect(out.status).toBe("ready");
    expect(maxMs).toHaveLength(2);
    expect(maxMs[0]).toBeLessThanOrEqual(200_000);
    expect(maxMs[0]).toBeGreaterThan(MIN_REPAIR_MS);
    expect(maxMs[1]).toBeLessThanOrEqual(maxMs[0]);
  });

  it("skips the repair when too little of the deadline is left, and fails without saving", async () => {
    const bad = draft();
    bad.mystery.factIds = ["F999"];
    const { store, prompts } = setup([bad, draft()]);
    const out = await generateQuestDirect({ ...INPUT, deadlineMs: MIN_REPAIR_MS - 1_000 });
    expect(out.status).toBe("failed");
    expect(prompts).toHaveLength(1);
    expect(out.validation).toMatchObject({ firstTryOk: false, repaired: false });
    expect(out.errors.join("\n")).toMatch(/F999/);
    expect(out.errors.at(-1)).toMatch(/^No repair: \d+ s of the time limit were left\.$/);
    expect(await store.questsNear(KARAKOY.lat, KARAKOY.lng, 1, { status: "any" })).toEqual([]);
  });

  it("waits once for a rate-limited writer call when the deadline leaves room, then writes", async () => {
    const quota = Object.assign(new Error("You exceeded your current quota. Please retry in 0.01s."), { statusCode: 429 });
    const store = createMemoryStore();
    const { deps } = testDeps({ store });
    let calls = 0;
    setGenerateDeps({
      research: (input) => research(input, deps),
      write: async () => {
        calls++;
        if (calls === 1) throw quota;
        return call(draft());
      },
      store: () => store,
    });
    const out = await generateQuestDirect(INPUT);
    expect(out.status).toBe("ready");
    expect(calls).toBe(2);
  });

  it("does not wait for a rate limit that would leave too little of the deadline", async () => {
    const store = createMemoryStore();
    const { deps } = testDeps({ store });
    let calls = 0;
    setGenerateDeps({
      research: (input) => research(input, deps),
      write: async () => {
        calls++;
        throw Object.assign(new Error("You exceeded your current quota. Please retry in 50s."), { statusCode: 429 });
      },
      store: () => store,
    });
    await expect(generateQuestDirect({ ...INPUT, deadlineMs: 90_000 })).rejects.toMatchObject({ code: "writer-failed" });
    expect(calls).toBe(1);
  });

  it("reads the wait from a rate-limit message; other errors are not rate limits", () => {
    expect(rateLimitWaitMs(new Error("You exceeded your current quota ... Please retry in 46.10596699s."))).toBe(47_106);
    expect(rateLimitWaitMs(Object.assign(new Error("Too many requests"), { statusCode: 429 }))).toBe(30_000);
    expect(rateLimitWaitMs(new Error("Internal error encountered."))).toBeNull();
  });

  it("wraps a writer failure as a GenerateError", async () => {
    setup([]);
    await expect(generateQuestDirect(INPUT)).rejects.toMatchObject({ code: "writer-failed" });
  });
});

describe("generate-quest Mastra workflow", () => {
  it("runs research → write → validate → save", async () => {
    const { store } = setup([draft()]);
    const run = await generateQuestWorkflow.createRun();
    const result = await run.start({ inputData: INPUT });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.result.status).toBe("ready");
    expect(Object.keys(result.steps)).toEqual(expect.arrayContaining(["research", "write", "validate", "save"]));
    expect(await store.getQuest(result.result.questId!)).not.toBeNull();
  });

  it("ends as failed with the step's error code when research finds too little", async () => {
    const store = createMemoryStore();
    const { deps } = testDeps({ store });
    setGenerateDeps({
      research: async (input) => ({ ...(await research(input, deps)), candidates: [] }),
      write: async () => call(draft()),
      store: () => store,
    });
    const run = await generateQuestWorkflow.createRun();
    const result = await run.start({ inputData: INPUT });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect((result.error as { code?: string }).code).toBe("few-places");
  });
});

describe("quest time limits", () => {
  it("the phone waits longer than the server's whole deadline", () => {
    expect(TIMEOUT_MS.quest).toBe(QUEST_CLIENT_TIMEOUT_MS);
    // Margin for the save, the answer and a slow phone network.
    expect(QUEST_CLIENT_TIMEOUT_MS - QUEST_DEADLINE_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("the deadline fits slow research and one full Google writer call", () => {
    // Research took up to 32 s (cold cache) in the logged runs.
    expect(QUEST_DEADLINE_MS).toBeGreaterThanOrEqual(32_000 + WRITER_GOOGLE_TIMEOUT_MS);
    expect(MIN_REPAIR_MS).toBeLessThan(QUEST_DEADLINE_MS);
  });
});
