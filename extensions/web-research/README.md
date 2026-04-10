# web-research

Pi extension that gives the agent four grounded research tools:
- `search_web`
- `fetch_url`
- `research_query`
- `analyze_sources`

This directory is a thin local development wrapper.

Canonical publishable source lives in:
- `packages/pi-web-research`

Repo-friendly dev entrypoint lives here:
- `extensions/web-research`

## Intended use

This extension is optimized for **technical task completion**:
- official docs lookup
- exact config / API lookup
- GitHub repo / release / issue discovery
- migration and breaking-change research
- implementation support when Pi needs external verification

## Recommended setup

### Start the backend stack

From repo root:

```bash
npm run dev:research-stack:up
```

### Export backend config for Pi

```bash
export PI_RESEARCH_BASE_URL=http://localhost:8787
```

Optional:

```bash
export PI_RESEARCH_API_KEY=...
export PI_RESEARCH_TIMEOUT_MS=30000
export PI_RESEARCH_USER_AGENT=web-research/0.5.0
```

### Load the extension

Explicit local dev load path:

```bash
pi -e extensions/web-research/src/index.ts
```

Or install the publishable Pi package:

```bash
pi install npm:pi-web-research@0.5.0
```

## Runtime modes

### 1. Backend mode
Recommended for full quality.

Requires:
- `PI_RESEARCH_BASE_URL`

Backend endpoints:
- `GET /health`
- `POST /v1/search`
- `POST /v1/fetch`
- `POST /v1/research`
- `POST /v1/analyze`

### 2. Direct SearXNG fallback mode
If you only want search + lightweight fetch without the backend:

```bash
export PI_RESEARCH_SEARXNG_URL=http://localhost:8080
```

This mode is useful for experimentation, but backend mode is the intended delivery path.

## Command UX

Primary command:
- `/web-research` — interactive menu for status + configuration

Menu actions:
- show status
- save backend URL
- save API key
- save SearXNG fallback URL
- adjust advanced settings
- clear saved config

Saved config can live in either:
- project scope: `.pi/web-research.json`
- global scope: `~/.pi/agent/web-research.json`

Environment variables still override saved config when present.

In `/web-research status`:
- `directSearchFallback` refers to the extension's optional direct SearXNG fallback URL
- `backendDiscovery` refers to whether the configured backend itself has discovery/search enabled

These are different settings. In normal backend mode, the backend may have discovery enabled even when `directSearchFallback` is `not set`.

## Local `.pi` shim

If you personally want Pi auto-discovery in this repo, you can create a local `.pi/extensions/...` shim.

