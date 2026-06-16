# crabbox run-evidence

How phoenix turns a CI run into a SHA-bound, machine-readable **run-evidence bundle**, and how the merge gates consume it. This is the *shape* of the produce → adapt → store → consume flow and the manifest contract — the *why* (the gate trusts SHA-bound run proof, not prose) lives in [ADR 0054](../.decisions/0054-run-evidence-bundle.md); the storage/transport choice is [ADR 0056](../.decisions/0056-bundle-storage-transport.md).

## The flow

```
PR push
  │
  ▼
.github/workflows/run-evidence.yml      (producer — runs crabbox + the adapter)
  │   crabbox run --provider local-container → run-summary JSON (on stderr) + JUnit (in a tarball)
  ▼
@kampus/crabbox-manifest               (adapter — folds those into one manifest)
  │   manifest.json + junit.xml
  ▼
GH Actions artifact `run-evidence`      (storage — ADR 0056)
  │   fetched by PR head SHA
  ▼
ship-it / review-code                   (consumers — assert + cite the manifest)
```

Each stage owns one concern: the workflow knows crabbox's CLI surface, the adapter knows the manifest contract, the artifact is the transport, and the gates know how to assert/cite. A new producer (a remote runner, a different test harness) is valid the moment it emits a conforming manifest — the contract is the fields, not the producer (ADR 0054 §2).

## Producer — `.github/workflows/run-evidence.yml`

Runs on every `pull_request`. Concurrency-grouped on the ref with `cancel-in-progress`, so the latest head SHA's run is the one that wins.

- **Checks out the PR head, not the merge ref** (`ref: github.event.pull_request.head.sha`). On `pull_request`, `github.sha` is the synthetic merge commit; the manifest must bind to the *head*, so checkout, the in-container `git`, and the adapter's `--commit` all use the head SHA.
- **Pins crabbox** to a specific release (currently `v0.31.0`), downloads the `linux_amd64` build, and checksum-verifies it — crabbox is pre-1.0, so a pinned, verified binary keeps the run reproducible and fails loud on a tampered download.
- **Runs the unit suite inside crabbox's `local-container` provider** (Docker, which GH runners ship). The in-container command mirrors `ci.yml`'s `unit` job and adds vitest's JUnit reporter so there's an XML to pull back. Inside the container, pnpm is bootstrapped via `npm install -g pnpm` under a user `NPM_CONFIG_PREFIX` (`$HOME/.npm-global`) — the container image isn't the pnpm action's runner, so pnpm is installed fresh there.
- **Reads crabbox's two outputs** (the shapes verified in the #235 spike):
  - The **run-summary JSON** is the last line of crabbox's **stderr** (`--timing-json`), *not* a file under `.crabbox/runs/` and *not* stdout (stdout is the remote command's output). The producer captures stderr, scans it bottom-up for the JSON object carrying a `leaseId`, and slices that line into a summary file.
  - The **JUnit** is pulled from the `--artifact-glob` tarball at `.crabbox/runs/<lease-id>/<lease-id>-artifacts.tgz` — the only thing crabbox writes to disk.
- **Stamps `commit`** with `github.event.pull_request.head.sha` and **fails closed on drift**: after the adapter emits `manifest.json`, the workflow asserts `manifest.commit == head SHA` and exits red if it doesn't. A crabbox or adapter failure also fails the step red — never a silent green.
- **Uploads** `bundle/` (manifest + staged JUnit) as a GH Actions artifact named **`run-evidence`** with `if-no-files-found: error`.

## Adapter — `@kampus/crabbox-manifest` (`packages/crabbox-manifest/`)

A standalone product-code package (outside `.claude`/`.github`) that maps a crabbox run to a manifest. It's a pure transform with a thin CLI: read inputs, fold, emit JSON to stdout or `--output`; persistence and the gate read are not its job.

