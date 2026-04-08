# pi-extension

Monorepo for Pi extensions and the backend services, QA harnesses, and local tooling they need.

## What this repo contains

This repo is designed for **practical Pi task completion**, especially when Pi needs to go outside the local codebase to:
- verify facts
- look up official docs
- inspect release notes and changelogs
- find GitHub issues, discussions, repos, and examples
- assemble grounded technical research before taking action

The current flagship extension is:
- `packages/pi-web-research` — canonical publishable Pi package for web research
- `extensions/web-research` — thin local dev wrapper for the package
- `apps/research-backend` — backend that powers search, fetch, research, and analysis workflows

## Repo structure

- `extensions/` — local dev wrappers / repo-friendly extension entrypoints
- `apps/` — supporting backend services
- `packages/` — shared internal packages
- `infra/` — local stack / Docker config
- `qa/` — deterministic, live, and agent-facing QA harnesses
- `tools/` — local developer tooling

## Design direction

This repo is intentionally optimized for **technical and coding-agent workflows**.

Current priorities:
- official docs lookup
- exact config / API lookup
- GitHub repo / release / issue discovery
- migration and breaking-change research
- coding-task support from grounded external sources

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create local env for the stack

```bash
cp .env.example .env
```

Then set a real random value for `SEARXNG_SECRET` in `.env`.

### 3. Start the research stack

```bash
npm run dev:research-stack:up
npm run dev:research-stack:logs
```

Stop it with:

```bash
npm run dev:research-stack:down
```

### 4. Point Pi to the backend

```bash
export PI_RESEARCH_BASE_URL=http://localhost:8787
```

### 5. Load the extension in Pi

Recommended explicit load path during local development:

```bash
pi -e extensions/web-research/src/index.ts
```

Or install the publishable Pi package:

```bash
pi install npm:pi-web-research@0.1.0
```

Then inside Pi:

```text
/reload
/web-research
```

## Local development

### Backend only

Useful when working mostly on fetch / analysis paths:

```bash
npm run dev:research-backend:bg
npm run dev:research-backend:logs
npm run dev:research-backend:stop
```

### Background task helper

```bash
npm run task -- status
npm run task -- logs research-backend --lines 100
```

## Optional local `.pi` shim

If you want Pi auto-discovery in your local checkout, you can create a local shim under `.pi/extensions/...`.

Canonical source of truth stays in:
- `packages/pi-web-research`

## QA

Run the main validation suite before pushing:

```bash
npm run qa:e2e
npm run qa:benchmark
npm run qa:benchmark:live
```

Notes:
- `qa:benchmark:live` is now the **faster default live profile**
- use `qa:benchmark:live:full` for the full live sweep
- if the stack is already running, the live benchmark reuses it instead of tearing it down and bringing it back up

Additional checks:

```bash
npm run qa:playwright
npm run qa:benchmark:live:full
npm run qa:benchmark:agent
```

Reports are written to:
- `qa/reports/`

## Package delivery

For GitHub + npm delivery, the repo includes a publishable Pi package:
- `packages/pi-web-research`

Recommended end-user install path:

```bash
pi install npm:pi-web-research@0.1.0
```

Update path:

```bash
pi update
```

## Current status snapshot

The stack is strongest today at:
- docs-first technical lookup
- exact config and API retrieval
- GitHub issue / discussion / repo / release lookup
- migration / release-note research
- grounded fetch of modern docs, including markdown/LLM-text preference for supported domains
