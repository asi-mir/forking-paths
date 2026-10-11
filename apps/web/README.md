# apps/web: the Forking Paths web app

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
docker run -d --name forking-paths-mongo -p 127.0.0.1:27017:27017 mongo:8
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

### Variables

`apps/web/.env.example` lists every variable, with notes.

| Variable | What it is for |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemma on Google AI Studio, for all three roles. |
| `GEMMA_PROVIDER` | Where Gemma runs: `auto`, `google` or `ollama`. `GEMMA_WRITER_PROVIDER`, `GEMMA_READER_PROVIDER` and `GEMMA_NARRATOR_PROVIDER` set it for one role. |
| `GEMMA_WRITER_MODEL`, `GEMMA_READER_MODEL`, `GEMMA_NARRATOR_MODEL` | The Google model ID for each role. The app accepts only Gemma IDs. The narrator uses the reader model unless you set its own. |
| `GEMMA_WRITER_THINKING`, `GEMMA_READER_THINKING`, `GEMMA_NARRATOR_THINKING` | `minimal` or `high`. By default the writer uses `high`, and the other roles use `minimal`. |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_AUTH_HEADER` | Gemma on Ollama, on your machine or through a tunnel (see below). |
| `SERPAPI_API_KEY` | Places and facts from Google Maps and Google Search. Without it, research uses Wikipedia only. |
| `WIKIPEDIA_USER_AGENT` | A contact for the Wikipedia API. Wikipedia asks API clients to send one. |
| `ELEVENLABS_API_KEY` | The narrator's voice for new lines. |
| `ELEVENLABS_VOICE_ID` | The narrator voice. If it is empty, the app uses the voice of the clips in `apps/web/public/audio/`. |
| `ELEVENLABS_MODEL_ID` | The speech model, `eleven_v4`. |
| `ELEVENLABS_LIVE` | `1` lets the app voice new lines. If it is empty, saved clips still play, and lines without a clip show as text. |
| `MONGODB_URI`, `MONGODB_DB` | The database and its name. |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Tracing on the server and in the browser. If both are empty, Sentry is off. |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_ENVIRONMENT` | A label for the traces, such as `production`. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Source map upload from a hosted build (Render or CI), only when all three are set. |
| `NEXT_PUBLIC_MOCK_API` | `1` makes the phone pages play a fixture case in the browser, with no server routes. |
| `BUDGET_*` | The daily caps (see the next section). |

### Daily caps

`src/lib/budget.ts` keeps a count for each cap and each UTC day, in MongoDB or in memory.
When a call would go over its cap, the app does not make it.

| Variable | `.env.example` | `render.yaml` | What happens over the cap |
|---|---|---|---|
| `BUDGET_QUESTS_PER_DAY` | 3 | 3 | The app offers the nearest saved case within about 3 km, or the desk demo. |
| `BUDGET_SERPAPI_PER_DAY` | 40 | 20 | Research uses cached results and Wikipedia only. |
| `BUDGET_TTS_CHARS_PER_DAY` | 4000 | 2500 | The lines show as text. |
| `BUDGET_READER_PER_DAY` | 300 | 300 | GPS still passes a stop, and a desk sample uses its stored result. |
| `BUDGET_RUNS_PER_DAY` | 1000 | 1000 | No new walk can start that day. |

Set the caps to match your credits.
The app voices the new lines of a case all at once or not at all.
So set the character cap high enough for one whole case.
The 18 lines of the desk demo case have 1,909 characters.

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

## Gemma on your own machine

The photo check can run on your own machine.
With a Google key and the default settings, it uses Google's API.
Both use the same Gemma 4 family: 26B and 31B on Google AI Studio, E4B on your machine.

```bash
ollama pull gemma4:e4b
```

Then set these in `apps/web/.env.local`:

```bash
GEMMA_READER_PROVIDER=ollama       # the photo check only; GEMMA_PROVIDER=ollama moves every role
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma4:e4b
```

