# @kampus/anka-ops

The **operator CLI for anka-built apps** — a framework-tier ops language over hidden infra
(epic [#2089](https://github.com/kamp-us/phoenix/issues/2089), extending
[ADR 0045](../../.decisions/0045-kampus-client-cli.md)).

## What it is

`anka-ops` is the single authenticated surface an operator (human or agent) uses to run
scoped operations against the infra behind an anka-built app — the ops-language counterpart
to the product-facing surfaces. It is a `packages/` Effect CLI per the repo's
Node-over-Python convention (the `cf-utils` / `orphan-sweep` idiom): a pure, unit-tested core
plus a thin `effect/unstable/cli` bin, run with `node src/bin.ts`.

This package ships:

- the root `anka-ops` command and the verb-group extension point,
- the scoped, keychain-first **operator credential** every verb group reuses, and
- the `flag` verb group ([#3133](https://github.com/kamp-us/phoenix/issues/3133)) — the
  domain-language surface over Flagship, folding the `@kampus/cf-utils` core (see below).

The `report` verb group (generic AE-read + product-supplied catalog,
[#3134](https://github.com/kamp-us/phoenix/issues/3134)) builds on this skeleton next — the
mechanism-vs-content seam keeps any product-specific query or catalog content out of this core.

## The credential seam

`anka-ops` rolls **no** new credential store. It reuses
[`@kampus/cf-credentials`](../cf-credentials/README.md) — the shared macOS-Keychain
Cloudflare-credential seam ([ADR 0045](../../.decisions/0045-kampus-client-cli.md), #1730) —
so every CF operator CLI depends on one auth package:

```bash
node packages/anka-ops/src/bin.ts auth login    # paste a scoped operator token → OS keychain
node packages/anka-ops/src/bin.ts auth status    # where credentials resolve from + do they authenticate
node packages/anka-ops/src/bin.ts auth logout    # clear the stored credentials
```

Credentials resolve **keychain-first** (after `auth login`), falling back to
`$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID` — the env-var path CI keeps using,
byte-for-byte unchanged. A missing or unauthorized credential surfaces a **typed error** on
the Effect `E` channel, rendered by `NodeRuntime.runMain` — never a raw stack trace.

## The `flag` verb group — fold cf-utils Flagship

`anka-ops flag` is the operator-language surface over Flagship. It **folds** the
[`@kampus/cf-utils`](../cf-utils/README.md) pure core (`flag.ts`'s no-match-split math +
renderers, `flagship.ts`'s read/write clients, #1726) rather than re-implementing it — the only
new logic is the operator-verb → cf-utils-lever mapping in `src/flag.ts`, fully unit-tested.

```bash
node packages/anka-ops/src/bin.ts flag get <key> [--env <env>]   # read a flag's live serving state
node packages/anka-ops/src/bin.ts flag open <key> --env <env>    # release on (≡ cf-utils set on: 100% no-match split)
node packages/anka-ops/src/bin.ts flag close <key> --env <env>   # kill (clear the split + default off)
node packages/anka-ops/src/bin.ts flag graduate <key>            # verify fully open in prod, file the retirement chore
```

- **`open`** maps onto the cf-utils lever `set on` — the 100% no-match percentage split, never a
  `defaultVariation` flip. **`close`** maps onto `set off` — the true kill switch (clear the split
  *and* set the default off).
- **`open`/`close` dry-run by default**; the live flip happens only under `--execute`. A non-TTY
  caller proceeds (logged for the audit record), a TTY human is confirmed first (ADR 0134).
- **`graduate`** never flips anything: it verifies the flag is fully open in prod (the retirement
  trigger in [product-development-cycle.md](../../product-development-cycle.md) §Retirement — 100%
  and stable for one release) and files the retirement chore via the `report` skill idiom
  (`status:needs-triage`), so `write-code` drains the flag deletion. Dry-run by default,
  `--execute` to file. An unknown key/env fails with a typed error listing the known keys/envs.

## The non-TTY posture (ADR 0134)

A write verb's confirmation is decided by the pure `decideConfirm` core (`src/posture.ts`):
a **non-interactive** caller (agent/CI, no TTY) **proceeds without a prompt** and the action
is logged for the audit record; an **interactive** human is prompted and only an affirmative
answer proceeds. The humans-release boundary ([ADR 0083](../../.decisions/0083-agents-deploy-humans-release.md))
lives at the audit trail, not as a structural TTY refuse — the same posture `cf-utils`
already uses. Keeping the decision IO-free is what lets it be exhaustively unit-tested.

## Shape

- **`src/cli.ts`** — the root `anka-ops` command tree, the `VERB_GROUPS` registry (the single
  extension point verb groups fold into), and `AnkaOpsRuntimeLayer` (the shared credential seam +
  the cf-utils Flagship clients every verb group resolves through).
- **`src/flag.ts`** — the pure `flag` adapter core: the operator-verb → cf-utils-lever mapping and
  the graduate-eligibility decision. No serving-plan math (that stays in `@kampus/cf-utils`).
- **`src/flag-command.ts`** — the thin `flag` verb-group IO shell wiring the pure adapter to the
  cf-utils read/write clients.
- **`src/posture.ts`** — the pure ADR 0134 non-TTY decision core reused by write verbs.
- **`src/bin.ts`** — the thin `effect/unstable/cli` shell: wire the command tree, provide the
  runtime layer, run via `NodeRuntime.runMain`.
- **`src/*.unit.test.ts`** — the pure cores' unit tests: the verb-wiring/registry-no-drift
  contract and the non-TTY posture.

## Testing

```bash
pnpm --filter @kampus/anka-ops test    # the unit tier — pure cores, no real keychain, no real CF
```
