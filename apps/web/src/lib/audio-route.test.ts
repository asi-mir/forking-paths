import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/audio/[clipId]/route";
import { parseRange } from "./http-range";
import { createMemoryStore, setStore } from "./store";
import { clipIdFor } from "./voice";

const MP3 = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const ID = clipIdFor("Lock your phone. Go.", "v", "eleven_v4");

function get(clipId: string, headers: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/audio/${clipId}`, { headers }), {
    params: Promise.resolve({ clipId }),
  });
}

beforeEach(async () => {
  const store = createMemoryStore();
  await store.putClip({ id: ID, text: "Lock your phone. Go.", voiceId: "v", modelId: "eleven_v4", mp3: MP3 });
  setStore(store);
});
afterEach(() => setStore(undefined));

describe("GET /api/audio/[clipId]", () => {
  it("serves a stored clip as audio/mpeg with immutable cache headers", async () => {
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
  });

  it("answers 404 for an unknown id and for a malformed one", async () => {
    expect((await get("0".repeat(32))).status).toBe(404);
    expect((await get("..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await get("not-a-clip")).status).toBe(404);
  });

  it("serves a byte range (Safari) and refuses one past the end", async () => {
    const res = await get(ID, { range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3.subarray(10, 20));
    expect((await get(ID, { range: "bytes=200-" })).status).toBe(416);
  });

  it("answers 304 when the browser already has the clip", async () => {
    expect((await get(ID, { "if-none-match": `"${ID}"` })).status).toBe(304);
  });
});

describe("parseRange", () => {
  it("reads one range in each form", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=5-500", 100)).toEqual({ start: 5, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("bytes=50-10", 100)).toBe("invalid");
  });
});
