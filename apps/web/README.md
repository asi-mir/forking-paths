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

## Where code goes

Routes in `src/app`, pure game rules in `src/quest` (unit-tested), external services in
`src/lib` and `src/research`, Mastra agents/tools/workflows in `src/mastra`.

## Bundled docs (current, trust them over memory)

- Next.js: `node_modules/next/dist/docs/`
- Mastra: `node_modules/@mastra/core/dist/docs/references/` (and each `@mastra/*` package's `dist/docs/`)
