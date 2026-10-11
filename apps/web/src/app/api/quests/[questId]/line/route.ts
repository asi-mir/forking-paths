import { speakDetailed, spokenLine } from "@/lib/voice";
import { QuestLineRequestSchema, type QuestLineResponse } from "@/quest/api";
import { lineText } from "@/quest/quest-view";
import { loadQuest } from "@/quest/run-service";
import { apiError, BodyTooLarge, errorResponse, json, readJson } from "@/quest/run-http";

/** Why a line is text only, in words the desk preview can show. */
const WHY: Record<string, string> = {
  "no-voice": "Voice is not set up on this server, so lines show as text.",
  "no-key": "Voice is not set up on this server, so lines show as text.",
  "not-live": "New voice lines are off on this server, so this one shows as text.",
  "over-cap": "Today's voice budget is used up, so lines show as text.",
  error: "The voice did not answer, so this line shows as text.",
};

/**
 * POST /api/quests/[questId]/line { key }: one line of a quest, voiced on request. A line voiced
 * before costs nothing; a new one takes its characters from today's voice budget first, and over
 * the cap (or with voice off) the answer is the text alone. No other line is voiced.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/quests/[questId]/line">): Promise<Response> {
  const { questId } = await ctx.params;
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return apiError("The request is too large.", "bad-request", 413);
    throw error;
  }
  const parsed = QuestLineRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("Send { key } as JSON.", "bad-request", 400);
  try {
    const quest = await loadQuest(questId);
    const text = lineText(quest, parsed.data.key);
    if (!text) return apiError("This quest has no such line.", "not-found", 404);
    const said = await speakDetailed(text, { lang: quest.lang });
    const out: QuestLineResponse = said.clipId
      ? { line: spokenLine(text, said.clipId), voice: "on" }
      : { line: spokenLine(text), voice: "off", reason: WHY[said.reason ?? "error"] };
    return json(out);
  } catch (error) {
    return errorResponse(error, "POST /api/quests/[questId]/line");
  }
}
