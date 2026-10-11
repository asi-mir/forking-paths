/**
 * Downloads the reader eval photos listed in eval/photos/manifest.json into eval/photos/.cache/
 * (git-ignored), resized to at most 1024 px and re-encoded as JPEG without metadata, the way the
 * phone sends a photo. Photos already in the cache are kept.
 *
 * Usage (from apps/web): pnpm eval:photos:fetch [--force]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { PHOTO_MAX_PX } from "../src/quest/api";
import { CACHE_DIR, cachedPath, loadManifest } from "../eval/photos/manifest";

const UA = "ForkingPathsEval/0.1 (open-source walking game; photo reader eval)";
const force = process.argv.includes("--force");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(url: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 || res.status >= 500) {
      await sleep(5_000 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`gave up on ${url} after retries`);
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const photos = loadManifest();
  let fetched = 0;
  for (const photo of photos) {
    const out = cachedPath(photo);
    if (existsSync(out) && !force) continue;
    const bytes = await download(photo.thumb ?? photo.image);
    const jpeg = await sharp(bytes)
      .rotate() // apply EXIF orientation, then drop all metadata
      .resize(PHOTO_MAX_PX, PHOTO_MAX_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    writeFileSync(out, jpeg);
    fetched++;
    console.log(`${photo.id}: ${Math.round(jpeg.length / 1024)} KB`);
    await sleep(1_500);
  }
  console.log(`${fetched} fetched, ${photos.length - fetched} already cached, in ${CACHE_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
