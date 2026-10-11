# apps/web — Forking Paths web app

Next.js 16 (App Router, `src/`), TypeScript, Tailwind 4, Mastra 1.x, Vitest. Node 22.

Read `AGENTS.md` in this folder (Next.js 16 rules) and the root `AGENTS.md` (project rules).

## Commands

```bash
pnpm install
pnpm dev          # app on http://localhost:3000
pnpm mastra:dev   # Mastra Studio on http://localhost:4111 (agents, workflows, traces)
pnpm check        # typecheck + lint + unit tests (run before every PR)
pnpm build        # production build (run before merging)
```

`.npmrc` makes pnpm use Node 22.22.3 even if your global pnpm runs an older Node.

## Environment

Copy `.env.example` to `.env.local` and fill in the keys you have. The comments in the file
say what each variable is for.

Local database without Atlas:

```bash
docker run -d --name forking-paths-mongo -p 27017:27017 mongo:8
pnpm db:check     # connects, creates the indexes, starts Mastra's storage
```

With `MONGODB_URI` empty the app keeps quests, runs and caches in memory (lost on restart),
so it runs with no database at all. Code reads and writes through the repositories in
`src/lib/store` (`saveQuest`, `questsNear`, `startRun`, …), which pick MongoDB or memory.
Paid calls go through `budgetTake` in `src/lib/budget.ts` (daily caps, UTC days).

