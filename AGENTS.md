# AGENTS.md

The contract for every coding agent in this repo (Claude Code, Codex, Copilot, Cursor).
It is a map, not a manual: follow the links for detail.

## What this is

**Forking Paths** is an open-source, voice-first mystery game for a phone.
An open-weight model (Gemma) turns facts about the streets around the player — each
with its link — into a short walking mystery. The player hears a clue, locks the phone,
walks, and at each fork photographs the one detail they think matters; that detail picks
the next stop, and every route ends at the same answer. It is our entry for the
DEV **Hacktoberfest Open-Source AI Challenge, Week 1: "Touch Grass"**.

**Deadline: Sun 2026-10-11 23:59 PDT = Mon 2026-10-12 09:59 Istanbul (+03).**

## Map

| You need | Go to |
|---|---|
| What the game does, how to run it | `README.md` |
| The web app (Next.js 16 + Mastra) | `apps/web/` |
| Next.js 16 rules for agents | `apps/web/AGENTS.md` |
| Environment variables (names only) | `apps/web/.env.example` |

## Commands

Run from `apps/web/`. Node 22 is required (`.node-version`; `.npmrc` makes pnpm use it).

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm check        # typecheck + lint + unit tests — must pass before every PR
pnpm build        # production build — must pass before merging to main
```

Next.js 16 differs from older versions. Read `apps/web/AGENTS.md` and the bundled
docs in `apps/web/node_modules/next/dist/docs/` before you write Next.js code.

## Hard rules

1. **Open core.** Product reasoning (quest writing, photo checks, recaps) runs on
   open-weight models only: Gemma, or an open model we fine-tune. Never add a closed
   LLM (GPT, Claude, Gemini) to the product runtime. Coding assistants that *build*
   the project are fine.
2. **No invented facts in the game.** The game states a fact about a place only if it
   came from a source we fetched (fact ID + URL). Code rejects a quest whose reveal
   cites an unknown fact.
3. **No invented numbers.** Every number in the README comes from an eval run, a trace,
   or a logged outdoor run.
4. **Player safety.** Clues never send a player onto a road, into private property,
   or to photograph people. Photos are re-encoded on the device (no EXIF) before upload.
5. **Secrets.** Never commit a secret. Values live in `apps/web/.env.local` and in the
   hosting dashboard. `.env.example` holds names only.
6. **Git.** Never push or force-push to `main`. One branch per change; use a git
   worktree when agents work in parallel. Merge through a pull request (squash).
   `main` must always build and deploy.
7. **Challenge rule.** Commits made after the deadline must be listed in `README.md`.
8. **Local only.** Agents do not deploy, and do not create or link hosting projects. Never
   use a deployment CLI, login or saved setting on the owner's machine (Vercel, Netlify,
   Render CLI, `create-next-app` saved preferences, the owner's company accounts). Run
   everything locally; the owner handles deployment.

## How to work

1. Branch: `feat/<slug>` (or `fix/`, `docs/`, `chore/`).
2. Run `pnpm check`; run `pnpm build` when you touch config, routes or dependencies.
   For UI work, check a 390 × 844 viewport.
3. Commit messages and pull request titles say what changed, in plain words, in
   Conventional Commits, e.g. `feat(quest): grounded clue writer`. No co-author or tool
   lines: no `Co-Authored-By:` for Claude or any AI tool, no "Generated with …".

## When unsure

Ask one clear question. Do not guess scope or names.
