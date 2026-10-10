import { compassDirection, distanceM, type LatLng } from "@/lib/geo";
import {
  type CaseFile,
  type CitedFact,
  type CitedSpokenLine,
  type FinishResponse,
  type NextStop,
  PHOTO_RETRIES,
  type PhotoFields,
  type PhotoResult,
  PhotoResultSchema,
  type SpokenLine,
  type StartRunResponse,
  type StopPrompt,
} from "@/quest/api";
import { fourStop, threeStop } from "@/quest/__fixtures__";
import { isFork, placeById, roadNotTaken } from "@/quest/routes";
import type { Cue, Link, Place, Quest } from "@/quest/schema";
import { validateQuest } from "@/quest/validate";
import { ApiFailure, MOCK_RUN_PREFIX, type PlayApi } from "./client";
import { scoreRun, screenOnShareOf } from "./receipt";

/**
 * The mock adapter: plays the fixture quests in src/quest/__fixtures__ (15 min: 3 stops, 25 min: 4 stops) in the
 * browser through the same contract as the real routes, so the UI can be built, tested and
 * shown without a server. Responses are checked against the contract's zod schemas.
 *
 * What the mock "reader" sees is decided by `reader` (in the browser: the photo's colours,
 * see mock-reader.ts) unless `controls()` forces it. Tests and screenshots use controls.
 */

export type MockControls = {
  cue?: Cue; // the cue the reader returns at a fork
  far?: boolean; // GPS puts the player too far away
  implausible?: boolean; // without GPS: the photo does not look like it was taken here
  voice?: boolean; // false: no clips, text only (default true)
  stored?: boolean; // the verdict comes from a stored result (desk demo fallback)
};

export type MockReader = (image: Blob, cues: Cue[]) => Promise<Cue | null>;

/** Minimal key-value storage (localStorage in the browser, a Map in tests). */
export type KeyValue = Pick<Storage, "getItem" | "setItem">;

export type MockOptions = {
  storage: KeyValue;
  reader?: MockReader;
  controls?: () => MockControls;
  delayMs?: number; // simulated latency of the photo check
  newId?: () => string;
};

type MockRun = {
  runId: string;
  minutes: 15 | 25;
  voice: boolean;
  at: string; // the place the player is walking to
  path: Array<{ placeId: string; status: "passed" | "skipped"; observed: string | null; cue: Cue | null }>;
  misses: Record<string, number>;
  done: boolean;
};

export const MOCK_QUEST_IDS = { 15: "mock-quest-15", 25: "mock-quest-25" } as const;

const MOCK_OBSERVED: Record<Cue, string> = {
  writing: "carved lettering in a stone panel",
  "date-or-number": "a date cut into the stone above the arch",
  water: "water running from a brass spout",
  "animal-or-figure": "a carved lion's head",
  "plant-or-tree": "an old plane tree leaning over the wall",
  "symbol-or-emblem": "a carved crest above the door",
  "door-window-arch": "a pointed stone arch over a door",
  material: "worn white marble, smooth from hands",
};
const MOCK_OBSERVED_PLAIN = "a weathered stone detail by the door";

// ---------------------------------------------------------------------------
// Quest

const questCache = new Map<number, Quest>();

/** The fixture quest for a walk length, built through the real validator. */
export function mockQuest(minutes: 15 | 25): Quest {
  const cached = questCache.get(minutes);
  if (cached) return cached;
  const fx = minutes === 25 ? fourStop() : threeStop();
  const result = validateQuest(fx.writer, fx.facts, fx.candidates, fx.opts);
  if (!result.ok) throw new Error(`mock fixture is not a valid quest: ${result.errors.join(" ")}`);
  const quest = { ...result.quest, id: MOCK_QUEST_IDS[minutes] };
  questCache.set(minutes, quest);
  return quest;
}

const minutesOfQuest = (questId: string): 15 | 25 | null =>
  questId === MOCK_QUEST_IDS[15] ? 15 : questId === MOCK_QUEST_IDS[25] ? 25 : null;

// ---------------------------------------------------------------------------
// Clips: mock IDs say what to synthesise (see audio.ts)

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Speech length for a line: about 2.6 words a second, 2–9 s. */
const speechSeconds = (text: string) => Math.min(9, Math.max(2, Math.round(text.split(/\s+/).length / 2.6)));

