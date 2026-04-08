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

Reports are written to:
- `qa/reports/research-comparison-benchmark-latest.json`
- `qa/reports/research-comparison-benchmark-latest.md`
