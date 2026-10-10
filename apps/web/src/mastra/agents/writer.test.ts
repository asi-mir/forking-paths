import { Agent } from "@mastra/core/agent";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { routeOptions } from "@/quest/plan";
import { threeStop } from "@/quest/__fixtures__";
import { CUES } from "@/quest/schema";
import { repairPrompt, WRITER_INSTRUCTIONS, writeDraft, writerPrompt } from "./writer";

const OLLAMA_ENV = { GEMMA_PROVIDER: "ollama" };

function promptFor(minutes: 15 | 25 = 15, lang: "en" | "tr" = "en") {
  const fx = threeStop();
  const options = routeOptions(fx.candidates, fx.opts.center, 15);
  return { fx, options, prompt: writerPrompt({ center: fx.opts.center, minutes, lang, candidates: fx.candidates, facts: fx.facts, options }) };
}

/** A Mastra agent on a mock model that answers with `text`. */
function mockAgent(text: string) {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-gemma",
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { agent: new Agent({ id: "writer-test", name: "Writer test", instructions: WRITER_INSTRUCTIONS, model }), calls };
}

describe("writerPrompt", () => {
  it("lists the places with their fact IDs, the route options, the cue list and the example", () => {
    const { fx, options, prompt } = promptFor();
    for (const id of new Set(options.flatMap((o) => o.places))) {
      expect(prompt).toContain(`- ${id} ${fx.candidates.find((c) => c.id === id)!.name}`);
    }
    for (const f of fx.facts.filter((f) => f.placeId && options[0].places.includes(f.placeId))) {
      expect(prompt).toContain(`${f.id}: ${f.text}`);
    }
    expect(prompt).toContain("Option 1");
    expect(prompt).toContain(CUES.join(", "));
    expect(prompt).toContain("3 stops, one fork");
    expect(prompt).toContain("The Secret of the Braided Stairs"); // the Karaköy example
    expect(prompt).toContain("Write every spoken line in English.");
  });

  it("asks for Turkish lines with English keys and cues", () => {
    expect(promptFor(15, "tr").prompt).toContain("in Turkish. Keep JSON keys, IDs and cues in English.");
  });

  it("describes the two-fork shape for 25 minutes", () => {
    expect(promptFor(25).prompt).toContain("4 stops, two forks");
  });

  it("the repair prompt carries the draft and every error", () => {
    const p = repairPrompt("BASE", { title: "x" }, ["first error", "second error"]);
    expect(p).toMatch(/^BASE/);
    expect(p).toContain('{"title":"x"}');
    expect(p).toContain("- first error\n- second error");
  });

  it("the instructions carry the safety and grounding rules", () => {
    expect(WRITER_INSTRUCTIONS).toMatch(/never compass words/);
    expect(WRITER_INSTRUCTIONS).toMatch(/never ask them to photograph people/);
    expect(WRITER_INSTRUCTIONS).toMatch(/cite the IDs of the facts/);
  });
});

describe("writeDraft", () => {
  it("returns the structured object from the Mastra agent, with usage", async () => {
    const draft = threeStop().writer;
    const { agent, calls } = mockAgent(JSON.stringify(draft));
    const res = await writeDraft("prompt", { agent, env: OLLAMA_ENV });
    expect(res.draft).toEqual(draft);
    expect(res.provider).toBe("ollama");
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(40);
    // Thinking setting reaches the model as provider options.
    expect(JSON.stringify(calls[0])).toContain("reasoningEffort");
  });

  it("pulls JSON out of a fenced answer that does not match the schema, for the validator to check", async () => {
    const { agent } = mockAgent('Here it is:\n```json\n{"title": "Only a title"}\n```');
    const res = await writeDraft("prompt", { agent, env: OLLAMA_ENV });
    expect(res.draft).toEqual({ title: "Only a title" });
  });

  it("returns null when the answer holds no JSON", async () => {
    const { agent } = mockAgent("I cannot do that.");
    const res = await writeDraft("prompt", { agent, env: OLLAMA_ENV });
    expect(res.draft).toBeNull();
  });

  it("throws when the call is cancelled", async () => {
    const { agent } = mockAgent("{}");
    const controller = new AbortController();
    controller.abort();
    await expect(writeDraft("prompt", { agent, env: OLLAMA_ENV, signal: controller.signal })).rejects.toThrow();
  });
});
