import { questView } from "@/quest/quest-view";
import { loadQuest } from "@/quest/run-service";
import { apiError, errorResponse, json } from "@/quest/run-http";

/** GET /api/quests/[questId]: a saved quest as the desk demo shows it (lines, forks, facts with links). */
export async function GET(_request: Request, ctx: RouteContext<"/api/quests/[questId]">): Promise<Response> {
  const { questId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(questId)) return apiError("That quest does not exist.", "not-found", 404);
  try {
    const quest = await loadQuest(questId);
    return json(questView({ ...quest, id: quest.id ?? questId }));
  } catch (error) {
    return errorResponse(error, "GET /api/quests/[questId]");
  }
}
