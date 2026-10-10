# Forking Paths — the city is the interface

> An entry for the DEV **Hacktoberfest Open-Source AI Challenge, Week 1: "Touch Grass"**
> (Oct 5–11, 2026). Status: **in development**.

A voice mystery about the real streets around you. An open-weight model (**Gemma 4**) turns
facts about your neighbourhood into a short walking mystery. You hear a clue, lock your phone,
and walk. At each fork you photograph the one detail you think matters — and that detail
picks where you walk next. Every route ends at the same answer.

- **Every fact comes with its link.** Places and facts come from Google Maps and Google
  Search (via SerpApi) and Wikipedia; your case file links every one.
- **Your photo picks the path.** At a fork, Gemma reads your detail and picks the next stop;
  the case file shows the road you did not take.
- **A narrator, not a screen.** A designed character voice (ElevenLabs) guides the walk;
  nothing plays while you walk, so you hear the street.
- **Your photos can stay on your machine.** The photo check runs on Gemma from Google AI
  Studio (the public demo) or on your own laptop with Ollama — one environment variable.

## How it works

```
phone ──► Next.js ──► Mastra workflow: research (SerpApi, Wikipedia)
                         → Gemma writes a forked mystery (cited facts only)
                         → validator → MongoDB
run start ──► ElevenLabs voices the quest (cached)
phone photo ──► GPS passes the stop + Gemma reads the detail ──► the detail's cue picks the next stop
everything ──► Sentry traces
```

## Run it locally

Requirements: Node 22, pnpm, and either a Google AI Studio key or [Ollama](https://ollama.com).

```bash
cd apps/web
cp .env.example .env.local      # fill in the keys you have
pnpm install
pnpm dev                        # http://localhost:3000
```

To run Gemma on your own machine instead of Google AI Studio, see the next section.

## The photo check on your own machine

The photo check can run on your own machine; the demo uses Google's API (free tier, where
Google may use the data). Either way it is Gemma 4: 26B on Google AI Studio, E4B on a laptop
with [Ollama](https://ollama.com). The receipt at the end of a walk says which one read your
photos, e.g. "Gemma 4 E4B on my laptop (Ollama)" or "Gemma 4 26B on Google AI Studio", and
the photo request's spans in Sentry carry it as `checkedBy` (e.g. `ollama/gemma4:e4b`).

### Ollama on the same machine as the app

```bash
ollama pull gemma4:e4b
# in apps/web/.env.local
GEMMA_READER_PROVIDER=ollama          # the photo check only; GEMMA_PROVIDER=ollama for everything
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma4:e4b
```

The app loads the model when a walk starts, so the first photo does not wait for it.

### The app elsewhere, Ollama on your laptop, through a tunnel

Ollama has no login of its own: never expose port 11434 without one. Put basic auth at the
tunnel's edge, and let the app send the header.

1. Pick a password (8+ characters) and build the header value:

   ```bash
   printf 'playtest:%s' "$PASSWORD" | base64     # → OLLAMA_AUTH_HEADER="Basic <this>"
   ```

2. Start a tunnel that checks basic auth **and rewrites the Host header**. Ollama answers
   `403 Forbidden` to a request whose Host is not its own (checked with Ollama 0.33), and a
   tunnel forwards its public host name unless told otherwise.

   - ngrok (free account): `ngrok http 11434 --basic-auth "playtest:$PASSWORD" --host-header="localhost:11434"`
   - A tunnel with no auth of its own, such as a Cloudflare quick tunnel: put a small proxy
     with basic auth in front of Ollama. With [Caddy](https://caddyserver.com):

     ```
     # Caddyfile — caddy run --config Caddyfile
     :11435 {
       basic_auth {
         playtest <hash from: caddy hash-password>
       }
       reverse_proxy localhost:11434 {
         header_up Host localhost:11434
       }
     }
     ```

     then `cloudflared tunnel --url http://localhost:11435`.

3. Where the app runs:

   ```bash
   GEMMA_READER_PROVIDER=ollama
   OLLAMA_BASE_URL=https://<your-tunnel-host>/v1
   OLLAMA_AUTH_HEADER=Basic <base64 of playtest:password>
   ```

   The app sends `OLLAMA_AUTH_HEADER` with every request to Ollama (`Header-Name: value` works
   too, for a tunnel with its own header), only over https or to localhost, and never logs it.
   A user name or password inside `OLLAMA_BASE_URL` is refused. In the server log, `HTTP 401`
   means the header is wrong; `HTTP 403` usually means the Host header was not rewritten.

4. Keep the laptop awake and on power during the walk. Stop the tunnel afterwards.

Through the tunnel, the photo and the position sent with it reach your laptop; the rest of the
walk is unchanged. With GPS at the stop, local Gemma gets 25 s to read a photo (Google gets
10 s); past that the stop still passes on GPS, and a fork takes the nearest way on.

### Play the local app on a phone

Phones give a web page GPS only over HTTPS, so `http://<laptop-ip>:3000` will not do. Serve a
production build and open it through any HTTPS tunnel:

```bash
cd apps/web
pnpm build && pnpm start                         # http://localhost:3000
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

Open the `https://` address on the phone. Outdoors the phone is on mobile data, so it reaches
the laptop only through the tunnel. With `GEMMA_READER_PROVIDER=ollama` and Ollama on the same
laptop, this is the only tunnel you need, and the photo check stays on the laptop. Anyone with
the address can play, and their photos then reach your laptop: share it only with your
testers, and stop it after the walk. (`pnpm dev` works too once the tunnel's host is in
`allowedDevOrigins` in `next.config.ts`, but a production build is lighter on a laptop that is
also running Gemma.)

## Try it from your desk

Open `/demo` to play the saved Karaköy case (below Galata Tower, Istanbul) without walking or
sharing your location. Each stop offers sample photos, and the fork offers two that show
different details, so you can take both ways and see the route change; you can also use your
own photo. With no GPS, Gemma's check decides whether a photo was taken at the place. If the
live model fails or is rate-limited, a sample photo uses its stored result, labelled as such
(`pnpm exec tsx scripts/store-demo-verdicts.ts` reads each sample 10 times and stores it).
`/demo/near` generates a quest near you, or in a city you pick, and shows every line, fork and
fact with its link.

## For contributors and coding agents

Start with [`AGENTS.md`](AGENTS.md): commands, hard rules and how to work.

## Credits

Gemma 4 (Apache 2.0) by Google. Facts from Wikipedia (CC BY-SA). Built with Next.js, Mastra,
ElevenLabs, SerpApi, MongoDB Atlas, Sentry and Render. Full credits will be listed here.

Desk demo sample photos (Wikimedia Commons, CC BY-SA 4.0, cropped and resized; file pages in
[`apps/web/public/demo/credits.json`](apps/web/public/demo/credits.json)): Francesco Bini (the
Bereketzade Fountain's inscription and spout), Basak (the Bereketzade Mosque's minaret plaque),
Ali Osman Dilekoğlu (the Hasan Ağa Fountain) and Another Believer (the Camondo Stairs).

## Commits after the deadline

The challenge closes on 2026-10-11 23:59 PDT. Any commit after that time is listed here.

- (none yet)

## License

[MIT](LICENSE)
