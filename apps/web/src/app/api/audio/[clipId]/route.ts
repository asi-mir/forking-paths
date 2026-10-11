import { readClipAudio } from "@/lib/voice";
import { parseRange } from "@/lib/http-range";
import { isClipId } from "@/lib/voice-static";

// Runs on the Node runtime (the default; with cacheComponents a `runtime` export fails the build).

// A clip id is a hash of its text, voice and model, so a clip never changes: cache it for a year.
const IMMUTABLE = "public, max-age=31536000, immutable";

function notFound(): Response {
  return Response.json(
    { error: "No such audio clip.", code: "not-found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /api/audio/[clipId]: a voiced line, the ambience or a stinger, as audio/mpeg. */
export async function GET(request: Request, ctx: RouteContext<"/api/audio/[clipId]">): Promise<Response> {
  const { clipId } = await ctx.params;
  if (!isClipId(clipId)) return notFound();
  const mp3 = await readClipAudio(clipId);
  if (!mp3) return notFound();

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Cache-Control": IMMUTABLE,
    "Accept-Ranges": "bytes",
    ETag: `"${clipId}"`,
  });
  if (request.headers.get("if-none-match") === `"${clipId}"`) return new Response(null, { status: 304, headers });

  // Safari asks for byte ranges when it plays a URL directly.
  const range = parseRange(request.headers.get("range"), mp3.byteLength);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${mp3.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const part = mp3.subarray(range.start, range.end + 1);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${mp3.byteLength}`);
    headers.set("Content-Length", String(part.byteLength));
    return new Response(part as Uint8Array<ArrayBuffer>, { status: 206, headers });
  }
  headers.set("Content-Length", String(mp3.byteLength));
  return new Response(mp3 as Uint8Array<ArrayBuffer>, { status: 200, headers });
}
