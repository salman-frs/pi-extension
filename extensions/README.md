# extensions

Local development wrappers and repo-friendly Pi extension entrypoints live here.

Each extension should follow this shape:

```text
extensions/<extension-name>/
├─ package.json
├─ README.md
└─ src/
   └─ index.ts
```

If you want Pi to auto-discover an extension while developing inside this repo, you can optionally add a thin local shim in:

```text
.pi/extensions/<extension-name>/
```

That shim should re-export the extension entrypoint from `extensions/<extension-name>/src/index.ts`.

Important:
- `.pi/` is local-only
- `.pi/` is gitignored
- canonical publishable source can live under `packages/`
- `extensions/<extension-name>/src/index.ts` can be a thin wrapper that re-exports the canonical package entrypoint
