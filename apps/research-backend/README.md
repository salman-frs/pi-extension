# research-backend

Backend service for the `extensions/web-research` Pi extension.

## Purpose

This backend is designed to help Pi complete **technical tasks** that require external verification:
- search for relevant technical sources
- fetch clean docs / release-note content
- assemble grounded research bundles
- compare sources when Pi needs stronger evidence before acting

## Capabilities

- `GET /health`
- `GET /debug/traces`
- `GET /debug/metrics`
- `GET /debug/providers`
- `POST /v1/search`
- `POST /v1/fetch`
- `POST /v1/research`
- `POST /v1/analyze`
- `POST /v1/cache/invalidate`

Key behavior:
- inspectable ranking reasons and human-readable ranking explanations
- exact config / API / migration / repo / release selection
- canonical-result promotion for exact technical intents
- GitHub entity resolution for repo and release intent
- broader docs-aware markdown / LLM-text fetch preference plus heuristic docs-surface discovery
- structured HTML extraction for modern docs/framework-style pages
- typed error payloads, partial-success responses, and retry suggestions
- trust signals such as authority / freshness / extraction confidence
- request traces, provider health summaries, and in-memory debug telemetry
- optional provider circuit-break behavior for repeated upstream failures
- stable output contracts for Pi and future extension consumers
- research outputs with recommendation / best-practice / trade-off / risk / mitigation sections plus rationale fields
- source-comparison outputs with stronger decision-support fields

## Local start

### Full stack

From repo root:

```bash
npm run dev:research-stack:up
```

### Backend only

From repo root:

```bash
npm run dev:research-backend:bg
npm run dev:research-backend:logs
```

Or directly:

```bash
cd apps/research-backend
export PORT=8787
export SEARXNG_URL=http://localhost:8080
node src/server.js
```

## Pi integration

Point Pi to the backend:

```bash
export PI_RESEARCH_BASE_URL=http://localhost:8787
```

Then load the extension explicitly:

```bash
pi -e extensions/web-research/src/index.ts
```

## Environment variables

- `PORT` — backend port, default `8787`
- `HOST` — bind host, default `0.0.0.0`
- `REQUEST_TIMEOUT_MS` — request timeout, default `30000`
- `MAX_FETCHED_SOURCES` — max sources to fetch during research, default `6`
- `SEARXNG_URL` — discovery backend URL
- `RESEARCH_API_KEY` — optional bearer auth
- `USER_AGENT` — outgoing user agent string
- `PLAYWRIGHT_ENABLED` — enable browser fallback
- `PLAYWRIGHT_HEADLESS` — browser headless mode
- `BROWSER_MODE` — `auto` or `always`
- `STRUCTURED_EXTRACTION_ENABLED` — enable structured HTML extraction heuristics
- `ALLOW_PRIVATE_FETCH_HOSTS` — local/private host allowlist for controlled QA/dev only
- `CACHE_ENABLED` — enable in-memory caching
- `SEARCH_CACHE_TTL_MS`
- `FETCH_CACHE_TTL_MS`
- `RENDERED_FETCH_CACHE_TTL_MS`
- `RESEARCH_CACHE_TTL_MS`
- `ANALYZE_CACHE_TTL_MS`
- `TELEMETRY_ENABLED`
- `TRACE_MODE` — `minimal`, `standard`, or `debug` style trace verbosity label
- `TRACE_STORE_LIMIT` — in-memory recent trace buffer size
- `PROVIDER_CIRCUIT_BREAKER_ENABLED`
- `PROVIDER_FAILURE_THRESHOLD`
- `PROVIDER_COOLDOWN_MS`
- `RESEARCH_PROFILE` — deployment profile label such as `stable` or `docs-heavy`
- `SOURCE_QUALITY_RULES_PATH`
- `QUERY_NORMALIZATION_RULES_PATH`
- `DOCS_FETCH_RULES_PATH`

## QA

For the local full stack, copy the repo root env file first:

```bash
cp .env.example .env
```

Then set a real random `SEARXNG_SECRET` before `npm run dev:research-stack:up`.

Run before pushing:

```bash
npm run qa:e2e
npm run qa:benchmark
npm run qa:benchmark:live
```

Notes:
- `qa:benchmark:live` uses the faster default live profile
- `qa:benchmark:live:full` runs the full live sweep
- the live benchmark reuses an already-running local stack when available

Additional checks:

```bash
npm run qa:playwright
npm run qa:benchmark:live:full
npm run qa:benchmark:agent
npm run qa:benchmark:compare
```

## Debugging and observability

Useful endpoints:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/debug/providers
curl http://127.0.0.1:8787/debug/metrics
curl 'http://127.0.0.1:8787/debug/traces?limit=10'
```

These endpoints expose:
- deployment profile and trace mode
- provider health / degraded / circuit-open state
- in-memory counters and latency histograms
- recent trace summaries and stage timing

## Output contracts

See:
- `apps/research-backend/API.md`
- `apps/research-backend/OUTPUT_SCHEMA.md`

These documents describe the stable Phase 1+ additive response shapes intended for Pi and downstream extension consumers.

## Delivery notes

This service is meant to be shipped together with the `web-research` extension as the recommended backend path.

Repo source of truth:
- extension source in `extensions/web-research`
- backend source in `apps/research-backend`
- infra in `infra/`
- local `.pi/` shims are optional and ignored
