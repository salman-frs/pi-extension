# Web Research Output Schema

This document describes the stable Phase 1 output contract for the `web-research` backend.

## Goal

These outputs are designed to be consumed by:
- Pi directly
- the `pi-web-research` package
- future Pi extensions that want grounded internet context without re-implementing research logic

## Contract metadata

Every primary response now includes metadata with:
- `contract`
- `schemaVersion`
- `outputKind`
- `consumerHints`

Current schema version:
- `2026-04-08.v1`

Contracts:
- search: `pi.web-research.search.v1`
- fetch: `pi.web-research.fetch.v1`
- research: `pi.web-research.research.v1`
- analyze: `pi.web-research.analyze.v1`

## Search output

Top-level shape:
- `status`
- `results[]`
- `errors[]`
- `metadata`

Stable result fields:
- `title`
- `url`
- `snippet`
- `sourceType`
- `sourceCategory`
- `resultType`
- `domain`
- `publishedAt`
- `score`
- `trustSignals`
- `ranking`

Intended use:
- candidate discovery
- exact source selection
- downstream extension retrieval seed

## Fetch output

Top-level shape:
- `url`
- `canonicalUrl`
- `title`
- `content`
- `extractionProfile`
- `fetchMode`
- `contentType`
- `status`
- `metadata`

Stable fields of interest:
- `metadata.strategy`
- `metadata.codeAware`
- `metadata.extractionConfidence`
- `metadata.fallbackRecommendations`
- `metadata.consumerHints`

Intended use:
- exact source retrieval
- quote/citation support
- downstream evidence hydration

## Research output

Top-level shape:
- `status`
- `answer`
- `recommendation`
- `summary`
- `findings[]`
- `bestPractices[]`
- `tradeOffs[]`
- `risks[]`
- `mitigations[]`
- `selectionRationale`
- `confidenceRationale`
- `freshnessRationale`
- `agreements[]`
- `disagreements[]`
- `sources[]`
- `confidence`
- `gaps[]`
- `failures[]`
- `retrySuggestions[]`
- `metadata`

Important metadata:
- `metadata.responseSections`
- `metadata.selection`
- `metadata.selection.canonicalProof`
- `metadata.selection.bundleCoverage`
- `metadata.queryPlan`
- `metadata.queryPlan.constraintProfile.taskProfile`
- `metadata.searchDiagnostics`
- `metadata.traceGrades`
- `metadata.partialResult`
- `metadata.rationales`
- `metadata.consumerHints`

Intended use:
- direct Pi research answers
- recommendation/context input for higher-level extensions
- best-practice/trade-off/risk extraction
- canonical-anchor inspection and downstream quality gating for harder technical tasks

## Analyze output

Top-level shape:
- `summary`
- `agreements[]`
- `disagreements[]`
- `strongestEvidence[]`
- `officialPosition`
- `communityPosition`
- `recommendation`
- `uncertainties[]`
- `gaps[]`
- `sources[]`
- `metadata`

Important metadata:
- `metadata.responseSections`
- `metadata.comparisonMode`
- `metadata.consumerHints`

Intended use:
- source comparison
- official-vs-community comparisons
- downstream structured evidence review

## Compatibility guidance

Phase 1 compatibility promise:
- existing fields remain valid
- new fields are additive
- downstream consumers should treat unknown fields as optional
- downstream consumers should prefer `metadata.contract` and `metadata.schemaVersion` when branching on shape

## Best-practice consumer guidance

If another extension consumes these outputs:
1. check `metadata.contract`
2. check `metadata.schemaVersion`
3. use only stable fields for automation
4. treat natural-language sections as assistive, not as machine-hard guarantees
5. fall back gracefully when optional sections are missing