export const MOCK_CLIP = {
  ambience: "mock:ambience",
  found: "mock:found",
  notHere: "mock:not-here",
  speech: (text: string) => `mock:speech:${speechSeconds(text)}:${hash(text)}`,
};

// ---------------------------------------------------------------------------

export function createMockApi(opts: MockOptions): PlayApi {
  const controls = () => opts.controls?.() ?? {};
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const newId = opts.newId ?? (() => Math.random().toString(36).slice(2, 8));
  const key = (runId: string) => `fp:mock:${runId}`;

  const load = (runId: string): MockRun => {
    const raw = opts.storage.getItem(key(runId));
    if (!raw) throw new ApiFailure("This walk is not on this phone.", "not-found", 404);
    return JSON.parse(raw) as MockRun;
  };
  const save = (run: MockRun) => opts.storage.setItem(key(run.runId), JSON.stringify(run));

  const line = (run: Pick<MockRun, "voice">, text: string): SpokenLine =>
    run.voice ? { text, clipId: MOCK_CLIP.speech(text) } : { text };

  const factsOf = (quest: Quest, ids: string[]): CitedFact[] =>
    ids.flatMap((id) => {
      const f = quest.facts.find((x) => x.id === id);
      return f ? [{ id: f.id, text: f.text, source: f.source, sourceTitle: f.sourceTitle, query: f.query, url: f.sourceUrl }] : [];
    });

  const cited = (run: MockRun, quest: Quest, text: string, factIds: string[]): CitedSpokenLine => ({
    line: line(run, text),
    facts: factsOf(quest, factIds),
  });

  const prompt = (run: MockRun, quest: Quest, place: Place, stop: number): StopPrompt => ({
    placeId: place.id,
    stop,
    of: quest.stopsPerRun,
    isFork: isFork(place),
    clue: line(run, place.clue.text),
    look: line(run, place.look.text),
  });

  const caseFile = (quest: Quest, run: MockRun): CaseFile => ({
    mystery: { question: quest.mystery.question, answer: quest.mystery.answer },
    route: run.path.map((step) => ({
      placeId: step.placeId,
      name: placeById(quest, step.placeId)?.name ?? step.placeId,
      status: step.status,
      observed: step.observed,
      cue: step.cue,
    })),
    notTaken: roadNotTaken(quest, run.path),
    facts: factsOf(
      quest,
      quest.facts.map((f) => f.id),
    ),
  });

  const pickLink = (place: Place, cue: Cue | null): { link: Link; chosenBy: NextStop["chosenBy"] } => {
    if (place.links.length === 1) return { link: place.links[0], chosenBy: "only-link" };
    const byCue = place.links.find((l) => l.cue === cue);
    if (byCue) return { link: byCue, chosenBy: "cue" };
    return { link: place.links[0], chosenBy: "nearest" };
  };

  return {
    mock: true,

    async createQuest(req) {
      await delay(opts.delayMs === 0 ? 0 : 300);
      return { questId: MOCK_QUEST_IDS[req.minutes], reused: false };
    },

    async startRun(req) {
      const minutes = minutesOfQuest(req.questId);
      if (!minutes) throw new ApiFailure("That quest does not exist.", "not-found", 404);
      await delay(opts.delayMs === 0 ? 0 : 300);
      const quest = mockQuest(minutes);
      const voice = controls().voice !== false;
      const start = placeById(quest, quest.startPlaceId)!;
      const run: MockRun = {
        runId: `${MOCK_RUN_PREFIX}${newId()}`,
        minutes,
        voice,
        at: start.id,
        path: [],
        misses: {},
        done: false,
      };
      save(run);
      const speech = [
        quest.briefing.text,
        ...quest.places.flatMap((p) => [p.clue.text, p.look.text, p.hint.text, p.reveal.text]),
        quest.finale.text,
      ];
      const response: StartRunResponse = {
        runId: run.runId,
        questId: req.questId,
        title: quest.title,
        mystery: quest.mystery.question,
        briefing: line(run, quest.briefing.text),
        first: prompt(run, quest, start, 1),
        preload: voice ? [...new Set([...speech.map(MOCK_CLIP.speech), MOCK_CLIP.ambience, MOCK_CLIP.found, MOCK_CLIP.notHere])] : [],
        ambienceClipId: voice ? MOCK_CLIP.ambience : undefined,
        stingers: voice ? { found: MOCK_CLIP.found, notHere: MOCK_CLIP.notHere } : {},
        voice,
      };
      return response;
    },

    async sendPhoto(runId, image, fields: PhotoFields): Promise<PhotoResult> {
      const run = load(runId);
      const quest = mockQuest(run.minutes);
      if (run.done) throw new ApiFailure("This walk is already over.", "finished", 409);
      if (fields.placeId !== run.at) throw new ApiFailure("That photo is for a different stop.", "wrong-place", 409);
      const place = placeById(quest, run.at)!;
      const c = controls();
      await delay(opts.delayMs ?? 900);

      const hasGps = fields.lat !== undefined && fields.lng !== undefined;
      const misses = run.misses[place.id] ?? 0;

      // Too far (forced by controls; a real GPS fix is not compared, so testers can play anywhere).
      if (c.far && misses < PHOTO_RETRIES) {
        run.misses[place.id] = misses + 1;
        save(run);
        const from: LatLng = { lat: place.location.lat - 0.0009, lng: place.location.lng - 0.0011 };
        return PhotoResultSchema.parse({
          status: "too-far",
          placeId: place.id,
          hint: {
            line: line(run, place.hint.text),
            distanceM: Math.round(distanceM(from, place.location)),
            direction: compassDirection(from, place.location),
          },
          retriesLeft: PHOTO_RETRIES - (misses + 1),
        });
      }
      const skipped = Boolean(c.far) && misses >= PHOTO_RETRIES;

      const cues = place.links.map((l) => l.cue).filter((x): x is Cue => Boolean(x));
      const cue = isFork(place) ? (c.cue ?? (opts.reader ? await opts.reader(image, cues) : cues[0] ?? null)) : null;
      const observed = cue ? MOCK_OBSERVED[cue] : MOCK_OBSERVED_PLAIN;
      const verdict = {
        observed,
        cue,
        plausible: !c.implausible,
        confidence: c.implausible ? 0.3 : 0.86,
        source: c.stored ? ("stored" as const) : ("live" as const),
      };

      if (!hasGps && c.implausible && misses < PHOTO_RETRIES && !skipped) {
        run.misses[place.id] = misses + 1;
        save(run);
        return PhotoResultSchema.parse({
          status: "needs-retry",
          placeId: place.id,
          verdict: { ...verdict, observed: "a phone screen showing a photo", cue: null },
          message: line(run, "That looks like a screen, not the street. Photograph the place itself."),
          retriesLeft: PHOTO_RETRIES - (misses + 1),
        });
      }

      const status = skipped ? ("skipped" as const) : ("passed" as const);
      const isAnswer = place.id === quest.answerPlaceId;
      const reveal = cited(run, quest, place.reveal.text, place.reveal.factIds);

      if (isAnswer) {
        run.path.push({ placeId: place.id, status, observed: skipped ? null : observed, cue: null });
        run.done = true;
        save(run);
        return PhotoResultSchema.parse({
          status,
          placeId: place.id,
          name: place.name,
          verdict: skipped ? null : verdict,
          reveal,
          next: null,
          end: { finale: cited(run, quest, quest.finale.text, quest.finale.factIds), caseFile: caseFile(quest, run) },
        });
      }

      const { link, chosenBy } = pickLink(place, skipped ? null : cue);
      run.path.push({ placeId: place.id, status, observed: skipped ? null : observed, cue: isFork(place) ? (link.cue ?? null) : null });
      run.at = link.to;
      save(run);
      const nextPlace = placeById(quest, link.to)!;
      const detail = skipped ? "We move on." : `${observed[0].toUpperCase()}${observed.slice(1)}.`;
      return PhotoResultSchema.parse({
        status,
        placeId: place.id,
        name: place.name,
        verdict: skipped ? null : verdict,
        reveal,
        next: {
          bridge: cited(run, quest, `${detail} ${link.reason}`, link.factIds),
          chosenBy: skipped && isFork(place) ? "nearest" : chosenBy,
          stop: prompt(run, quest, nextPlace, run.path.length + 1),
        },
        end: null,
      });
    },

    async finish(runId, req): Promise<FinishResponse> {
      const run = load(runId);
      const stopsFound = run.path.filter((s) => s.status === "passed").length;
      return {
        runId,
        stopsFound,
        score: scoreRun({ stopsFound, receipt: req.receipt }).total,
        screenOnShare: screenOnShareOf(req.receipt),
        receipt: req.receipt,
      };
    },
  };
}
