import { connection } from "next/server";
import { healthReport } from "@/lib/health";

/**
 * GET /api/health → `HealthReport` (see `src/lib/health.ts`): the Gemma provider and model per
 * role, whether the database answers, and which services are configured, with no secret in it.
 * 200 when the app can serve, 503 when its database does not answer. The host's health check.
 */
export async function GET(): Promise<Response> {
  // Request time, not build time: with cacheComponents on, a handler that reads nothing dynamic
  // is prerendered once during `next build` and would report the build machine's settings.
  await connection();
  const { status, body } = await healthReport();
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
