import type { z } from "zod";
import {
  API,
  ApiErrorSchema,
  type CreateQuestRequest,
  type CreateQuestResponse,
  CreateQuestResponseSchema,
  type FinishRequest,
  type FinishResponse,
  FinishResponseSchema,
  type PhotoFields,
  type PhotoResult,
  PhotoResultSchema,
  type StartRunRequest,
  type StartRunResponse,
  StartRunResponseSchema,
} from "@/quest/api";

/**
 * The phone's view of the play routes. Two adapters share this shape: `httpApi` talks to the
 * real routes (the default) and `mockApi` (./mock.ts) plays a fixture quest in the browser
 * through the same contract, for building and testing the UI without a server.
 */
export interface PlayApi {
  readonly mock: boolean;
  createQuest(req: CreateQuestRequest): Promise<CreateQuestResponse>;
  startRun(req: StartRunRequest): Promise<StartRunResponse>;
  sendPhoto(runId: string, image: Blob, fields: PhotoFields): Promise<PhotoResult>;
  finish(runId: string, req: FinishRequest): Promise<FinishResponse>;
}

/** A failed call, with a sentence the UI can show. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

const TIMEOUT_MS = {
  quest: 120_000, // a new quest: research and one Gemma writing call
  run: 90_000, // a run start voices the quest's lines
  photo: 60_000, // the photo check (Gemma vision)
  finish: 20_000,
};

async function call<S extends z.ZodType>(
  url: string,
  init: RequestInit,
  schema: S,
  timeoutMs: number,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiFailure(
      timedOut ? "The server took too long. Try again." : "No connection. Check your signal and try again.",
      timedOut ? "timeout" : "offline",
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new ApiFailure(
      parsed.success ? parsed.data.error : `The server answered ${res.status}. Try again.`,
      parsed.success ? parsed.data.code : undefined,
      res.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiFailure("The server sent an answer this page cannot read.", "bad-response", res.status);
  return parsed.data;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const httpApi: PlayApi = {
  mock: false,
  createQuest: (req) => call(API.quests, json(req), CreateQuestResponseSchema, TIMEOUT_MS.quest),
  startRun: (req) => call(API.runs, json(req), StartRunResponseSchema, TIMEOUT_MS.run),
  sendPhoto: (runId, image, fields) => {
    const form = new FormData();
    form.set("image", image, "photo.jpg");
    form.set("placeId", fields.placeId);
    if (fields.lat !== undefined && fields.lng !== undefined) {
      form.set("lat", String(fields.lat));
      form.set("lng", String(fields.lng));
    }
    if (fields.accuracy !== undefined) form.set("accuracy", String(fields.accuracy));
    if (fields.sampleId) form.set("sampleId", fields.sampleId);
    return call(API.photo(runId), { method: "POST", body: form }, PhotoResultSchema, TIMEOUT_MS.photo);
  },
  finish: (runId, req) => call(API.finish(runId), json(req), FinishResponseSchema, TIMEOUT_MS.finish),
};

/** Mock run IDs start with this, so /play and /end pick the mock adapter after a reload. */
export const MOCK_RUN_PREFIX = "mock-";

export const isMockRunId = (runId: string) => runId.startsWith(MOCK_RUN_PREFIX);

/**
 * Mock mode: NEXT_PUBLIC_MOCK_API=1 at build time, or ?mock=1 on the start page in development.
 * A production build ignores ?mock=1: the fixture quests hold test facts that were not fetched
 * from a source, so a public deployment must never play them by accident.
 */
export function mockRequested(search: string, env: { mockApi?: string; nodeEnv?: string } = {
  mockApi: process.env.NEXT_PUBLIC_MOCK_API,
  nodeEnv: process.env.NODE_ENV,
}): boolean {
  if (env.mockApi === "1") return true;
  if (env.nodeEnv === "production") return false;
  return new URLSearchParams(search).get("mock") === "1";
}

/** `?quest=<id>` on the start page: play that saved quest instead of finding one near the player. */
export function savedQuestParam(search: string): string | null {
  const id = new URLSearchParams(search).get("quest")?.trim();
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
