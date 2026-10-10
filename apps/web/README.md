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

## Where code goes

Routes in `src/app`, pure game rules in `src/quest` (unit-tested), external services in
`src/lib` and `src/research`, Mastra agents/tools/workflows in `src/mastra`.

## Bundled docs (current, trust them over memory)

- Next.js: `node_modules/next/dist/docs/`
- Mastra: `node_modules/@mastra/core/dist/docs/references/` (and each `@mastra/*` package's `dist/docs/`)
