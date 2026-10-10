import { PHOTO_MAX_BYTES, PHOTO_MAX_PX, PHOTO_TYPE } from "@/quest/api";

/**
 * The photo leaves the phone only as a fresh JPEG: decoded, drawn on a canvas at most
 * 1024 px on its longest side, and encoded again. A canvas carries no EXIF, so the camera's
 * GPS tags, device model and time stamps are gone before the upload.
 */

export type PreparedPhoto = { blob: Blob; width: number; height: number };

/** Longest side ≤ max, aspect kept, never scaled up. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_PX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF orientation while decoding, so the pixels stand upright.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Older Safari: fall back to an <img>, which also honours EXIF orientation.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The photo could not be encoded."))), PHOTO_TYPE, quality),
  );
}

/** Resize to ≤ 1024 px and re-encode as JPEG (~0.8), which drops EXIF. */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const img = await decode(file);
  try {
    const size = fitWithin(img.width, img.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot resize photos.");
    ctx.drawImage(img.source, 0, 0, size.width, size.height);
    let blob = await toJpeg(canvas, 0.8);
    if (blob.size > PHOTO_MAX_BYTES) blob = await toJpeg(canvas, 0.6);
    return { blob, ...size };
  } finally {
    img.close();
  }
}

// ---------------------------------------------------------------------------
// GPS: read once, when the player taps "I'm here" (pages get no GPS while locked)

export type GpsFix = { lat: number; lng: number; accuracy: number };
export type GpsResult = { ok: true; fix: GpsFix } | { ok: false; reason: "denied" | "unavailable" | "timeout" };

export function readPosition(timeoutMs = 15_000, maximumAgeMs = 0): Promise<GpsResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          fix: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) },
        }),
      (err) =>
        resolve({
          ok: false,
          reason: err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable",
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs },
    );
  });
}
