/**
 * Finds image data inside a value of any shape (messages, tool input, model output), so traces
 * and stored spans can drop it. No SDK import.
 */

const MAX_DEPTH = 16;
const MAX_NODES = 20000;
const IMAGE_MEDIA = /^image\//;

/**
 * True when `value` holds image bytes or an image part anywhere inside it. A value too large or
 * too deep to walk in full also counts as an image: the guard fails closed.
 */
export function containsImage(value: unknown): boolean {
  let nodes = 0;
  const seen = new Set<object>();

  function walk(v: unknown, depth: number): boolean {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return true;
    if (typeof v === "string") return v.includes("data:image/");
    if (!v || typeof v !== "object") return false;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some((item) => walk(item, depth + 1));
    const o = v as Record<string, unknown>;
    if (o.type === "image" || o.type === "image_url") return true;
    for (const key of ["mediaType", "mimeType", "mime_type"]) {
      const media = o[key];
      if (typeof media === "string" && IMAGE_MEDIA.test(media)) return true;
    }
    return Object.values(o).some((item) => walk(item, depth + 1));
  }

  return walk(value, 0);
}
