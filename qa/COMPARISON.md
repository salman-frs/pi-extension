# Research Comparison Benchmark

This repo now includes a comparison harness:

- `qa/research-comparison-benchmark.mjs`

## Purpose

The comparison benchmark is not the main quality gate.
Its job is to compare the default `web-research` stack against simpler or external baselines without changing the product contract.

## Built-in providers

Current built-in providers:
- `default-web-research`
- `simple-search-baseline`
- `tavily-baseline` (optional, enabled with `TAVILY_API_KEY`)

## Optional Tavily baseline

You can enable a real hosted search baseline with:

```bash
export TAVILY_API_KEY=...
# optional:
export TAVILY_BASE_URL=https://api.tavily.com/search
export TAVILY_SEARCH_DEPTH=advanced
export TAVILY_MAX_RESULTS=4
```

## External comparison scaffold

You can also enable a custom external comparison adapter by setting:

```bash
export RESEARCH_COMPARISON_EXTERNAL_URL=http://your-adapter.example/v1/research
```

The adapter is expected to accept:

```json
{
  "question": "...",
  "mode": "best-practice"
}
```

And return a response shaped roughly like:

```json
{
  "answer": "...",
  "recommendation": "...",
  "sources": [
    {
      "title": "...",
      "url": "...",
      "resultType": "...",
      "sourceCategory": "...",
      "sourceType": "..."
    }
  ],
  "bestPractices": ["..."],
  "risks": ["..."],
  "mitigations": ["..."]
}
```

This scaffold makes it possible to compare the default stack against hosted vendor flows or other research systems later.

## Run it

Make sure the local backend is healthy first, then run:

```bash
npm run qa:benchmark:compare
```

If you place optional comparison secrets like `TAVILY_API_KEY` in the repo root `.env`, the comparison harness now loads them automatically.

Reports are written to:
- `qa/reports/research-comparison-benchmark-latest.json`
- `qa/reports/research-comparison-benchmark-latest.md`
