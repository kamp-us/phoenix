# @kampus/pipeline-cli

The single subcommand-router home all pipeline tooling folds into (epic
[#994](https://github.com/kamp-us/phoenix/issues/994)). `pipeline-cli <tool> …`
dispatches to a registered tool; the tools themselves move in over Phase 2
(#997–#1002).

This is the **Phase-1 scaffold** (#996): the package shell, the registry
extension seam, the pure router core, and one tracer tool (`version`) wired end to
end. **No existing tool's logic is moved in yet.**

## Shape

Per the repo's mechanical-tooling idiom (`decisions-index` / `epic-ledger` /
`leak-guard`): a pure, unit-tested core + a thin Effect CLI bin.

- `src/registry.ts` — **the extension seam.** `registeredTools` is the array of
  `effect/unstable/cli` `Command`s the router exposes. A Phase-2 child folds its
  tool in by appending one `Command` here — and nothing else. The router and bin
  consume this array opaquely.
- `src/router.ts` — the **pure router core.** `dispatch(registry, argv)` resolves
  the first argv token to a registered tool (`Ok({ tool, rest })`), or fails with
  a clear `UnknownToolError` (unknown token) / `NoToolError` (no token). It owns
  no Effect runtime, so the dispatch contract is unit-testable directly (ADR 0040
  T0/T1) — the mirror of the runtime dispatch `Command.withSubcommands` does.
- `src/version.ts` — the `version` tracer tool, a normal registered tool.
- `src/bin.ts` — the `effect/unstable/cli` bin: `Command.withSubcommands(registeredTools)`,
  run via `NodeRuntime.runMain`.

## The extension seam

A later child registers its moved tool **without touching the router core**:

```ts
// src/registry.ts
import {myToolCommand} from "./my-tool.ts";
export const registeredTools: ReadonlyArray<RegisteredTool> = [versionCommand, myToolCommand];
```

That single append is the entire registration step. `router.ts` and `bin.ts`
never change — the router is closed for modification, the registry is open for
extension.

## Usage

```bash
# list the registered tools
node packages/pipeline-cli/src/bin.ts --help

# the Phase-1 tracer tool
node packages/pipeline-cli/src/bin.ts version

# dispatch to a registered tool (Phase-2 children)
node packages/pipeline-cli/src/bin.ts <tool> …
```

### `ship-digest` — the merged-since founder projection (#1595)

Renders a **founder-facing** ship digest for a `--since` window from a pre-gathered
merged-work entries JSON. Unlike `changelog-derive`'s builder-oriented Keep-a-Changelog
version sections, this groups **product vs infra** at the top level, then by **milestone**
(`Uncategorized` when none), then by **`type:*`** — a readout a non-builder can scan. An
entry with no milestone / area / type is surfaced under `Uncategorized`, never dropped.

The tool is the pure projection only: it consumes a pre-gathered entries JSON (each
`{issue?, pr, title, type?, milestone?, area?, joinedArea?, releaseState?}`), decoded with a
`Schema` at the boundary (a malformed/unreadable file is a typed non-zero exit). The git-log
`--since` + `gh` issue/milestone gather is the `/what-shipped` skill's job, not this tool's.

The product/infra split prefers the **PR `area:*` signal** (`area`, set join-free from the merged
PR's `area:product` / `area:infra` label — the convention in
[`gh-issue-intake-formats.md`](../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md)),
falling back to the gather's PR→issue→milestone join area (`joinedArea`) when the PR carries no
label, then defaulting to `Product` — see `resolveSection` in `digest.ts`.

The digest also carries the **merged-vs-live-to-users axis** (#1597): each entry's
`releaseState` (`live` / `awaiting-release` / `dark` / `unknown`) drives an inline live/dark
annotation per entry and a distinct **"Currently dark — awaiting your release"** callout that
lists the merged-but-not-yet-live work. Per
[ADR 0123](../../.decisions/0123-ship-digest-live-axis-from-authoritative-flagship-state.md)
the *sourcing* of that state is the `/what-shipped` gather's IO job — it reads authoritative
Cloudflare Flagship values via `cf-utils` for flag-gated work and treats non-flag-gated work as
live at merge; this pure core consumes the state as passed-in input. A merged item with no
resolvable state is surfaced as `unknown`, never silently treated as live.

```bash
node packages/pipeline-cli/src/bin.ts ship-digest derive --entries <file> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]
```

### `token-spend` — offline per-stage token-spend reporter (#1382)

Reconstructs a pipeline stage's billed token spend from its sub-agent transcript
(`<session>/subagents/agent-<id>.jsonl`) and prints the `formatSessionCost` headline over
the four-component breakdown — the one-command replacement for the hand-run `jq` in
[`.patterns/token-economics-measurement.md`](../../.patterns/token-economics-measurement.md)
§2. Claude Code does not persist its `cost.total_tokens` into the transcript, so the total
is summed from the per-message `usage` components over assistant messages
(`input + cache_creation + cache_read + output`); `cache_read` is kept on its own line as
the per-turn context-bloat signal, with `ex-cache-read` as the cross-run comparator. Reuses
`spawn-guard`'s `formatSessionCost` core read-only.

```bash
node packages/pipeline-cli/src/bin.ts token-spend <session>/subagents/agent-<id>.jsonl
```

### `pointer-guard` — fail-closed stale-pointer gate for `**/CLAUDE.md` (#988)

Reads the **backticked repo-path pointers** in every git-tracked `CLAUDE.md`
("operate from the repo root, never `apps/web`"; a pointer at
`apps/web/worker/dom/settings.ts`) and exits non-zero when one no longer resolves
on disk — the reference class `doc-links` (#638) cannot see, because it validates
markdown `[text](path)` links and *masks* code spans by construction. The two gates
are complementary: `doc-links` reads link targets and masks code; `pointer-guard`
reads code spans and ignores link syntax.

Precision over recall: it flags a token only when it is an unambiguous
repo-root-relative path (begins with a known top-level segment — `apps/`,
`packages/`, `.patterns/`, …; no scheme / glob / call / placeholder syntax), so a
`catalog:` / `type:bug` / `pnpm dev` / bare basename is left alone. Scoped to
`**/CLAUDE.md` — `.decisions/**` (immutable history that legitimately cites moved
code) and `.patterns/**` (which also cite external dependency source trees) are out
of scope. Fails closed on zero CLAUDE.md in scope (ADR 0092).

```bash
node packages/pipeline-cli/src/bin.ts pointer-guard check
```

### `trivial-diff` — deterministic fail-closed trivial-diff classifier (ADR 0120 §1, #1557)

Classifies a unified diff as `trivial` / `non-trivial` for the right-sized fan-out
([ADR 0120](../../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) §1, epic
[#1527](https://github.com/kamp-us/phoenix/issues/1527)). A diff is `trivial` only when a hard
AND of mechanical bounds clears: a single changed file that is doc/comment-only or under the
line bound `N` (1), with no new surface — dependency/manifest/migration/schema/config path or a
new `export`/`import`/`require(` module edge (2), and no control-plane path (3). The boundary is
the **live** `CONTROL_PLANE_RE`, re-resolved from `origin/main` at run time (REST raw,
`?ref=main`) — never a snapshot. Fail-closed by construction: a failed bound, a parse error, or
an unreadable boundary all return `non-trivial`, so a miss over-routes to the full (correct)
fan-out, never under-gates. The verdict word prints to **stdout**, the deciding reason to
**stderr**. This child builds the predicate only — it is **not** wired into the executor (#1559)
and adoption of the lighter gate is measurement-gated (ADR 0112, #1560).

```bash
git diff origin/main... | node packages/pipeline-cli/src/bin.ts trivial-diff classify
node packages/pipeline-cli/src/bin.ts trivial-diff classify --diff-file d.patch --max-lines 20
```

### `glossary-drift` — out-of-band glossary-drift backstop (ADR 0128 prong (b), #1748)

Diffs recent merges to `main` against [`.glossary/TERMS.md`](../../.glossary/TERMS.md) and
surfaces concept-level vocabulary drift the fail-closed `review-code` Step 3c gate
structurally cannot see — a term coined in a regular code PR that never routes through
`/adr` or `plan-epic`
([ADR 0128](../../.decisions/0128-glossary-concept-trigger-off-the-gate.md), the grounded
miss [#1726](https://github.com/kamp-us/phoenix/issues/1726): the release-lever
redefinition "split serving" / "kill switch" landed in a plain `feat(cf-utils)` PR with
zero glossary pressure). The gate reads structural path signals; this reads the *words* an
author used to name what they shipped.

The heuristic (pure core, `drift.ts`): pull quoted phrases and the 2–3-word windows of each
merge **subject** (bodies are prose — only their quoted phrases count), drop filler-bounded
and nested windows, and keep only phrases NOT already covered by a declared TERMS.md term
(substring-tolerant). It is **recall-biased on purpose** — a false positive costs a triage
glance, not a merge round-trip, so a coinage is never silently missed.

**Off the per-PR blocking path by construction:** the tool exits `0` whether or not drift is
found — a hit is a **filed `status:needs-triage` issue** (`--file-issue`, the `report` skill's
intake path), never a non-zero gate exit — so it can never block a merge. It runs on a weekly
schedule (`.github/workflows/glossary-drift.yml`), accepting the merge-cadence lag ADR 0128
prices in for staying off the fail-closed gate.

```bash
node packages/pipeline-cli/src/bin.ts glossary-drift sweep                # print candidates, exit 0
node packages/pipeline-cli/src/bin.ts glossary-drift sweep --window 50    # widen the merge window
node packages/pipeline-cli/src/bin.ts glossary-drift sweep --file-issue   # on drift, file a status:needs-triage issue
```

### `resume-policy` — capped TRANSIENT-only auto-resume for crashed workflows (ADR 0130, #1759)

The pure decision behind the ADR-0130 main-loop auto-resume discipline: given a crashed
dynamic Workflow's `status: failed` signal + the per-run resume ledger, decide `resume`
vs `surface`. It **composes** the [`failure-classifier`](src/tools/failure-classifier/)
(#1758): auto-resume **iff** the crash classifies TRANSIENT **and** this run is under the
K=2 cap; a LOGIC crash (including every default-deny) surfaces immediately with zero
resume attempts, and a run already resumed twice surfaces (`cap-reached`) — a persistent
"transient" is a masked LOGIC error, so the cap bounds token burn even under an optimistic
misclassification (the load-bearing safety property).

The cap is counted **per `resumeFromRunId`**: a fresh run starts a fresh K budget, so K
counts resumes of the *same* run, not a global tally. The `resume` action carries the
`{scriptPath, resumeFromRunId}` the driving session re-invokes with (completed `agent()`
stages replay from the journal cache). See the discipline this mechanism runs under:
[.patterns/workflow-driving-auto-resume.md](../../.patterns/workflow-driving-auto-resume.md)
and [ADR 0130](../../.decisions/0130-auto-resume-main-loop-discipline.md).

```bash
node packages/pipeline-cli/src/bin.ts resume-policy decide \
  --reason "null subagent result" --run-id run_abc \
  --script-path .claude/workflows/drive-issue.js --prior-resumes 0   # → resume
echo '{"reason":"TypeError: …","resumeFromRunId":"run_x","priorResumes":0}' \
  | node packages/pipeline-cli/src/bin.ts resume-policy decide         # → surface (logic)
```

### `bot-token` — mint a phoenix[bot] installation access token (ADR 0140, #1938)

Mints a `phoenix[bot]` GitHub App **installation** access token (JWT RS256 → installation
access token) for the pipeline's bot-authored PR-open + merge-queue enqueue. Per
[ADR 0140](../../.decisions/0140-phoenix-bot-authors-pipeline-prs-team-cp.md) the bot is the
distinct PR author, so any `@kamp-us/control-plane` member may approve a bot-authored §CP PR;
short-lived installation tokens replace any long-lived PAT (retires #382).

The `mint` core is pure + injectable (`buildAppJwt` signs the App JWT given an injected clock;
`mintInstallationToken` POSTs `/app/installations/<id>/access_tokens` given an injected `fetch`),
so the signing + request shape are unit-tested without a live App.

**Output contract (security-critical):** `bot-token mint` prints **only** the `ghs_` token to
stdout — the PEM is never printed, the token is never logged to stderr, and errors are generic
(HTTP status + the GitHub API `.message`, never credential material). So a caller does:

```bash
GH_TOKEN=$(node packages/pipeline-cli/src/bin.ts bot-token mint) gh pr create …
```

**Execution model — multi-machine, local-path per machine.** phoenix's pipeline runs on
**≥2 machines**: each operator (umut, cansirin, …) runs their own pipeline instance on their own
machine, so the PEM must be present on **each** machine that runs the pipeline. `isolation:"worktree"`
(see `.claude/workflows/drive-issue.js`) means the agents within one instance run in **local
worktrees** — a within-instance property, not a claim of one global machine. There is **no shared
secret manager**; the settled model is **local-path per machine** (the runbook below).

#### Provisioning a new operator's machine (runbook)

Only a machine that actually runs the pipeline needs the PEM. Provisioning one operator's machine
is independent — it does **not** block anyone else's runs.

1. **Place the PEM** at `~/.config/phoenix-bot/private-key.pem` (override via env
   `PHOENIX_BOT_PRIVATE_KEY_PATH`), out of the repo, `chmod 600`:

   ```bash
   mkdir -p ~/.config/phoenix-bot
   # write the PEM here (see step 3 for how it is delivered), then lock it down:
   chmod 600 ~/.config/phoenix-bot/private-key.pem
   ```

2. **Place the ids** in `~/.config/phoenix-bot/config.json` as `{"appId": "…", "installationId": "…"}`
   (or set env `PHOENIX_BOT_APP_ID` / `PHOENIX_BOT_INSTALLATION_ID`). The App id + installation id are
   the phoenix[bot] App's — get them from the App settings / an existing operator; they are **not**
   committed to the repo.

3. **Deliver the PEM securely, once.** The private key is the **bot's master key** — hand it to each
   operator **once over a secure channel** (a 1Password one-time-share link, or an encrypted message).
   **Never** send it in plaintext, **never** commit it, **never** paste it into a shared log.

After steps 1–2 the default invocation just works — no flags:

```bash
GH_TOKEN=$(node packages/pipeline-cli/src/bin.ts bot-token mint) gh pr create …
```

**The helper stays storage/manager-agnostic — the forward path is free.** It takes the PEM as either
a **path** or **content** (`--private-key` / env `PHOENIX_BOT_PRIVATE_KEY`) and never shells out to
`op` / any specific manager — that coupling would live in the caller, not the tool. The `--private-key`
**content** input is co-equal with the path input, so if operators ever adopt a **shared secret
manager**, it drops in with **zero code change** — resolve the PEM value in the caller and pipe it in:

```bash
# FORWARD PATH (not a current dependency) — if a shared manager is ever adopted:
GH_TOKEN=$(node packages/pipeline-cli/src/bin.ts bot-token mint \
  --private-key "$(op read op://vault/phoenix-bot/private-key)") gh pr create …
```

**Inputs** (flag → env fallback; ids also fall back to the config file; precedence flag/env > config-file):

| input | flag | env | default |
| --- | --- | --- | --- |
| app id | `--app-id` | `PHOENIX_BOT_APP_ID` | `config.json` `appId` |
| installation id | `--installation-id` | `PHOENIX_BOT_INSTALLATION_ID` | `config.json` `installationId` |
| PEM file path | `--private-key-path` | `PHOENIX_BOT_PRIVATE_KEY_PATH` | `~/.config/phoenix-bot/private-key.pem` |
| PEM content | `--private-key` | `PHOENIX_BOT_PRIVATE_KEY` | — (secret-injection case) |
| config path | `--config-path` | `PHOENIX_BOT_CONFIG_PATH` | `~/.config/phoenix-bot/config.json` |

Giving **both** `--private-key` and `--private-key-path` is an error; giving neither uses the default
local path. Fails closed (non-zero, generic stderr) on missing ids, an unreadable PEM, or a mint HTTP
failure.

```bash
node packages/pipeline-cli/src/bin.ts bot-token mint   # uses ~/.config/phoenix-bot/ by default
```

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build   # src → dist ESM
```
