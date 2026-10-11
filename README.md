# Forking Paths

Forking Paths is a voice-first walking mystery for your phone.

Gemma, an open-weight model, writes a short case from facts about the streets near you, each with its link.
At each fork, the detail you photograph picks your next stop.
Every route ends at the same answer.

![The desk demo fork: a photo of a gilded inscription picks the next stop](media/post/00-fork.gif)

## Try it from your desk

The desk demo at `/demo` plays a saved case in Karaköy, below Galata Tower in Istanbul.
You do not walk, and you do not share your location.
Each stop offers a sample photo from Wikimedia Commons.
The fork offers two photos of different details, so you can try both ways and see the route change.
You can also use your own photo.

At a desk there is no GPS, so Gemma's photo check decides if a photo shows the place.
If the live model fails or hits a rate limit, a sample photo uses its stored result.
The screen then shows the label "Stored result".
The desk demo plays even with no API keys.
Its voice clips are in the repo, and a sample photo uses its stored result when no model answers.

Gemma drafted this case from Wikipedia facts.
The hand edits are listed in `editedByHand` in
[`apps/web/src/quest/__fixtures__/karakoy.json`](apps/web/src/quest/__fixtures__/karakoy.json).

On `/demo/near`, Gemma writes a case near you, or in a city that you pick from a list.
The page shows the question, every clue, the ways on at each fork and every fact with its link.
You can then play that case from your desk.
The app reuses a saved case within about 500 m, which costs nothing.

