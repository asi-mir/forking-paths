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

## Where code goes

Routes in `src/app`, pure game rules in `src/quest` (unit-tested), external services in
`src/lib` and `src/research`, Mastra agents/tools/workflows in `src/mastra`.

## Bundled docs (current, trust them over memory)

- Next.js: `node_modules/next/dist/docs/`
- Mastra: `node_modules/@mastra/core/dist/docs/references/` (and each `@mastra/*` package's `dist/docs/`)