The app loads the model when a walk starts, so the first photo does not wait for it.
The receipt at the end of a walk names the Gemma that read your photos.
For example, it says "Gemma 4 E4B on my laptop (Ollama)".
The spans of the photo check carry the same value in the `checkedBy` tag, for example `ollama/gemma4:e4b`.

### Ollama on your laptop, the app somewhere else

Ollama has no login of its own.
Never open port 11434 to the internet without one.
Use a tunnel that checks basic auth, and let the app send the header.

1. Pick a password of 8 or more characters, and make the header value:

   ```bash
   printf 'playtest:%s' "$PASSWORD" | base64     # OLLAMA_AUTH_HEADER="Basic <this value>"
   ```

2. Start a tunnel that checks basic auth and rewrites the Host header.
   Ollama answers `403 Forbidden` when the Host header is not its own (checked with Ollama 0.33).

   - ngrok: `ngrok http 11434 --basic-auth "playtest:$PASSWORD" --host-header="localhost:11434"`
   - Some tunnels have no auth of their own, such as a Cloudflare quick tunnel. For those, put a
     small proxy with basic auth in front of Ollama. With [Caddy](https://caddyserver.com):

     ```
     # Caddyfile: caddy run --config Caddyfile
     :11435 {
       basic_auth {
         playtest <hash from: caddy hash-password>
       }
       reverse_proxy localhost:11434 {
         header_up Host localhost:11434
       }
     }
     ```

     Then run `cloudflared tunnel --url http://localhost:11435`.

3. Set these where the app runs:

   ```bash
   GEMMA_READER_PROVIDER=ollama
   OLLAMA_BASE_URL=https://<your-tunnel-host>/v1
   OLLAMA_AUTH_HEADER=Basic <base64 of playtest:password>
   ```

   The app sends `OLLAMA_AUTH_HEADER` with every request to Ollama, but only over https or to localhost.
   It never logs the header.
   For a tunnel with its own auth header, use the form `Header-Name: value`.
   The app refuses a user name or password inside `OLLAMA_BASE_URL`.
   In the server log, `HTTP 401` means a wrong header.
   `HTTP 403` usually means that the tunnel did not rewrite the Host header.

4. Keep the laptop awake and on power during the walk. Stop the tunnel after the walk.

Through the tunnel, your laptop gets the photo, the name of the place and the cues of the fork.
With GPS at the stop, Gemma on Ollama has 25 s to read a photo, and Google has 10 s.
After that time, the stop passes on GPS, and a fork takes the nearest way.

### Play the local app on a phone

A phone gives GPS to a web page only over HTTPS, so `http://<laptop-ip>:3000` does not work.
Serve a production build, and open it through an HTTPS tunnel:

```bash
cd apps/web
pnpm build && pnpm start                         # http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Open the `https://` address on the phone.
With `GEMMA_READER_PROVIDER=ollama` and Ollama on the same laptop, you need only this one tunnel.
The photo check then stays on the laptop.
Anyone with the address can play, and their photos then reach your laptop.
Share the address only with your testers, and stop the tunnel after the walk.
`pnpm dev` also works when the host of the tunnel is in `allowedDevOrigins` in `next.config.ts`.

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

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/asi-mir/forking-paths)

The button reads the Blueprint in [`render.yaml`](../../render.yaml).
It creates one web service, `forking-paths`:

- Runtime Node, with `apps/web` as the root directory.
- Plan `0.5c-512mb`, which is always on. If the service runs out of memory, switch to `1c-2g`.
- Region `frankfurt`.
- Build command `corepack pnpm install --frozen-lockfile && corepack pnpm build`.
- Start command `pnpm start`.
- Health check `/api/health`.
- A new deploy for each commit that changes `apps/web`.

### The database

On Render, set `MONGODB_URI` to a MongoDB Atlas connection string.
A free cluster works.
Atlas must also let Render connect. Do one of these:

