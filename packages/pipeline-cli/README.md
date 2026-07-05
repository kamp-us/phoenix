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

### `main-sync` — codified orchestrator main-sync with detached-HEAD auto-reattach (#1573)

The single runnable surface for the orchestrator's **main-sync** — bringing the shared
primary checkout up to `origin/main` before/after an unattended drain. It replaces the
hand-run `git fetch origin main && git merge --ff-only origin/main` that lived only in
operator memory (#1494 diagnosis, Unit C), and — the new capability — **auto-reattaches a
detached primary HEAD to `main` first**, so a stray detach during a heavy parallel drain
can't wedge the sync with a silent *"Not possible to fast-forward"* until a human notices.

Safe by construction (the pure core `main-sync.ts` decides, `command.ts` runs it):

- A reattach `git checkout main` is authorized **only when the working tree is clean**. A
  dirty off-`main` HEAD is **detect-and-surface** (`blocked-dirty`): the tool refuses to
  `checkout` and reports the dirt for a human, never blindly discarding uncommitted work —
  consistent with the #1494 incidents, which were always clean.
- The sync merge is `git merge --ff-only origin/main` — fast-forward only, so it never
  creates a merge commit and fails loudly rather than diverging the primary.
- **Dry-run by default:** with no flag it probes HEAD, prints the plan it *would* run, and
  exits 0 without touching anything (not even a fetch). `--execute` runs the plan.

```bash
# before/after a drain: print what main-sync would do (dry-run, nothing touched)
node packages/pipeline-cli/src/bin.ts main-sync

# actually reattach (if detached+clean) then fetch + merge --ff-only origin/main
node packages/pipeline-cli/src/bin.ts main-sync --execute
```

This is a **control-plane** surface (it drives the shared primary checkout); see
[`.patterns/worktree-agent-constraints.md`](../../.patterns/worktree-agent-constraints.md)
for the surrounding worktree/primary-checkout discipline it defends.

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

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build   # src → dist ESM
```
