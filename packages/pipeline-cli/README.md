# @kampus/pipeline-cli

The single subcommand-router home all pipeline tooling folds into (epic
[#994](https://github.com/kamp-us/phoenix/issues/994)). `pipeline-cli <tool> …`
dispatches to a registered tool — the deterministic, unit-tested pipeline utilities
the crew reaches for instead of hand-rolling `gh`/`jq`/`git` glue.

The tools have long since folded in: `src/registry.ts`'s `registeredTools` wires the
full set (44 tools + the `version` tracer). A new tool registers by appending one
`Command` to that array (the [extension seam](#the-extension-seam)) — nothing else.

## Discovering the tools — `pipeline-cli commands` (the rot-proof index)

The authoritative, always-current list is **generated from the registry**, so it can't
drift the way a hand-maintained list does (the failure this README's old Phase-1 framing
was itself an instance of — #3316). Run it on demand:

```bash
# one line per registered tool: name · one-line purpose (the discovery map — #3316)
node packages/pipeline-cli/src/bin.ts commands compact

# CI gate: red if any registered tool ships without a one-line description (fail-closed)
node packages/pipeline-cli/src/bin.ts commands check
```

`commands compact` mirrors `decisions-index compact` (ADR 0126/0129, "discovery is the
CLAUDE.md contract"): it derives purely from each `Command`'s own `name` + `description`,
so a newly-registered tool appears automatically. The per-tool `###` sections below are a
**curated subset with usage detail** — for the complete list, run `commands compact`.

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
# the generated tool index (name · one-line purpose) — start here (#3316)
node packages/pipeline-cli/src/bin.ts commands compact

# the effect/unstable/cli --help listing of registered tools
node packages/pipeline-cli/src/bin.ts --help

# dispatch to a registered tool
node packages/pipeline-cli/src/bin.ts <tool> …
```

### `epic-lock` — the ADR-0059 `status:planning` epic-lock (#2098)

The two-layer epic-plan lock the `plan-epic` / `review-plan` skills use to serialize
concurrent mutation of one epic's children, extracted from the ~50-line inline `jq` glue
each skill hand-rolled. It runs the ADR-0115 agent-distinguishable-claim protocol over the
ADR-0059 `status:planning` lock-label:

- **`epic-lock acquire <epic>`** — coarse-label Rule-0 defer → POST the label (fail-closed on
  a 422 missing label) → POST the `claim: <session-id> · <ts>` comment → checkpoint-GET →
  resolve the **earliest authorized claim** (write+ collaborators only, ADR 0055). **Exits 0
  only when the lock is ours;** every fail-closed back-off (held label, 422 missing label,
  failed claim post, lost co-acquire, missing `CLAUDE_CODE_SESSION_ID`) prints a reason on
  stderr and exits **non-zero**, so a caller branches on exit status.
- **`epic-lock release <epic>`** — retract our own claim comment(s) (re-found by session id)
  and DELETE the label (404-benign, **loud** on any other DELETE failure — a swallowed DELETE
  leaks the lock and wedges the epic).

The session id is `$CLAUDE_CODE_SESSION_ID`; `--session` overrides it (the orchestrated
delegated-token path, and tests). The pure claim-resolution decision (`claim-resolution.ts`)
is IO-free and unit-tested table-driven; `github.ts` is the REST-only `gh api` boundary — the
**template `github.ts` service pattern** the epic #994 Phase-2 families copy.

```bash
# acquire (exit 0 = held by us; non-zero = backed off, do not mutate)
node packages/pipeline-cli/src/bin.ts epic-lock acquire 1234 && echo "hold the lock"
# release on every terminal path
node packages/pipeline-cli/src/bin.ts epic-lock release 1234
```

### `verdict` — the ADR-0058 SHA-bound gate-verdict read/post glue (#2102)

The SHA-bound verdict read/post glue the `review-*` / `ship-it` / `write-code`-repair skills
each hand-rolled inline as `jq`, extracted into one deterministic, unit-tested tool. The
**pure core** (`verdict-match.ts`) is the verdict-match decision: given a PR's comment bodies
+ the current HEAD sha + the write+ authorized-author set, is HEAD reviewed in this gate's
namespace, and by which marker? — with the discriminator the inline reads got subtly wrong
made explicit (a SHA-less advisory does **not** satisfy a SHA-bound check; a verdict bound to a
stale head does **not** pass; newest-authorized-marker wins). It re-encodes the ADR-0058 match
semantics; it does **not** change what any gate verifies.

- **`verdict read --pr N --gate <code|doc|skill|design> [--expect PASS|FAIL] [--head <sha>]`** —
  resolve the (PR, gate) verdict against the PR's current head (author-gated to write+
  collaborators, ADR 0055). Prints the resolved outcome as JSON on stdout (`_tag` of
  `current`/`stale`/`sha-less`/`none`, plus the bound sha + comment id); **exits 0 only when HEAD
  is reviewed with the `--expect` polarity** (default `PASS`; `FAIL` is the `write-code`-repair
  seam), non-zero with a named refusal reason on stderr otherwise — so a caller branches on exit
  status.
- **`verdict post --pr N --gate <g> [--body-file <f>]`** — the ADR-0058 rule-2 **upsert**: read
  the composed verdict body (from `--body-file` or stdin), refuse fail-closed if its first line is
  not *this* gate's marker (the cross-namespace emission bug), then PATCH our own prior marker in
  the namespace if one exists, else POST — exactly one verdict comment per (PR, gate). It then
  **re-fetches the landed comment and re-runs `emissionDefect` on its body** (the folded-in
  self-verify, #3019): a body that passed the input gate but did not land as a clean in-namespace,
  leak-free marker fails the post (non-zero) instead of reporting a false success — closing the
  "called `post` but skipped the separate verify line" gap. Prints `patched <id>` / `posted <id>`.

The pure match core (`verdict-match.ts`) is IO-free and unit-tested table-driven; `github.ts` is
the REST-only `gh api` boundary (the `epic-lock` `github.ts` service pattern).

```bash
# is PR 123's doc verdict a current-head PASS? (exit 0 = reviewed)
node packages/pipeline-cli/src/bin.ts verdict read --pr 123 --gate doc && echo "merge-ready"
# upsert a composed review-doc verdict (one comment per gate)
node packages/pipeline-cli/src/bin.ts verdict post --pr 123 --gate doc --body-file "$VERDICT_FILE"
```

### `intake-dedup` — the ADR-0181 unified intake-dedup check (#2992)

The "is there already an open issue for this?" query the `report` (pre-file) and `triage`
(intake board-read + split-pre-create) skills each used to hand-maintain inline, extracted
into one deterministic, unit-tested tool wired at both intake seams — so the agent path and
the human path share one implementation and cannot drift. The **pure core**
(`dedup-match.ts`) is IO-free: `tokenize` + `searchQuery` shape free text into a deterministic
GitHub search, and `rankCandidates` fuses the two result sources (the read-after-write
`needs-triage` queue + the eventually-consistent search index) into one deduped,
title-overlap-ranked candidate list. `github.ts` is the REST-only `gh api` boundary (the
`verdict`/`epic-lock` `github.ts` service pattern).

- **`intake-dedup check --query "<text>" [--exclude N] [--label L] [--limit N]`** — prints one
  `#<n>\t<title>` line per candidate duplicate to stdout (empty ⇒ no likely match) and the
  count on stderr. Advisory, not an oracle (a duplicate is cheap to close, a lost observation
  is gone): **always exits 0**. `--exclude` omits an issue number (the one being deduped at the
  triage seam, so it never flags itself); `--label` overrides the intake-queue label
  (default `status:needs-triage`). It resolves the target repo itself (ADR 0062 §1).

```bash
# pre-file check (report seam) — pass the title + a few keywords, not a hand-built query
node packages/pipeline-cli/src/bin.ts intake-dedup check --query "retry helper swallows abort reason"
# triage intake check — dedup the issue against the board, excluding itself
node packages/pipeline-cli/src/bin.ts intake-dedup check --query "<title + keywords>" --exclude 2802
```

### `leak-guard` — personal-data leak gate for shared artifacts (#173, #2357, #2796, #3019)

Four verbs over the shared deny-list-per-surface core (`findLeaks` for doc files, the stricter
`findCommentLeaks` for comment bodies):

- **`leak-guard scan <file>…`** — the changed-file gate (#173): reports any user-local
  filesystem path (`/Users/<name>`, `~/.claude`, `~/code/…`, `/vault/…`) leaking into a
  shared **doc surface** (`.md`, `.decisions/`, `.patterns/`), exit 2 on a hit. CI hands it
  every changed file; the core (`findLeaks`) self-scopes to doc surfaces.
- **`leak-guard scan-comment [--body-file <f>]`** — the pre-post net for a single PR/issue
  **comment body** (stdin or `--body-file`, #2796): a comment is unconditionally a public
  artifact, so `findCommentLeaks` runs with no doc-surface gate and the stricter temp-root
  patterns (`/var/folders`, `/private/tmp`, `/tmp`) — exit 2 on a leak, run before a
  `gh api …/comments` post.
- **`leak-guard scan-pr <PR>`** — the **landed-comment** scan (#3019): fan `findCommentLeaks`
  over a PR's already-posted comments — the issue conversation **and** the inline review
  comments, fetched over `gh api` REST — reporting each leak as `<kind> comment <id>: <span>`,
  exit 2 on a live leak. This is the check no emit-side guard can offer: it catches a leaked
  comment **regardless of emit path** (a raw `gh api -f body=@$FILE` bypass, #3018/#3005), which
  is why `ship-it` runs it as a pre-enqueue preflight (its Step 3.7) and refuses to merge on a hit.
- **`leak-guard sweep [--dir <d>] [--root <r>]`** — the pipeline-crew sanitization sweep
  (#2357, crew epic #2342 Phase 4). The crew plugin ships **zero real operator data**, so
  its whole tree is swept by a **purely generic, pattern-based** personal-data detector —
  it catches only **structural pattern classes**, never a hardcoded person identifier:
  machine-local / home / absolute **paths** (`/Users/<name>`, `/home/<name>`, `~/.claude`,
  `~/code/…`, `/vault/…`), any **email** (`local@domain.tld`), **tmux pane ids** (`%N`), and
  **personal-memory references** (`MEMORY.md`, `/memory/`, `feedback_*`/`reference_*`/`project_*`
  slug shapes). Fails closed (exit 1) on any hit **and** on a zero-file scope (ADR 0092),
  mirroring the readme-guard/fanout-guard directory-check idiom. The pure match-class core
  (`crew-leak.ts`, unit-tested class by class) carries **no named operator deny-list** — a
  bare first name in prose is deliberately NOT caught (generic over named: the high-value
  leaks are all pattern-detectable, whereas bare-name matching is low-value and
  false-positive-prone), so the README's deliberately *fictional* seam examples (`@robin`,
  `Robin Operator`) pass while real personal data is caught.

```bash
# changed-file doc-surface scan (exit 2 on a leak)
node packages/pipeline-cli/src/bin.ts leak-guard scan path/to/file.md

# scan a PR's landed comments (issue + review) — the ship-it pre-enqueue preflight (exit 2 on a leak)
node packages/pipeline-cli/src/bin.ts leak-guard scan-pr 123

# sweep the whole pipeline-crew tree (exit 1 on any hit or zero scope)
node packages/pipeline-cli/src/bin.ts leak-guard sweep
```

Both modes are wired as CI gates (`leak-guard.yml` for `scan`, `crew-leak-guard.yml` for
`sweep`) — the scan lives once in the tool, never re-grepped in the workflow.

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

#### `--post-merge` — the gentle post-merge refresh (#2056)

Every pipeline agent works in an isolated `git worktree` (correctly — ADR 0109), so
*nobody ever pulls the primary checkout*. Under the merge queue (ADR 0132) a PR lands
GitHub-side with **no local `git merge` on the primary** to advance it, so the owner's
checkout **silently drifts behind `origin/main`** — and any read of the local tree (the
next-free ADR number, "does file X exist yet", "is this already on main") is then made
against stale state. A local `post-merge` lefthook can't fix this (the triggering local
merge never happens under the queue); the refresh must be driven by a pipeline step that
*knows* a PR merged (`ship-it` / the orchestrator), which invokes:

```bash
# after a PR lands: fast-forward the primary IF it's on a clean 'main', else no-op (exit 0)
node packages/pipeline-cli/src/bin.ts main-sync --post-merge --execute
```

`--post-merge` is the **HEAD-preserving** counterpart to the default drain-sync — it is
gentle where the default is aggressive:

- It **only** fast-forwards when the primary is already on a **clean `main`** — the one
  state where `merge --ff-only` is both possible and non-destructive.
- On a **non-`main` branch** (the owner is on their own feature branch, or detached) **or a
  dirty tree**, it **leaves the checkout alone and exits 0** — it never reattaches, never
  moves HEAD, never touches uncommitted work. Failing-to-refresh is acceptable (a stale
  checkout is no worse than today); clobbering the owner or yanking them off their branch
  is not.
- It still `--ff-only`, so even on the fast-forward path it aborts on any divergence and
  never force-updates.

The refresh **wiring** into `ship-it`'s post-landed step is tracked separately (#2417); this
tool ships the safe refresh *mechanism* those steps invoke.

This is a **control-plane** surface (it drives the shared primary checkout); see
[`.patterns/worktree-agent-constraints.md`](../../.patterns/worktree-agent-constraints.md)
for the surrounding worktree/primary-checkout discipline it defends.

### `ref-guard` — caller-agnostic ref-transaction guard for the shared primary (#2143 diverging `main`; #2270 HEAD detach)

A fail-closed guardrail wired as git's own **`reference-transaction`** hook that refuses two
shared-primary hazards at git's own ref boundary:

1. **A diverging `refs/heads/main` ref-move** (#2143, ADR 0160) — any update that would make
   local `main` a **non-fast-forward** of `origin/main`. It closes the #2143 loaded-gun class:
   the orchestrator/PULLER role force-moved primary `main` off the merge seam (a bare
   `branch -f main` / `checkout -B main` / `update-ref refs/heads/main`), diverging it from
   `origin/main` and staging a ~13.5k-line deletion — one `git push -f` from clobbering
   `origin/main`.
2. **A bare HEAD-detaching checkout on the shared primary** (#2270) — a `git checkout <sha>` /
   `checkout FETCH_HEAD` / `switch --detach` that detaches the human's shared `HEAD` off its
   branch. This is the exact corruption a worktree-isolated agent triggers when its cwd resets
   to the primary between Bash calls. `decideHeadDetach` catches it via the same
   `reference-transaction` boundary: a detach queues an update whose ref-name is exactly `HEAD`
   to a concrete commit with **no paired `refs/heads/*` move to that same commit** (an attached
   commit pairs them; an attached `switch <branch>` retargets the symref and queues no `HEAD`
   update at all), and only on the **primary** checkout (git-dir == git-common-dir). A linked
   worktree's own HEAD detach — and the PULLER `checkout main` reattach, which queues no `HEAD`
   ref update — stay allowed. The signal is grounded in git's real `reference-transaction`
   behavior (verified against git 2.40, not assumed).

**Why the ref boundary, not a Bash hook.** The #1571 `worktree-guard` bash-pin only arms for
a `$WORKTREE_ROOT` subagent and only matches its `HEAD_MOVING` set — so it is disarmed for
the orchestrator/PULLER (no `$WORKTREE_ROOT`), a ref force-move is not in its set, and the
#2143 keystroke was outside the agent Bash tool-call path entirely. Git's
`reference-transaction` boundary fires for **every** ref update regardless of caller (agent
Bash, harness worktree machinery, a manually-run command, or another git hook), which is
exactly the reach a `PreToolUse` Bash hook lacks.

Safe by construction (the pure core `ref-guard.ts` decides, `command.ts` runs it):

- The pure `decideRefUpdate` allows every non-`refs/heads/main` update untouched, and on
  `refs/heads/main` allows **only a fast-forward** of `origin/main` (`origin/main` an
  ancestor of the new tip, or the new tip == `origin/main`); a non-ff divergence — or a
  delete — **refuses**. The legitimate PULLER `merge --ff-only origin/main` is a fast-forward,
  so it always passes; the reattach `checkout main` moves no ref on `main` at all.
- **Fail-open on infra absence, fail-closed on divergence.** An unresolvable `origin/main`
  (a fresh clone before the first fetch) allows the update (nothing to diverge from); an
  ancestry probe that *fails* is treated as non-ff and refuses on the guarded ref (cannot
  prove a fast-forward ⇒ divergence). The `lefthook.yml` wrapper aborts the transaction only
  on the guard's **dedicated refuse exit code (3)** and fail-opens on any other non-zero, so a
  not-yet-installed / stripped-PATH CLI (#787) or `bin.ts`'s unlinked-dep remediation (which
  exits 1) can never wedge every ref transaction repo-wide (the #1050 fail-open invariant).

Installed via `lefthook.yml` (ADR 0068), so it lands in the shared `.git/hooks` and fires for
the primary checkout and every worktree that shares that `.git`. Git honors the exit status
only in the `prepared` state, so the guard evaluates + can refuse only there; `committed` /
`aborted` drain stdin and no-op.

```bash
# git invokes this itself as the reference-transaction hook; the manual shape (for a test):
printf '%s %s refs/heads/main\n' "$OLD" "$NEW" \
  | node packages/pipeline-cli/src/bin.ts ref-guard reference-transaction prepared
# exit 0 = allow · exit 3 = REFUSE (a diverging main move OR a bare HEAD detach on the primary) · other non-zero = CLI couldn't run (fail-open)
```

This is a **control-plane** surface (it guards the shared primary checkout's `main`); see
[`.patterns/worktree-agent-constraints.md`](../../.patterns/worktree-agent-constraints.md)
for the surrounding primary-checkout discipline it completes.

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

### `path-filter-guard` — fail-closed ci.yml/deploy.yml path-filter sync gate (#2372)

Mechanizes the ci.yml/deploy.yml path-filter **sync invariant** (issue
[#2372](https://github.com/kamp-us/phoenix/issues/2372); the invariant landed in #2366 / PR
#2371). `deploy.yml`'s `changes.deploy` dorny/paths-filter list and `ci.yml`'s `changes.e2e`
dorny/paths-filter list must be the **same set** of globs — pinning **deploy's RUN-set ⊇
e2e's RUN-set** (deploy skips a preview only where e2e also skips). `ci.yml`'s `e2e` job
polls `deploy.yml`'s sticky `<!-- preview-deploy -->` comment on a 10-minute deadline, so a
PR that trips e2e but skips its deploy times the poll out and wedges `ci-required`. The two
lists were guarded ONLY by a reciprocal human comment; this makes the invariant mechanical.

Set **equality** is the checkable form (equality ⇒ superset, and equality is what the
comments pin). The pure core parses each workflow YAML, reads the `changes` job's
`dorny/paths-filter` `with.filters` string (parsed as YAML — the inline `#` comments are
inert), and diffs the `e2e:` / `deploy:` lists as sets. Fails closed on zero scope — a
missing file/job/step/key or an empty list (ADR 0092). See the tool README:
[`src/tools/path-filter-guard/README.md`](src/tools/path-filter-guard/README.md).

```bash
node packages/pipeline-cli/src/bin.ts path-filter-guard check
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

### `wayfinder-map` — parse + validate a `wayfinder:map` issue's state (#2421, #2426)

The machine-readable substrate the `wayfinder` skill's fog-graduation and emission modes
read instead of prose-guessing a map's state. A `wayfinder:map` issue is the ideation-layer
map that sits upstream of the execution pipeline; its body carries four canonical sections
(`## Destination` / `## Decisions-so-far` / `## Open frontier` / `## Graduated fog`), defined
once in the [formats contract](../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md).
This tool parses that body into `{destination, decisionsSoFar, openFrontier, graduatedFog}`,
validates it against a structural floor (the epic-ledger idiom: a closed defect enum, sorted
deterministically), and exposes a **graduation-readiness** predicate — is the open frontier
cleared of every *answerable* unknown (a well-formed, non-fork ticket), so the map is ready to
emit.

The tool is **read-only** — it parses and validates; the map's writes belong to the
`wayfinder` skill's chart/work modes. The pure core (`markdown.ts` parse, `validate.ts` floor
+ `isGraduationReady`) is unit-tested directly; the GitHub boundary (`github.ts`) fetches the
map body + its native sub-issues and resolves a frontier ref that names a non-sub-issue as
`DANGLING_FRONTIER_REF`.

```bash
# human verdict: valid/malformed + the graduation-ready flag
node packages/pipeline-cli/src/bin.ts wayfinder-map 2421

# the full parsed state + defects as one JSON object (what the skill modes / a CI hook consume)
node packages/pipeline-cli/src/bin.ts wayfinder-map 2421 --json
```

### `reachability-guard` — a flag can't graduate while its UI slice is unbuilt (ADR 0173, #2529)

The single deterministic reachability contract both `plan-epic` (#2530) and `/release`
(#2531) key off — the enforcement seam that makes an unreachable-feature graduation
unrepresentable (ADR [0173](../../.decisions/0173-vertical-completeness-gate.md), epic
[#1943](https://github.com/kamp-us/phoenix/issues/1943)). Given a Flagship flag key, it
asserts the flag's vertical has a **user-facing slice** before the flag can reach 100%:

- **Consuming UI** — the flag-key constant declared in `apps/web/src/flags/keys.ts` is
  referenced by ≥1 `apps/web/src/**/*.tsx` component (the static scan the reactions reporter
  ran by hand; ADR 0173 §1a/§2).
- **Registered journey e2e** — a spec under `apps/web/tests/e2e/` carries an in-title
  `@journey:<flag-key>` tag (ADR 0173 §2). The checker asserts *registration*; the e2e job
  runs the spec.
- **Exemption** — a legitimately UI-less infra/containment flag (e.g. `pano-feed-edge-cache`)
  opts out with a `@reachability-exempt: <reason>` marker at its `keys.ts` definition (ADR
  0173 §3), so the gate refuses unreachable *user-facing* flags without blocking infra flags.

It **fails closed** (ADR 0092) and **names precisely** which assertion failed (missing UI
consumer / missing journey e2e / unknown flag / zero scope), so `/release` can surface the
gap to the human. The pure core (`reachability-guard.ts` — keys.ts parse, `@journey` tag
parse, `judge`) is unit-tested directly; the filesystem boundary (`gate.ts` — walk `.tsx` +
e2e specs) is crossed over a fake repo dir.

```bash
# exit 0 iff <flag-key> is reachable (consuming UI + registered journey) or @reachability-exempt
node packages/pipeline-cli/src/bin.ts reachability-guard check phoenix-reactions

# point at a specific repo root (default: walk up for a workspace marker)
node packages/pipeline-cli/src/bin.ts reachability-guard check pano-feed-edge-cache --root /path/to/repo
```

```bash
pnpm --filter @kampus/pipeline-cli typecheck
pnpm --filter @kampus/pipeline-cli test
pnpm --filter @kampus/pipeline-cli build   # src → dist ESM
```
