import { runGenerateQuest } from "@/mastra/generate";
import { createQuest, tracedGeneration } from "@/quest/create";
import { DEMO_QUEST_ID } from "@/quest/demo";
import { loadQuest } from "@/quest/run-service";

/**
 * POST /api/quests { lat, lng, minutes, lang, timeZone? } → { questId, reused, overCap?, distanceM? }.
 * Reuses a saved quest within ~500 m; otherwise, within today's cap, runs the Mastra workflow
 * generate-quest. Runs on the Node runtime (the default; with cacheComponents on, the `runtime`
 * segment option is not allowed), which Sentry's Mastra integration needs.
 */

const generate = tracedGeneration(runGenerateQuest);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON body: { lat, lng, minutes, lang }.", code: "bad-request" }, { status: 400 });
  }
  // The desk demo's case counts as saved from the first request on: on an empty database,
  // "Generate a quest near me" in Karaköy reuses it instead of writing a new one.
  await loadQuest(DEMO_QUEST_ID).catch(() => undefined);
  const result = await createQuest(body, { generate });
  return Response.json(result.body, { status: result.status });
}