To open the desk demo, start the app as in [Run it locally](#run-it-locally), then go to
`http://localhost:3000/demo`.

## How a walk works

1. Open the app on your phone and allow location. Pick 15 minutes (3 stops, 1 fork) or
   25 minutes (4 stops, 2 forks).
2. The app uses a saved case near you, or Gemma writes a new one from facts fetched nearby.
3. The narrator asks one question. The answer is a fact at the last stop.
4. A clue leads you to something that you can see. The screen says **Lock your phone. Go.**
   Nothing plays while you walk.
5. At the place, tap **I'm here**. The narrator says what kind of detail to photograph.
6. GPS at the place passes the stop. Gemma describes the detail in your photo. Then the
   narrator tells you a fact about the place, and the screen shows its source and link.
7. At a fork, each way on has a cue, such as *writing* or *water*. Gemma matches your detail
   to one cue, and that cue picks your next stop.
8. At the last stop, the narrator gives the answer. The case file shows your route and your
   photos. It also shows the stop that the other detail would have picked, and every fact
   with its link.

If GPS puts you too far from the place, you hear a hint.
The screen shows the distance and the direction.
After a third miss at a stop, the walk moves on, and you still hear the fact.
The case file ends with a screen-time receipt.
It shows how long the screen was on, and how many peeks you made.
A look at the screen on the way to a stop counts as a peek, unless you tap **I'm here** within 20 seconds.

## How it works

```text
phone: Next.js pages, GPS, camera, audio
  |
  |  POST /api/quests: reuse a saved case within about 500 m, or write a new one
  v
generate-quest (Mastra workflow), around a point rounded to about 100 m
  research   SerpApi (Google Maps, Google Search) and Wikipedia, in code
  write      Gemma writer: one JSON answer that cites fact IDs
  validate   code rules, and one repair call when a rule fails
  save       MongoDB
  |
  |  POST /api/runs: ElevenLabs voices the lines (cached), and the walk starts
  v
play-quest (Mastra workflow): suspends at each stop until a photo arrives
  |
  |  POST /api/runs/:id/photo: a JPEG of at most 1024 px, with no EXIF
  v
GPS rule -> Gemma reader -> fork rule -> Gemma bridge line -> next stop
  |
  v
last stop: the finale and the case file

Sentry traces each step and keeps photos out of the spans.
```

**App.** One Next.js 16 app in `apps/web` serves the phone pages and the API.
It uses the App Router, TypeScript and Tailwind CSS.

**Workflows.** Mastra runs two workflows.
`generate-quest` runs research, write, validate and save.
`play-quest` is the walk.
It suspends at each stop until a photo resumes it.
Its snapshots live in MongoDB, so a paused walk survives a server restart.
`pnpm mastra:dev` opens Mastra Studio on `http://localhost:4111`.

**Gemma.** Every language-model call goes to Gemma 4, in one of three roles:

| Role | What it does | Google AI Studio | Ollama |
|---|---|---|---|
| writer | Writes the case as JSON, with thinking `high` | `gemma-4-31b-it` | `gemma4:e4b` |
| reader | Checks each photo and names its cue, with thinking `minimal` | `gemma-4-26b-a4b-it` | `gemma4:e4b` |
| narrator | Writes the bridge line as you leave a stop, with thinking `minimal` | `gemma-4-26b-a4b-it` | `gemma4:e4b` |

`src/lib/model.ts` accepts only Gemma model IDs on Google AI Studio.
It also refuses Ollama cloud models.

**Research.** Code collects places and facts within 900 m of the rounded point.
SerpApi Google Maps finds places with up to 2 searches.
Wikipedia GeoSearch adds more places and facts for free.
SerpApi Google Search adds facts for up to 4 places, those with the fewest facts first.
So a new case makes at most 6 SerpApi searches.
MongoDB caches the results for 7 days.
Every fact keeps its source, its query and its link.
The writer has no tools, because code does the research first.

**Validator.** `src/quest/validate.ts` checks each draft in code.
It rejects fact IDs that are not in the research, and numbers that are not in the cited facts.
It also rejects compass words, unsafe wording, broken routes and stops more than 250 m apart.
When a draft fails, the writer gets the list of errors for one repair.
The app saves only a case that passes.

**Photo check and fork.** The phone sends the photo with one GPS reading.
If GPS puts you at the place, the stop passes, whatever the photo shows.
Without usable GPS, the photo passes when Gemma rates it plausible with a confidence of 0.7 or more.
At a fork, the reader must answer with one of the offered cues, or with none.
Code then picks the next stop: the way with that cue, else Gemma's pick by meaning, else the nearest way.
With GPS at the stop, the reader has 10 s on Google and 25 s on Ollama.
After that time, the stop passes on GPS, and a fork takes the nearest way.

**Bridge line.** The narrator writes the bridge line from the detail in your photo and the facts of the next way.
Code checks it like a reveal: known fact IDs, no new numbers, no compass words and no unsafe directions.
If a check fails, the app uses the stored reason of that way, which the validator checked.

**Voice.** ElevenLabs voices the lines of a case with `eleven_v4` when a walk starts.
A clip's ID is a hash of its text, voice and model, so the app pays for each line once.
MongoDB stores the clips, and the desk demo's clips are also in `apps/web/public/audio/`.
New lines take their characters from a daily cap first.
The app voices all the new lines of a case, or none of them.
Over the cap, the screen shows the lines as text.
The app voices each bridge line during the walk, within the same cap.
It calls ElevenLabs only when `ELEVENLABS_LIVE=1`.
`scripts/make-sounds.ts` makes the ambience and the two short stingers once.

**MongoDB.** The database keeps cases (`quests`), walks (`runs`) and photo attempts without the photos (`attempts`).
It also keeps the voice clips (`clips`), the research cache (`cache`) and the daily counters (`budget`).
Mastra keeps its workflow storage in the same database, in collections that start with `mastra_`.
With `MONGODB_URI` empty, the app keeps all of this in memory until it stops.

**Sentry.** Sentry traces requests, workflow steps and model calls.
Its Mastra integration turns agent runs and model calls into `gen_ai` spans.
`src/mastra/image-filter.ts` replaces any image in a span before an exporter gets it.
`src/lib/sentry-privacy.ts` cuts query strings and skips the health check.
It also drops the prompts and answers of any trace that carries a photo.
With both DSNs empty, Sentry is off.

## Run it locally

You need Node 22 and pnpm.
`apps/web/.node-version` asks for Node 22, and `apps/web/.npmrc` makes pnpm use Node 22.22.3.
MongoDB runs in Docker.
For Gemma, you need a Google AI Studio key, or [Ollama](https://ollama.com) on your machine.

```bash
cd apps/web
cp .env.example .env.local     # then fill in the keys you have
pnpm install
docker run -d --name forking-paths-mongo -p 127.0.0.1:27017:27017 mongo:8
pnpm db:check                  # connects, creates the indexes and starts Mastra's storage
pnpm dev                       # http://localhost:3000
```

To run with no database, set `MONGODB_URI=` (empty).
The app then keeps everything in memory until it stops.

### Hosted Gemma on Google AI Studio

Create a key in [Google AI Studio](https://aistudio.google.com) and set `GOOGLE_GENERATIVE_AI_API_KEY`.
A free key works.
With `GEMMA_PROVIDER=auto`, the app uses Google AI Studio when the key is set, and Ollama when it is not.
On the free tier, Google may use the data that you send to improve its products.

### Keys and settings

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

### The photo check on your own machine

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

#### Ollama on your laptop, the app somewhere else

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

#### Play the local app on a phone

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

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/asi-mir/forking-paths)

The button reads the Blueprint in [`render.yaml`](render.yaml).
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

## Evals

Each eval is a script in `apps/web/scripts`. Run it from `apps/web`.
A report goes to `eval/runs/` (git-ignored), or to the folder that you give with `--out-dir`.
The first comment of each script lists its options.

| Command | What it measures |
|---|---|
| `pnpm eval:photos:fetch` | Downloads the 34 labelled photos in `eval/photos/manifest.json`. It resizes and re-encodes them as the phone does. |
| `pnpm eval:reader` | Runs the photos through the photo reader on each provider that is set up. It reports plausibility, the cue at the fork, the no-GPS pass rule and the time per photo. |
| `pnpm eval:reader:compare` | The same for Google and Ollama, side by side in one report. |
| `pnpm eval:coverage` | Counts places within 900 m of 15 points in 5 cities, from Wikipedia alone and with SerpApi Google Maps. It also checks if a 15-minute route fits. |
| `pnpm eval:facts` | Samples facts that generated cases cite, fetches each linked page again, and checks that the page says it. |
| `pnpm eval:reveals` | Samples lines that state facts, such as reveals, finales and bridge lines. It checks each line against the facts that it cites. |
| `pnpm eval:validator` | Counts the first drafts that pass the validator, the drafts that pass after one repair, and the most common errors. |
| `pnpm exec tsx scripts/generate-batch.ts` | Writes cases for a list of points, with one record for each. `eval:validator` reads these records. |
| `pnpm exec tsx scripts/store-demo-verdicts.ts` | Reads each desk sample photo 10 times with no GPS and stores the result. It also checks that the two fork photos lead to two different stops. |

These results come from runs on 2026-10-10 (UTC).

| What it measures | Result | Date |
|---|---|---|
| Right cue for 28 photos of street details, each shown with the cues of a fork (`eval:reader:compare`) | `gemma-4-26b-a4b-it` on Google AI Studio: 26 of 28. `gemma4:e4b` on Ollama (M1 Pro, 16 GB): 22 of 28. | 2026-10-10 |
| Right answer to "taken here or not" for 34 photos, 6 of them screens, rooms or wrong places (same run) | 34 of 34 for each model | 2026-10-10 |
| Median time per photo (same run) | 3,592 ms on Google AI Studio, 4,178 ms on Ollama | 2026-10-10 |
| Desk demo fork: the two sample photos lead to two different stops (`store-demo-verdicts.ts`, 10 runs per photo) | 10 of 10, on Google AI Studio | 2026-10-10 |
| Sampled facts that hold against their source: 30 of the 119 facts that 26 generated cases cite (`eval:facts`) | 30 of 30. Code matched 22 word for word on the fetched page. A review pass found 8 Google Maps descriptions in the stored SerpApi results. | 2026-10-10 |
| First drafts by `gemma-4-31b-it` that pass the validator with the current writer prompt (`generate-batch.ts`, 10 runs in 7 cities) | 8 of 9, and the ninth after one repair | 2026-10-10 |
| Cities with a generated case that passed the validator (`eval:validator`) | 8: Istanbul, London, New York, Berlin, San Francisco, Lisbon, Rome and Prague | 2026-10-10 |
| Places with a fact within 900 m of the Pantheon in Rome (`eval:coverage`) | 11 from Wikipedia alone, 21 with SerpApi Google Maps | 2026-10-10 |

## For contributors and coding agents

Read [`AGENTS.md`](AGENTS.md) first. It lists the commands, the rules and how to work.
Next.js 16 differs from older versions.
Before you change Next.js code, also read [`apps/web/AGENTS.md`](apps/web/AGENTS.md).

Run these from `apps/web`:

```bash
pnpm check     # typecheck, lint and unit tests; run it before every pull request
pnpm build     # production build; run it when you change config, routes or dependencies
NEXT_PUBLIC_SENTRY_DSN= pnpm build && pnpm e2e   # browser checks on a 390 × 844 phone screen
```

The browser checks start the production build on port 3200 and use the system Chrome.
They make no paid API calls, and they expect MongoDB on `127.0.0.1:27017`.

## Credits

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
  The file pages are in [`apps/web/public/demo/credits.json`](apps/web/public/demo/credits.json).
  - Francesco Bini: the inscription and the spout of the Bereketzade Fountain.
  - Basak: the plaque on the minaret of the Bereketzade Mosque.
  - Ali Osman Dilekoğlu: the Hasan Ağa Fountain.
  - Another Believer: the Camondo Stairs.
- **Eval photos:** 34 photos from Wikimedia Commons, used only by the evals.
  The file pages are in [`apps/web/eval/photos/manifest.json`](apps/web/eval/photos/manifest.json).

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

## Commits after the deadline

This project is an entry in the DEV Hacktoberfest Open-Source AI Challenge, Week 1: "Touch Grass".
The challenge closes on 2026-10-11 23:59 PDT.
Any commit after that time is listed here.

- (none yet)

## License

[MIT](LICENSE)
