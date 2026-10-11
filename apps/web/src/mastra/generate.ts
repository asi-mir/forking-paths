import type { RunGeneration } from "@/quest/create";
import { roundCenter } from "@/lib/geo";
import { mastraTracing } from "@/lib/trace";
import { mastra } from "./index";

/**
 * Runs the generate-quest workflow on the Mastra instance and flattens its result: the output,
 * or the failed step's message and code ("few-places", "writer-failed"). The centre is rounded to
 * ~100 m first, because Mastra stores a run's input (snapshots, traces).
 */
export const runGenerateQuest: RunGeneration = async (input) => {
  const run = await mastra.getWorkflow("generateQuest").createRun();
  const center = roundCenter(input);
  const result = await run.start({ inputData: { ...input, ...center, lang: input.lang ?? "en" }, tracingOptions: mastraTracing({ role: "writer" }) });
  if (result.status === "success") return { ok: true, output: result.result };
  const err = (result.status === "failed" ? result.error : undefined) as { message?: string; code?: string } | undefined;
  return {
    ok: false,
    message: err?.message ?? `The quest workflow ended as ${result.status}.`,
    ...(typeof err?.code === "string" ? { code: err.code } : {}),
  };
};
