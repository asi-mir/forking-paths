import { FinishRequestSchema } from "@/quest/api";
import { finishWalk } from "@/quest/run-service";
import { apiError, BodyTooLarge, errorResponse, json, readJson } from "@/quest/run-http";

/** POST /api/runs/[runId]/finish { receipt }: saves screen-on time, pocket time, peeks and the score. */
export async function POST(request: Request, ctx: RouteContext<"/api/runs/[runId]/finish">): Promise<Response> {
  const { runId } = await ctx.params;
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return apiError("The request is too large.", "bad-request", 413);
    throw error;
  }
  const parsed = FinishRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("Send { receipt: { screenOnMs, pocketMs, peeks } } as JSON.", "bad-request", 400);
  try {
    return json(await finishWalk(runId, parsed.data.receipt));
  } catch (error) {
    return errorResponse(error, "POST /api/runs/[runId]/finish");
  }
}
