# @phoenix/crabbox-manifest

The crabbox → **ADR 0054 §2** run-evidence adapter — a pure transform that maps a crabbox run
into a SHA-bound bundle manifest the `ship-it`/`review-code` gates consume.

It closes the one gap [spike #235](https://github.com/kamp-us/phoenix/issues/235) found: crabbox
seeds git and resolves `HEAD` in-box but never surfaces the SHA, so it **stamps `commit`** (from
`git rev-parse HEAD`, or a supplied ref) and **derives `checks[]` from per-command `exitCode`**.

```
crabbox output (untrusted)        boundary (decode)          pure transform        manifest
──────────────────────────        ─────────────────          ──────────────        ────────
run-summary JSON           ──►   decodeRunSummary    ──►  RunSummary    ─┐
JUnit XML (--artifact-glob)──►   parseJUnit          ──►  TestSummary   ─┼─► buildManifest ─► Manifest
git rev-parse HEAD         ──►   Git.headSha         ──►  commit (SHA)  ─┘                    (ADR 0054 §2)
```

## The surface

- **Domain (`effect/Schema`)** — `Manifest` (`schemaVersion`/`commit`/`run`/`checks[]`/`tests`/
  `logs`/`lease?`), `Check` (`Schema.Literals` status), `TestSummary`, `RunMeta`. `manifestToJson`
  serializes to canonical tab-indented JSON.
- **`buildManifest(AdapterInput): Manifest`** — the pure `(RunSummary + TestSummary + commit +
  logs) => Manifest` core. No IO, no throw — `checks[]` from `exitCode`, JUnit folded into `tests`,
  crabbox lease facts carried through. Same inputs → byte-identical manifest.
- **`decodeRunSummary` / `parseRunSummaryJson`** — the crabbox trust boundary: decode untrusted
  run-summary JSON (the #235-verified shape) into `RunSummary`; malformed JSON / shape fails a typed
  `CrabboxParseError` / `SchemaError`.
- **`parseJUnit(string | null): TestSummary`** — tolerant JUnit XML → totals + each failure's
  suite + message. A missing/empty/garbage file degrades to a zeroed `tests` (never crashes).
- **`Git` / `GitLive`** — the commit-stamping capability over `ChildProcessSpawner`. `headSha`
  runs `git rev-parse HEAD`; a missing/empty SHA is a hard `MissingCommitError` (the binding key is
  never blank, per ADR 0054 §1).

## CLI

```bash
node src/bin.ts \
  --run-summary .crabbox/runs/<id>/summary.json \
  --junit test-results/junit.xml \
  --logs https://crabbox/.../logs \
  --output bundle/manifest.json
```

Omit `--commit` to stamp `git rev-parse HEAD`; omit `--junit` for a config-only run (zeroed
`tests`); omit `--output` to emit to stdout. Malformed input or an unresolvable commit exits
non-zero — the CLI never emits a half-formed or commit-blank manifest.

## Scope

Pure transform only. **Persistence/transport** of the bundle is the CI producer's job
([#245](https://github.com/kamp-us/phoenix/issues/245)); the **gate reading** it is
[#246](https://github.com/kamp-us/phoenix/issues/246)/[#247](https://github.com/kamp-us/phoenix/issues/247).
