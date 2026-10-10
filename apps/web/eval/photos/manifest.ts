import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CueSchema } from "../../src/quest/schema";

/** One labelled photo of the reader eval set (Wikimedia Commons, freely licensed, no people). */
export const EvalPhotoSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  filePage: z.url(), // the Commons file page: author, licence and source
  image: z.url(), // the original file
  thumb: z.url().nullable(), // a ≤ 1024 px rendition, fetched first
  author: z.string(),
  licence: z.string(),
  licenceUrl: z.url().nullable(),
  placeName: z.string(), // where the player is told they stand
  offeredCues: z.array(CueSchema), // the cues of the fork's links, as the reader gets them
  label: z.object({ cue: CueSchema.nullable(), plausible: z.boolean() }),
  note: z.string(),
});
export type EvalPhoto = z.infer<typeof EvalPhotoSchema>;

/** Scripts run from apps/web. */
export const PHOTOS_DIR = resolve(process.cwd(), "eval/photos");
/** Downloaded, resized photos (git-ignored). */
export const CACHE_DIR = join(PHOTOS_DIR, ".cache");

export function loadManifest(): EvalPhoto[] {
  const raw = JSON.parse(readFileSync(join(PHOTOS_DIR, "manifest.json"), "utf8"));
  return z.object({ photos: z.array(EvalPhotoSchema) }).parse(raw).photos;
}

export const cachedPath = (photo: Pick<EvalPhoto, "id">) => join(CACHE_DIR, `${photo.id}.jpg`);
