# pi-web-research

Canonical publishable Pi package for the `web-research` extension.

`web-research` is intended to be a reusable research layer:
- Pi can use it directly
- future Pi extensions can rely on it for grounded web context
- higher-level extensions should build on its search/fetch/research outputs instead of re-implementing internet research from scratch

## Install into Pi

Recommended:

```bash
pi install npm:pi-web-research@0.3.0
```

Then reload Pi or restart it, and use:

```text
/web-research
```

## Update

```bash
pi update
```

If you pin a version explicitly, install the newer version you want:

```bash
pi install npm:pi-web-research@0.3.0
```

## Backend config

After install, configure with:

```text
/web-research
```

The menu lets you:
- view status
- save backend URL
- save API key
- save SearXNG fallback URL
- adjust advanced settings
- clear saved config

## Native smoke test in this repo

After installing the published package into Pi, you can run:

```bash
npm run qa:package-smoke
```

That script verifies the installed package can register `/web-research` and execute `search_web`, `fetch_url`, and `research_query` through Pi's native RPC flow.
