import { parsePhotoForm, PHOTO_MAX_BYTES, sniffPhotoType } from "@/quest/api";
import { walkPhoto } from "@/quest/walk";
import { apiError, BodyTooLarge, errorResponse, json, readBody } from "@/quest/run-http";

/** Room for the form's other fields and multipart boundaries next to the photo. */
const FORM_OVERHEAD_BYTES = 16 * 1024;

/**
 * POST /api/runs/[runId]/photo (multipart: image, placeId, lat, lng, accuracy, sampleId):
 * resumes the paused walk: checks the photo and moves the run on. The image stays in memory for the reader call and is
 * dropped: it is never stored, logged or put in a trace.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/runs/[runId]/photo">): Promise<Response> {
  const { runId } = await ctx.params;
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    return apiError("Send the photo as multipart/form-data.", "bad-request", 415);
  }

  let form: FormData;
  try {
    const body = await readBody(request, PHOTO_MAX_BYTES + FORM_OVERHEAD_BYTES);
    form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } }).formData();
  } catch (error) {
    if (error instanceof BodyTooLarge) return apiError("The photo is too large; resize it to 1024 px first.", "too-large", 413);
    return apiError("The photo form could not be read.", "bad-request", 400);
  }

  const upload = form.get("image");
  if (upload instanceof Blob && upload.size > PHOTO_MAX_BYTES) {
    return apiError("The photo is too large; resize it to 1024 px first.", "too-large", 413);
  }
  const parsed = parsePhotoForm(form);
  if (!parsed.ok) return apiError(parsed.error, "bad-request", 400);
  const { image, fields } = parsed.value;
  const data = new Uint8Array(await image.arrayBuffer());
  const mediaType = sniffPhotoType(data);
  if (!mediaType) return apiError("The photo must be a JPEG, PNG or WebP image.", "bad-request", 415);

  try {
    const result = await walkPhoto(runId, {
      placeId: fields.placeId,
      image: { data, mediaType },
      position:
        fields.lat !== undefined && fields.lng !== undefined
          ? { lat: fields.lat, lng: fields.lng, ...(fields.accuracy !== undefined ? { accuracyM: fields.accuracy } : {}) }
          : null,
    });
    return json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/runs/[runId]/photo");
  }
}