The MongoDB integration tests run only when `MONGODB_URI` is set; they use a database
named `<MONGODB_DB>-itest` and drop it:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 pnpm test
```

## Gemma provider

`src/lib/model.ts` picks where Gemma runs, per role (`writer`, `reader` for the photo check,
`narrator`), from env: `GEMMA_PROVIDER=auto|google|ollama` (auto = Google AI Studio when
`GOOGLE_GENERATIVE_AI_API_KEY` is set, otherwise Ollama), with per-role overrides such as
`GEMMA_READER_PROVIDER=ollama`. Only Gemma IDs run on Google; Ollama cloud models are refused.
`src/lib/json.ts` → `generateJson(role, schema, prompt, images?)` returns a zod-validated object
plus usage (provider, model, tokens, latency).

Check a provider end to end (JSON, a tool call through a Mastra agent, an image, and a tool
with a JSON schema in one call):

```bash
pnpm exec tsx scripts/model-smoke.ts --provider ollama   # or google, or all
```

A provider that is not configured is skipped.

## Research (places and cited facts)

`src/research` → `research({ lat, lng, lang, minutes, timeZone })` finds candidate places and
numbered facts near a point: SerpApi Google Maps (2 searches), Wikipedia GeoSearch (free), and
SerpApi Google Search for 4 places. It makes at most 6 SerpApi searches per call, takes each
from the daily `serpapi` budget, and caches every response for 7 days (a cached search is
free). Every fact keeps its source, the query and the link. Without `SERPAPI_API_KEY` it
runs on Wikipedia alone. The same functions are Mastra tools in `src/mastra/tools`
(`placesNearby`, `placeFacts`, `wikiNearby`).

```bash
pnpm exec tsx scripts/research-smoke.ts                      # Karaköy, Istanbul
pnpm exec tsx scripts/research-smoke.ts --no-spend           # cached SerpApi results only
pnpm exec tsx scripts/research-smoke.ts --wikipedia-only --lat 48.8584 --lng 2.2945
```

Unit tests run on responses recorded for Karaköy (`src/research/__fixtures__`, no key in them).

## Quest generation

`POST /api/quests` `{ lat, lng, minutes: 15 | 25, lang, timeZone? }` → `{ questId, reused }`.
It reuses a saved quest within ~500 m (same length and language). Otherwise, within today's
cap (`BUDGET_QUESTS_PER_DAY`), it runs the Mastra workflow `generate-quest`
(`src/mastra/workflows/generate-quest.ts`, logic in `src/quest/generate.ts`):

1. **research**: `research()` on the centre rounded to ~100 m (at most 6 SerpApi searches), then
   code lists route options that already fit the distance rules (`src/quest/plan.ts`).
2. **write**: one call to the `writer` agent (`src/mastra/agents/writer.ts`, Gemma, thinking on),
   with the facts, the route options, the cue list and the Karaköy quest as the one example.
3. **validate**: `validateQuest`; on rejection, one repair call with the error list.
4. **save**: the quest with `validation` (did the first draft pass, its errors, was it repaired),
   `model`, `timings` and `serpapiSearches`.

No voice here: a quest is voiced when a run starts. Over the cap the route makes no SerpApi or
model call and offers the nearest saved quest (`overCap: true`, with `distanceM`). Errors come
back as `{ error, code }`: `bad-request`, `few-places` (no route fits here), `writer-failed`,
`invalid-quest` (failed the checks twice) or `over-cap`.

```bash
pnpm exec tsx scripts/generate-quest.ts --lat 41.0247 --lng 28.9744 --minutes 15 --out /tmp/run.json
pnpm exec tsx scripts/generate-quest.ts --no-spend          # cached SerpApi results and Wikipedia only
pnpm mastra:dev                                             # Studio shows the workflow and the writer agent
```

The script calls the workflow directly (no daily quest cap; the SerpApi budget still applies).

## Evals

Five scripts measure what the game claims. Each prints its headline numbers and writes a markdown
table and a JSON file to `--out-dir` (default `eval/runs/`, git-ignored) as `<date>-<name>`.
Without a key they skip that part and say so.

| Script | Measures |
|---|---|
| `scripts/eval-coverage.ts` | Places within 900 m from Wikipedia alone vs. with SerpApi Google Maps, at 15 points (5 cities × centre, residential, edge; `eval/coverage-points.ts`). Maps searches only, ≤ 2 per point, cached and paced. `--no-spend` for Wikipedia only. |
| `scripts/eval-facts.ts` | Fact check (page → fact): fetches the link of ~30 facts cited by generated quests and checks the page says it. Word-for-word matches (every number in the fact on the page too) count in code; Gemma pre-checks the rest. |
| `scripts/eval-reveals.ts` | Reveal check (fact → narration): ~20 reveals, link reasons, mysteries, finales and walked bridge lines against the facts they cite; Gemma pre-checks. |
| `scripts/eval-validator.ts` | How many generated quests passed the validator on the first draft, after one repair, or failed, and the most common errors (`quest.validation` and `generate-quest.ts --out` records). `--generate <cities>` makes more quests first. |
| `scripts/eval-reader.ts` | The photo reader on the labelled photo set (`eval/photos/manifest.json`), Google vs. local: plausibility, cue match, the no-GPS pass rule, latency p50/p95. |

The fact and reveal checks take `--review <file.json>`: verdicts from a person (`"by": "agent"`
or `"owner"`) that replace Gemma's pre-check, so the report says who checked what. Quests are
read from `--dbs` (default `MONGODB_DB`; `all` = every `forking-paths*` database) and `--records`
(a folder of `generate-quest.ts --out` files). Samples are seeded (`--seed`), so a rerun picks the
same items.

```bash
pnpm eval:photos:fetch && pnpm eval:reader:compare --providers ollama,google
pnpm eval:coverage --no-spend
pnpm eval:facts --dbs all --records <dir> --precheck ollama
```

## The demo quest

`src/quest/__fixtures__/karakoy.json` is the desk demo's quest: four places below Galata Tower in
Karaköy, Istanbul, with facts from the Wikipedia pages they link to. Gemma drafted the text from
those facts. Each fact was checked against the page it links to, and every hand edit to Gemma's
draft is listed in `editedByHand`. Load it with `demoQuest()` from `src/quest/demo.ts` (it runs
the validator). To draft the text again from the same facts and route:

```bash
pnpm exec tsx scripts/draft-demo-quest.ts --out /tmp/karakoy-draft.json
```

The draft is validated (one repair on failure) and saved to `--out`; the fixture is not changed.

## Narrator voice

The narrator is an ElevenLabs voice (`src/lib/voice.ts`); the character and the line rules,
including the audio tags (`[whispers]`, `[curious]`, `[sighs]`, `[excited]`), are in
`src/mastra/agents/narrator-style.md`. The screen shows every line as text, with the tags
removed.

- `speak(text)` voices one line and returns a clip id: `hash(text + voice + model)`, stored in the
  `clips` collection, so the same line is paid for once. `voiceQuest(quest)` voices a quest's
  briefing, each place's clue, look, hint and reveal, and the finale when a run starts (never
  when a quest is generated). Both check the daily `tts-chars` cap first; over it, or with no
  key, they make no request and the run is text only.
- `GET /api/audio/<clipId>` serves a clip as `audio/mpeg` (cached for a year; byte ranges for Safari).
- The ambience (12 s, loops) plays under the briefing and the clues only; nothing plays while
  you walk. A "found" or "not here" stinger plays on a photo result (`src/lib/audio-mix.ts`).
- New lines are voiced only with `ELEVENLABS_LIVE=1`. Without it (local work, tests, browser
  checks) clips that already exist still play and nothing new is requested.

One-off scripts (safe to rerun: cached clips cost nothing; each prints `skipped` without a key):

```bash
pnpm exec tsx scripts/design-voice.ts --write-env   # Voice Design → ELEVENLABS_VOICE_ID (premade voice if the plan has no Voice Design)
pnpm exec tsx scripts/make-sounds.ts --export       # ambience + two stingers
pnpm exec tsx scripts/seed-demo-voice.ts --export   # voice the demo quest (refuses past --max-chars, default 3000)
pnpm exec tsx scripts/voice-sample.ts --out /tmp/narrator-sample   # 3 lines over the ambience (needs ffmpeg for the mix)
```

`--export` copies the demo's clips and the sounds into `public/audio/` (with `manifest.json`).
Once those files are committed, the desk demo speaks on a fresh deployment with an empty
database and no credits left; until then, it shows its lines as text.
`--dry-run` runs any of them against a mock client and memory, writing only to `--out`.

## Play routes

A walk is a plain run record (`src/quest/run.ts`, a small state machine) stored in the `runs` and
`attempts` collections (or in memory without `MONGODB_URI`). The phone UI talks to these routes
through the shapes in `src/quest/api.ts`.

Each walk is also a paused Mastra workflow, `play-quest` (`src/mastra/workflows/play-quest.ts`,
driven by `src/quest/walk.ts`). It waits at each stop while the player walks, and a photo resumes
it. Its snapshot lives in Mastra's storage (MongoDB when `MONGODB_URI` is set), so a walk
survives a server restart. The rules stay in `run.ts`: the workflow calls the same engine and
follows its result. The photo never enters a snapshot: it waits in the server's memory, and the
workflow is resumed with a key to it. When a walk has no paused workflow, the run record answers
the photo on its own. To see a paused walk, run Studio against the same database
(`PORT=4117 pnpm mastra:dev`) and open Workflows → play-quest.

The routes:

- `POST /api/runs` `{ questId }` starts a run and voices the quest's lines (text only when voice is
  off or over the daily cap). The demo quest `demo-karakoy` is loaded from its fixture when the
  database has no copy yet, and saved.
- `POST /api/runs/<runId>/photo` (multipart: `image` as JPEG, PNG or WebP up to 2 MB, `placeId`,
  and optionally `lat`, `lng`, `accuracy`) checks the photo and moves the walk on. GPS near the
  place passes it; too far gives the place's hint with distance and direction (two retries, then
  the stop is skipped); without GPS the photo must look plausible to Gemma. The photo stays in
  memory for the reader call: it is never stored, logged or traced.
- `POST /api/runs/<runId>/finish` `{ receipt }` saves screen-on time, pocket time, peeks and the
  score, once.

Open `/?quest=demo-karakoy` to start a walk on a saved quest instead of finding one near you.

## Browser checks

`NEXT_PUBLIC_SENTRY_DSN= pnpm build && pnpm e2e` plays the app in headless Chrome on a phone viewport (390 × 844).
Playwright starts the production build on port 3200 with the settings in
`e2e/env.ts`: a fresh test database (`forking-paths-qa-e2e`, MongoDB must be running), no Google,
SerpApi or ElevenLabs key, and a photo reader that never answers, so every result is the same on
every run and no paid API is called. The checks cover the desk demo with location denied (each
fork photo leads to a different stop, the case file, every fact with its link, the receipt), a
street walk with the phone's position set to each stop (GPS alone passes a stop, too far gives the
hint, lock, unlock and reload keep the walk), the start page and "Generate a quest near me" over
the daily cap, the audio rules (with short test clips in the test database) and tap targets.
Set `SHOTS_DIR` to an absolute folder to save a screenshot of every screen.

The other browser check against the real routes needs a running server with a photo reader and the eval
photos (`pnpm eval:photos:fetch`):

```bash
E2E_REAL=1 E2E_BASE_URL=http://localhost:3000 pnpm exec playwright test e2e/play-real.spec.ts
```

## Where code goes

Routes in `src/app`, pure game rules in `src/quest` (unit-tested), external services in
`src/lib` and `src/research`, Mastra agents/tools/workflows in `src/mastra`.

## Bundled docs (current, trust them over memory)

- Next.js: `node_modules/next/dist/docs/`
- Mastra: `node_modules/@mastra/core/dist/docs/references/` (and each `@mastra/*` package's `dist/docs/`)