- **`Manifest.ts`** — the domain: the manifest as `effect/Schema`.
- **`crabbox.ts`** — the trust boundary: decodes untrusted crabbox run-summary JSON and parses the JUnit (tolerantly — a missing/garbage JUnit degrades to a zeroed `tests` block, never a crash).
- **`adapter.ts`** — the pure `buildManifest`: folds a decoded run-summary + JUnit + the stamped commit into a `Manifest`.
- **`commit.ts`** — a `Git` capability that resolves the head SHA when `--commit` isn't supplied (`git rev-parse HEAD`); a blank SHA is a hard error, never an empty field. (crabbox itself never surfaces the SHA — this is the #235 gap the adapter closes.)
- **`bin.ts`** — the CLI: `--run-summary`, optional `--junit`, `--commit`, `--run-url`, `--environment`, `--output`. Malformed input or an unresolvable commit fails the process non-zero.

How the fields are derived:

- **`checks[]`** comes from the run-summary's per-command `exitCode` (0 → `pass`, non-zero → `fail`), one entry per command (a single `run` check is the fallback when crabbox emits none).
- **`tests`** is folded from the JUnit: totals plus each failure's suite + message.
- **`lease`** carries through crabbox's provider/lease facts (it's a remote producer, ADR 0054 §5).

## The manifest contract (ADR 0054 §2)

One JSON manifest plus referenced artifacts. Defined as `effect/Schema` in `packages/crabbox-manifest/src/Manifest.ts`:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | number | yes | The manifest shape version (`SCHEMA_VERSION = 1`). |
| `commit` | string | yes | The head SHA the run executed against — the **binding key** the gates assert. |
| `run` | `RunMeta` | yes | `producer`, optional `url`, `timestamp`, optional `environment`. |
| `checks[]` | `Check[]` | yes | Per gate step: `name`, `status` (`pass`/`fail`), `exitCode`, optional `resultRef`. |
| `tests` | `TestSummary` | yes | `total`/`passed`/`failed`/`skipped` + each `failure`'s suite/name/message. Zeroed-but-present when no JUnit ran. |
| `logs` | `LogsRef` | yes | A `ref` to captured stdout/stderr. |
| `lease` | `LeaseMeta` | no | Provider/lease metadata, populated only by a remote producer. |

> **`schemaVersion` is a `number`** (`Schema.Number`, value `1`) — not a string. The ADR 0054 prose drifted on this; the code (and therefore the bundle on the wire) emits a number. Consumers compare it as a number.

The contract is *fields, not producer*: required = `commit`/`run`/`checks[]`/`tests`/`logs`; optional = `coverage`/`media`/`lease`. Anything emitting a conforming manifest is a valid producer.

## Storage / transport (ADR 0056)

The bundle is a **GitHub Actions run artifact** named `run-evidence`, produced by the `run-evidence` workflow. There's no R2 bucket, no PR-comment payload — the artifact *is* the bundle store.

A consumer fetches it by the **PR head SHA**:

1. Resolve the PR's head SHA.
2. Find the `run-evidence` workflow run with **that exact `head_sha`** (never just the latest run on the branch — the head-SHA filter is what binds the evidence to the commit being merged).
3. Download the `run-evidence` artifact and read `manifest.json`.

The artifact *name* is the fetch contract — renaming it breaks both consumers and ADR 0056.

## Consumers

Both gates inline the same `gh api` fetch rather than share a helper — minor duplication is the deliberate trade over coupling two control-plane skills at the seam (extract a helper if a third consumer appears).

- **[`ship-it`](../.claude/skills/ship-it/SKILL.md) Step 3.5 (guard 2)** — the SHA-bound proof *behind* CI-green. Asserts `manifest.commit == head SHA` and that every check passed. Additive: it doesn't replace the PASS-marker read or the CI-green read; all three must hold before merge.
- **[`review-code`](../.claude/skills/review-code/SKILL.md) Step 2** — reads the bundle and cites its structured `checks[]`/`tests` numbers (counts, failing suite names) as per-criterion evidence instead of scraping logs. **Graceful degrade**: an absent/stale bundle (including `manifest.commit != head SHA`) is treated as absent — note it and fall back to current behavior, never error. The bundle is a verdict *input*, never merge authority.
