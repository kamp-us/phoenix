# @kampus/orphan-sweep

The **orphan integration-stage sweep** for issue
[#690](https://github.com/kamp-us/phoenix/issues/690). It bounds the unbounded leak the
#689 run-unique stage names surfaced: a partial integration `beforeAll` deploy can
orphan its **real, remote** Cloudflare D1 (and worker), and because stage names are now
run-unique, a later run never overwrites it — so orphan `it-*` resources **accumulate**
on the one shared account. This sweep is that bound.

It is a `packages/` Effect CLI per the repo's Node-over-Python convention (the
`flake-rate` / `preview-seed` idiom) — a pure, unit-tested core plus a thin
`effect/unstable/cli` bin.

## The safety property (the whole point)

A sweep that deletes a **prod**, **named-dev**, or **open-PR** resource is catastrophic
and irreversible (ADR 0032: these are real remote D1s, never emulated). So the pure core
(`src/orphan-sweep.ts`) is **allow-by-pattern + deny-by-protection**, both anchored:

1. An **unrecognized** resource (not `phoenix-phoenix-…`) is NEVER swept.
2. A **protected** stage (`prod`, plus any `--protect` named-dev) is NEVER swept — this
   wins even over an `it-`/`pr-` allow-match.
3. An **`it-*`** integration stage is deleted (`orphan-integration`).
4. A **`pr-<n>`** preview is kept for an OPEN PR; a CLOSED PR's preview is deleted only
   with `--sweep-closed-previews` (off by default — #690's mandate is the `it-*` leak).

The match anchors are exact (`it-` start, not substring; `^pr-\d+$`), and the protection
ordering is exhaustively unit-tested in `src/orphan-sweep.unit.test.ts` — the load-bearing
test is that prod / named-dev / open-PR can never enter the delete set.

## Physical name shape

Grounded in `.github/workflows/deploy.yml` ("Resolve web preview D1 id") and
`apps/web/alchemy.run.ts`: alchemy names a resource `${stack}-${id}-${stage}-${suffix}`,
`_`→`-` sanitized. Stack is `phoenix`; the worker id is `phoenix`, the D1 id
`phoenix_db`→`phoenix-db`. So for stage `<stage>`:

- worker = `phoenix-phoenix-<stage>-<suffix>`
- D1 = `phoenix-phoenix-db-<stage>-<suffix>`

An integration stage is `it-…`, prod is `prod`, a preview is `pr-<n>`.

## Shape

- **`src/orphan-sweep.ts`** — the pure, IO-free core: `computeSweepPlan(resources,
  protection)` → `{toDelete, kept}` with a reason on every entry. Total over already-listed
  `CfResource[]`; never touches the network. This is where the safety policy lives.
- **`src/report.ts`** — pure rendering of the plan.
- **`src/cloudflare.ts`** — the CF REST boundary. Schema decodes the untrusted
  list envelopes; the `Cloudflare` `Context.Service` shells `curl` over
  `ChildProcessSpawner` to list workers + D1 and delete one. Credentials come from
  `$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID` at runtime, never from source.
- **`src/github.ts`** — the `gh api` boundary for the OPEN PR numbers (the previews to
  keep). REST only (GraphQL is broken on the kamp-us org). Mirrors `@kampus/flake-rate`.
- **`src/bin.ts`** — the `effect/unstable/cli` `sweep` command. **DRY-RUN by default**:
  prints the plan and exits without touching the account; only `--execute` deletes.
- **`src/*.unit.test.ts`** — the core's unit tests (the protection invariants, the
  anchors, the reasons, the edge cases).

## Usage

```bash
# Dry-run (default): print the plan, delete nothing.
node packages/orphan-sweep/src/bin.ts sweep

# Protect named-dev stages on top of the always-protected prod.
node packages/orphan-sweep/src/bin.ts sweep --protect umut --protect demo

# Actually delete the orphan it-* resources.
node packages/orphan-sweep/src/bin.ts sweep --execute

# Also reap closed PRs' pr-<n> previews.
node packages/orphan-sweep/src/bin.ts sweep --execute --sweep-closed-previews
```

`sweep` resolves the target repo for the open-PR lookup per ADR
[0062](../../.decisions/0062-repo-as-config-plugin.md) §1
(`CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`). It needs
`$CLOUDFLARE_ACCOUNT_ID` + `$CLOUDFLARE_API_TOKEN` in the environment for the CF calls.

## Wiring the scheduled sweep (control-plane follow-up — for a human)

This package deliberately adds **no** `.github/workflows` change: a scheduled workflow
is control-plane (it banks for a human merge), and it needs a **rotated** CF token
provisioned as an Actions secret. The follow-up, tracked on issue
[#690](https://github.com/kamp-us/phoenix/issues/690):

1. Add a new, separate scheduled workflow (e.g. `orphan-sweep.yml`, `schedule:` cron —
   never a `ci.yml` job-add) that runs `node packages/orphan-sweep/src/bin.ts sweep --execute`.
2. Provide a **rotated, narrowly-scoped** CF API token (Workers Scripts + D1 edit) as the
   `CLOUDFLARE_API_TOKEN` Actions secret, with `CLOUDFLARE_ACCOUNT_ID`.
3. Run dry-run first (omit `--execute`) and eyeball the plan before arming the schedule.

Until then the CLI is fully usable on-demand and dry-run-safe.