- Add the outbound IP addresses of Render to the Atlas IP access list.
  You find them in the **Connect** menu of the service, on the **Outbound** tab.
- Allow access from `0.0.0.0/0`, and give the database user a strong password.

### Variables that Render asks for

When it creates the Blueprint, Render asks for each variable marked `sync: false`:

| Variable | Needed | What it is for |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | Gemma on Google AI Studio: writing cases, reading photos and bridge lines. |
| `MONGODB_URI` | yes | The Atlas connection string, for cases, walks, clips, caches and the daily caps. |
| `SERPAPI_API_KEY` | recommended | Places and facts from Google Maps and Google Search. If it is empty, research uses Wikipedia only. |
| `WIKIPEDIA_USER_AGENT` | recommended | A contact for the Wikipedia API, such as `ForkingPaths/0.1 (https://github.com/<you>/forking-paths; you@example.com)`. If it is empty, the app sends a generic one with the link to this repo. |
| `ELEVENLABS_API_KEY` | optional | The narrator's voice for new lines. If it is empty, the desk demo's clips still play, and other lines show as text. |
| `ELEVENLABS_VOICE_ID` | optional | The narrator voice. If it is empty, the app uses the voice of the desk demo's clips. |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | optional | Tracing. If both are empty, Sentry is off. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | optional | Source map upload from the Render build. Set all three, or none. |

`render.yaml` sets the other variables.
You can change them in the **Environment** tab of the service:

