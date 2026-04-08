# API Contract

## Auth

If `RESEARCH_API_KEY` is configured on the backend, all `POST /v1/*` endpoints require:

```http
Authorization: Bearer <token>
```

`GET /health` remains unauthenticated.

---

## Health

### `GET /health`
Returns service health, config summary, and cache stats.

---

## Search

### `POST /v1/search`

Request:

```json
{
  "query": "next.js proxyClientMaxBodySize docs",
  "freshness": "year",
  "maxResults": 8,
  "preferredDomains": ["nextjs.org"],
  "blockedDomains": ["example.com"],
  "sourceType": "docs"
}
```

Response:

```json
{
  "results": [
    {
      "title": "...",
      "url": "...",
      "snippet": "...",
      "domain": "...",
      "sourceType": "docs",
      "sourceCategory": "official-docs",
      "resultType": "configuration-reference",
      "publishedAt": "...",
      "score": 42,
      "ranking": {
        "reasons": ["category:official-docs:+16", "result-type:configuration-reference:+22"],
        "contributions": {
          "category:official-docs": 16,
          "result-type:configuration-reference": 22
        }
      }
    }
  ],
  "metadata": {
    "contract": "pi.web-research.search.v1",
    "schemaVersion": "2026-04-08.v1",
    "outputKind": "search",
    "consumerHints": {
      "recommendedNextTools": ["fetch_url", "research_query"]
    },
    "requestId": "req_...",
    "durationMs": 38
  }
}
```

---

## Fetch

### `POST /v1/fetch`

Request:

```json
{
  "url": "https://example.com/article",
  "mode": "auto",
  "extractionProfile": "article"
}
```

Response:

```json
{
  "url": "...",
  "canonicalUrl": "...",
  "title": "...",
  "content": "cleaned text",
  "extractionProfile": "article",
  "fetchMode": "auto",
  "contentType": "text/html",
  "status": 200,
  "metadata": {
    "contract": "pi.web-research.fetch.v1",
    "schemaVersion": "2026-04-08.v1",
    "outputKind": "fetch",
    "strategy": "docs-markdown-fetch",
    "sourceVariant": "docs-markdown",
    "resolvedUrl": "https://developers.cloudflare.com/agents/llms-full.txt",
    "codeAware": {
      "headings": ["..."],
      "codeSnippets": ["..."],
      "callouts": ["..."]
    },
    "cache": {
      "hit": false,
      "namespace": "fetch"
    },
    "requestId": "req_...",
    "durationMs": 91
  }
}
```

---

## Research

### `POST /v1/research`

Request:

```json
{
  "question": "current best practices for react server caching",
  "mode": "best-practice",
  "freshness": "month",
  "numberOfSources": 5,
  "sourcePolicy": "prefer official docs first",
  "outputDepth": "standard",
  "preferredDomains": ["react.dev"],
  "blockedDomains": []
}
```

Response:

```json
{
  "answer": "...",
  "recommendation": "Prefer starting from the canonical upgrade guide and validate against supporting sources before acting.",
  "summary": "...",
  "findings": ["..."],
  "bestPractices": ["Use the official migration guide as the implementation anchor."],
  "tradeOffs": ["Release notes are broader, while migration guides are more implementation-specific."],
  "risks": ["Breaking changes may still require manual validation in edge cases."],
  "mitigations": ["Use staged rollout and regression checks before broad adoption."],
  "agreements": ["..."],
  "disagreements": ["..."],
  "sources": [
    {
      "title": "...",
      "url": "...",
      "sourceType": "docs",
      "sourceCategory": "official-docs",
      "resultType": "migration-guide",
      "publishedAt": "...",
      "snippet": "...",
      "excerpt": "...",
      "score": 17,
      "ranking": {
        "reasons": ["docs-source:+10"]
      }
    }
  ],
  "confidence": "medium",
  "gaps": ["..."],
  "metadata": {
    "contract": "pi.web-research.research.v1",
    "schemaVersion": "2026-04-08.v1",
    "outputKind": "research",
    "responseSections": ["answer", "recommendation", "summary", "bestPractices", "tradeOffs", "risks", "mitigations", "sources", "confidence", "gaps"],
    "strategy": "web-research-workflow",
    "selection": {
      "anchorTitle": "React 19 Upgrade Guide",
      "anchorUrl": "https://react.dev/...",
      "reasons": [{ "url": "https://react.dev/...", "reason": "anchor-source" }]
    },
    "queryPlan": {
      "intent": "technical-change",
      "constraintProfile": {
        "queryMode": "migration",
        "canonicalPreference": "migration",
        "exactTerms": ["useActionState"]
      }
    },
    "searchDiagnostics": {
      "queryRewrites": ["..."],
      "plan": {
        "intent": "discovery",
        "constraintProfile": {
          "queryMode": "novel-discovery"
        }
      },
      "providers": [
        {
          "name": "github-web",
          "diagnostics": {
            "directResolvers": [{ "candidate": "vercel/next.js", "matched": true, "type": "release" }]
          }
        }
      ]
    },
    "cache": {
      "hit": false,
      "namespace": "research"
    },
    "requestId": "req_..."
  }
}
```

---

## Analyze

### `POST /v1/analyze`

Request:

```json
{
  "question": "compare these sources",
  "comparisonMode": "official-vs-community",
  "sources": [
    {
      "url": "https://example.com/a"
    },
    {
      "title": "Source B",
      "content": "pre-fetched content here"
    }
  ]
}
```

Response:

```json
{
  "summary": "...",
  "agreements": ["..."],
  "disagreements": ["..."],
  "strongestEvidence": ["..."],
  "gaps": ["..."],
  "sources": [],
  "metadata": {
    "contract": "pi.web-research.analyze.v1",
    "schemaVersion": "2026-04-08.v1",
    "outputKind": "analyze",
    "responseSections": ["summary", "agreements", "disagreements", "strongestEvidence", "gaps", "sources"],
    "comparisonMode": "official-vs-community",
    "cache": {
      "hit": false,
      "namespace": "analyze"
    },
    "requestId": "req_..."
  }
}
```

---

## Stable output contract

See `apps/research-backend/OUTPUT_SCHEMA.md` for the stable Phase 1 contract intended for Pi and downstream extension consumers.

## Cache invalidation

### `POST /v1/cache/invalidate`

Request:

```json
{
  "namespace": "research"
}
```

Response:

```json
{
  "ok": true,
  "namespace": "research",
  "cache": {
    "search": {
      "entries": 1,
      "hits": 2,
      "misses": 1,
      "writes": 1
    }
  }
}
```
