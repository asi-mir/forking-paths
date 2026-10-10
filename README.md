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

Keep everything on your machine with local Gemma:

```bash
ollama pull gemma4:e4b
# in apps/web/.env.local
GEMMA_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Or keep only the photo check on your machine: `GEMMA_READER_PROVIDER=ollama`.

## For contributors and coding agents

Start with [`AGENTS.md`](AGENTS.md): commands, hard rules and how to work.

## Credits

Gemma 4 (Apache 2.0) by Google. Facts from Wikipedia (CC BY-SA). Built with Next.js, Mastra,
ElevenLabs, SerpApi, MongoDB Atlas, Sentry and Render. Full credits will be listed here.

## Commits after the deadline

The challenge closes on 2026-10-11 23:59 PDT. Any commit after that time is listed here.

- (none yet)

## License

[MIT](LICENSE)
