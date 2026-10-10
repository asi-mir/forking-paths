import { StartRunRequestSchema } from "@/quest/api";
import { beginRun } from "@/quest/run-service";
import { apiError, BodyTooLarge, errorResponse, json, readJson } from "@/quest/run-http";

// Node runtime (the default; with cacheComponents a `runtime` export fails the build).

/** POST /api/runs { questId }: starts a run and voices the quest's lines (text only when voice is off). */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return apiError("The request is too large.", "bad-request", 413);
    throw error;
  }
  const parsed = StartRunRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("Send { questId } as JSON.", "bad-request", 400);
  try {
    return json(await beginRun(parsed.data.questId, request.headers.get("user-agent") ?? undefined));
  } catch (error) {
    return errorResponse(error, "POST /api/runs");
  }
}
