# Benchmark taxonomy

## Purpose

This document defines benchmark taxonomy for `web-research`.

It keeps benchmark work aligned to real questions instead of only pass/fail endpoint checks.

## Suites

### 1. Regression suites
Used to protect already-shipped behavior.

Examples:
- deterministic quality benchmark
- package smoke
- E2E stack validation

### 2. Capability suites
Used to hill-climb quality on harder tasks.

Examples:
- live benchmark
- pi-agent task benchmark
- comparison benchmark

## Task families

### Exact retrieval
Measures:
- exact config lookup
- exact API reference lookup
- canonical docs selection
- official-first ranking under constraints

### Browsing and discovery
Measures:
- discovery of unfamiliar stacks
- repo / release / GitHub entity resolution
- retrieval persistence across harder open-web tasks

### Deep research
Measures:
- multi-source synthesis
- best-practice recommendations
- architecture trade-off research
- migration and upgrade guidance

### Extraction quality
Measures:
- markdown-aware fetch
- structured HTML extraction
- JS-heavy docs handling
- shell detection and fallback quality

### Agent workflow quality
Measures:
- tool choice discipline
- citation grounding
- sectioned answers
- consistency across repeated runs

## Failure buckets

Benchmark failures should be tagged into one of the following buckets:
- `official-or-canonical-retrieval`
- `retrieval-coverage`
- `ranking-and-explainability`
- `trust-and-freshness-signals`
- `extraction-and-fetch-quality`
- `synthesis-and-grounding`
- `agent-orchestration`
- `cache-and-performance`
- `other`

