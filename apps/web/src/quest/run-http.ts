import { ModelConfigError } from "@/lib/model";
import type { ApiError } from "./api";
import { RunError } from "./run";

/**
 * Small helpers for the play route handlers: plain-sentence JSON errors and a request body read
 * with a hard byte limit (so a large upload is refused before it is held in memory).
 */

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function apiError(error: string, code: string, status: number): Response {
  const body: ApiError = { error, code };
  return json(body, status);
}

/** Any error from the run engine as an API error. Unknown errors are logged by name only. */
export function errorResponse(error: unknown, route: string): Response {
  if (error instanceof RunError) return apiError(error.message, error.code, error.status);
  if (error instanceof ModelConfigError) {
    console.error(`${route}: model configuration: ${error.message}`);
    return apiError("The photo check is not set up on this server.", "server-config", 503);
  }
  // Never log the request or the photo: only what failed.
  console.error(`${route}: ${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`);
  return apiError("Something went wrong on the server. Try again.", "server-error", 500);
}

export class BodyTooLarge extends Error {
  override name = "BodyTooLarge";
}

/** The request body, read up to `maxBytes`; throws `BodyTooLarge` past it. */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** A small JSON body (≤ 16 KB), or undefined when it is missing or not JSON. */
export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const bytes = await readBody(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