- `GEMMA_PROVIDER=google`, `GEMMA_WRITER_MODEL=gemma-4-31b-it`, `GEMMA_READER_MODEL=gemma-4-26b-a4b-it`: which Gemma runs each role.
- `BUDGET_*`: the daily caps (see [Daily caps](#daily-caps)).
- `ELEVENLABS_LIVE=1`, `ELEVENLABS_MODEL_ID=eleven_v4`: the app may voice new lines, within the character cap.
- `MONGODB_DB=forking-paths`: the name of the database.
- `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`: the label for the traces.
- `NEXT_PUBLIC_MOCK_API=0`: the phone pages call the server API.
- `NODE_VERSION=22.22.3`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`: Node 22, and pnpm through corepack with no prompt.

The photo check can also run on your own machine while the app runs on Render.
Add `GEMMA_READER_PROVIDER=ollama`, `OLLAMA_BASE_URL` and `OLLAMA_AUTH_HEADER` in the dashboard.
See [Ollama on your laptop, the app somewhere else](#ollama-on-your-laptop-the-app-somewhere-else).

### Check the deploy

1. Open `https://<your-service>.onrender.com/api/health`. It answers 200, with `ready: true`
   when every Gemma role has its model and its key.
2. If it shows `ready: false`, a model setting or its key is missing.
3. If it answers 503, the database does not answer. Check `MONGODB_URI` and the Atlas access list.
4. Open `/demo` and play the desk demo.

The health answer also shows the Gemma provider and model for each role and the state of the database.
It shows which services have their settings (true or false, never a key) and the daily caps.

To run the same build and start on your machine:

```bash
cd apps/web
corepack pnpm install --frozen-lockfile && corepack pnpm build
PORT=3111 pnpm start          # then: curl localhost:3111/api/health
```

## Privacy and safety

- The phone resizes each photo to at most 1024 px and encodes it again as a JPEG.
  This removes the EXIF data, such as the GPS tags and the camera model.
- The server uses the photo for the check and then drops it.
  It stores no photo, and the Mastra snapshot of a paused walk holds no image.
  The photos in your case file stay on your phone.
- With Google AI Studio, the photo goes to Google.
  On the free tier, Google may use it to improve its products.
  With Ollama, the photo goes to your own machine, directly or through your tunnel.
- Research uses a point rounded to about 100 m.
  SerpApi, Wikipedia and the saved case get only this rounded point.
- Sentry gets no photos, no request bodies and no query strings.
- Clues never send a player onto a road or into private property.
  They never ask for photos of people.
  The writer's prompt gives these rules.
  The validator rejects any line that breaks them, and it also checks the bridge lines from the walk.
- The game is for daylight only. The start page says "Stay on the pavement, daylight only."
  After sunset, it asks you to walk in daylight or to try the desk demo.
  The phone works out the position of the sun itself, with no network call.

## Credits (full)

- **Model:** Gemma 4 by Google (Apache 2.0): `gemma-4-31b-it` and `gemma-4-26b-a4b-it` on
  Google AI Studio, and `gemma4:e4b` on [Ollama](https://ollama.com) (MIT).
- **Frameworks and libraries:**
  - [Next.js](https://nextjs.org) and React (MIT).
  - [Mastra](https://mastra.ai) (Apache 2.0).
  - The AI SDK, with its Google and OpenAI-compatible providers (Apache 2.0).
  - The MongoDB Node.js driver (Apache 2.0).
  - The Sentry SDK, the ElevenLabs SDK and the `serpapi` library (MIT).
  - zod and Tailwind CSS (MIT).
  - For development: TypeScript, sharp and Playwright (Apache 2.0), and Vitest, tsx and ESLint (MIT).
- **Facts:** text from Wikipedia under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  A Wikipedia fact is a short excerpt from its page.
  The desk demo case uses English translations of Turkish pages.
  Each fact links to its page, and the app shows the licence under each list with Wikipedia text.
  Places and facts also come from Google Maps and Google Search through [SerpApi](https://serpapi.com).
- **Voice and sound:** made with [ElevenLabs](https://elevenlabs.io).
  The narrator is the premade voice "George" on `eleven_v4`.
  The ambience and the two stingers use `eleven_text_to_sound_v2`.
  The desk demo's clips are in `apps/web/public/audio/`.
- **Fonts:** Geist, Fraunces and IBM Plex Mono (SIL Open Font License), from Google Fonts
  through `next/font`.
- **Desk demo photos:** Wikimedia Commons, CC BY-SA 4.0, cropped or resized.
  The file pages are in [`apps/web/public/demo/credits.json`](public/demo/credits.json).
  - Francesco Bini: the inscription and the spout of the Bereketzade Fountain.
  - Basak: the plaque on the minaret of the Bereketzade Mosque.
  - Ali Osman Dilekoğlu: the Hasan Ağa Fountain.
  - Another Believer: the Camondo Stairs.
- **Eval photos:** 34 photos from Wikimedia Commons, used only by the evals.
  The file pages are in [`apps/web/eval/photos/manifest.json`](eval/photos/manifest.json).

  | Licence | Authors |
  |---|---|
  | CC BY 4.0 | Karakalem |
  | CC BY-SA 4.0 | Ali Osman Dilekoğlu, Basak, Basotxerri, Clar67, Didier Descouens, Dosseman, Francesco Bini, Gogerr, Kurmanbek, Lernain Bro, R Prazeres, Reise Reise, Rosser1954, U3211603, Wilfredor |
  | CC BY-SA 3.0 | Aimaimyi, Cjschopfer, Mark Ahsmann, Vmenkov |
  | CC BY-SA 2.0 | Becky Williamson, Karsten Wentink |
  | CC BY-SA 1.0 | Sam Wilson |
  | CC BY 2.0 | Elliott Brown, James from Boulder, Shixart1985 |
  | CC0 | Marco Bonomo, Markus Spiske |
  | Public domain | Uğur Başak |

## Where code goes

Routes in `src/app`, pure game rules in `src/quest` (unit-tested), external services in
`src/lib` and `src/research`, Mastra agents/tools/workflows in `src/mastra`.

## Bundled docs (current, trust them over memory)

- Next.js: `node_modules/next/dist/docs/`
- Mastra: `node_modules/@mastra/core/dist/docs/references/` (and each `@mastra/*` package's `dist/docs/`)
