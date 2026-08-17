# fabrika hook surface

fabrika's home for one question: **which piece of v1's Claude Code hook layer survives into fabrika, and in what form.** The v1 layer is frozen (ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)); the audit method that binds any answer here is *port by default, retire only per-hook on evidence* ([#4927](https://github.com/kamp-us/phoenix/issues/4927)).

This doc holds three things: **the surface** — where a fabrika hook is declared and how it invokes a verb — the **record format** every grading child writes into, and the **records themselves**.

## The surface

fabrika declares its hooks in one file, [`../hooks.json`](../hooks.json), in the plugin directory. There is no dispatch script, no installed-copy path to resolve and no version marker to compare, and that is not an omission — it falls out of two rules that are already ruled, so this section cites them instead of restating them:

- **A hook command is a plain literal `fabrika <group> <verb>` string** — no `$VAR`, no `${VAR:-default}`, no command substitution, no `source` ([`cli-interface-convention.md`](cli-interface-convention.md) rule 5, and ADR [0232](../../../.decisions/0232-agents-execute-skill-scripts-never-source-them.md)).
- **A hook calls only verbs implemented in [`../../../packages/fabrika-cli/`](../../../packages/fabrika-cli/)** — never `pipeline-cli`, never anything under `../../kampus-pipeline/` ([`cli-interface-convention.md`](cli-interface-convention.md) rule 6, ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)).

Which copy of the CLI serves the invocation is answered by the repo-root shim, not by the hook: [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md), *How it is delivered*. That is what deletes v1's wrapper / data-dir / pin apparatus from this surface — every job those three did has a home somewhere else, as the [Records](#records) below grade one by one.

Both rules are checked as **data**, not by eye: [`../../../packages/fabrika-cli/src/hook/declaration.ts`](../../../packages/fabrika-cli/src/hook/declaration.ts) reads `hooks.json` and reports every command that carries a shell construct, is not a plain `fabrika <group> <verb>` literal, or names something outside fabrika — and [`../../../packages/fabrika-cli/src/hook/envelope.golden.test.ts`](../../../packages/fabrika-cli/src/hook/envelope.golden.test.ts) reds on a non-empty report, and on an empty surface (a declaration with zero hooks is never a pass — ADR [0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

### The declared hooks, and how they are proven

Two hooks are declared today.

`fabrika hook check` on `SessionStart` is this surface's proof — it reads the envelope the harness writes to a hook's stdin and answers whether it is one fabrika can act on ([`../../../packages/fabrika-cli/src/hook/check-verb.ts`](../../../packages/fabrika-cli/src/hook/check-verb.ts)).

`fabrika hook spawn` on `PreToolUse` (matcher `Task|Workflow`) is the surface's first hook that *decides* something: it reads a subagent spawn's requested model off the envelope and returns a permission decision, denying a model the allowlist does not hold ([`../../../packages/fabrika-cli/src/hook/spawn-verb.ts`](../../../packages/fabrika-cli/src/hook/spawn-verb.ts); the record is [`spawn-guard guard` — PORT](#spawn-guard-guard--port) below).

A declared hook nobody ever runs is the false-green this repo keeps paying for, so the proof does not stop at the declaration. The test **runs the argv it reads out of the committed `hooks.json`** — never a literal in the test — against **captured** `SessionStart`, `PreToolUse` and subagent-spawn envelopes committed at [`../../../packages/fabrika-cli/src/hook/__fixtures__/`](../../../packages/fabrika-cli/src/hook/__fixtures__/) with their capture method, date and harness version beside them in `PROVENANCE.md` (ADR [0180](../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md); the method is [`../../../.patterns/golden-real-payload-fixtures.md`](../../../.patterns/golden-real-payload-fixtures.md)). Two properties are what make that a proof rather than a schema asserted against itself: the argv comes from the declaration, so a green test cannot be exercising a verb the surface does not name; and the fixtures are what Claude Code 2.1.226 really sent, so the shape assertions pin keys a doc-assumed envelope would have missed — `PreToolUse` carries `prompt_id`, `permission_mode` and `effort`, and v1's hand-authored spawn-guard envelope knew about none of them.

The one thing this cannot do is notice the **harness** changing. No gate here executes it (ADR 0180's own premise), so a stale fixture goes green; re-capture is the only refresh, and `PROVENANCE.md` says how.

<a id="the-events-fabrika-does-not-declare"></a>
### The events fabrika does not declare, and why

Five events were considered for this surface and all five were refused ([#5589](https://github.com/kamp-us/phoenix/issues/5589)). Each entry below says what the event carries, why a fabrika verb cannot act on it, and — for the three non-worktree ones — what a payload would have had to carry instead, so a later reader can tell whether a newer build has fixed it.

Everything here is read out of the **installed Claude Code executable, build 2.1.233**, by two methods, named per claim so neither is mistaken for the other:

- **Registry read.** The build carries its own hook-event registry — one `summary` plus a `description` that names the input JSON's fields — the same table `/hooks` renders. Extracted with `strings` and quoted verbatim below.
- **Live capture.** Probe hooks wired in a throwaway git repository, each writing its stdin to a file. Absolute paths in the captures are elided; nothing else is edited.

A newer build can change any row. The method above is the recheck.

#### `WorktreeCreate` — a provider hook, left undeclared

Registry entry, verbatim:

```
Create an isolated worktree for VCS-agnostic isolation
Input to command is JSON with name (suggested worktree slug).
Stdout should contain the absolute path to the created worktree directory.
Exit code 0 - worktree created successfully
Other exit codes - worktree creation failed
```

So it is **not a notification**. The harness expects the hook to create the worktree and echo its path, and it exists so worktree isolation can work under a non-git VCS. Captured live:

```json
{"session_id":"…","transcript_path":"…","cwd":"…","hook_event_name":"WorktreeCreate","name":"probe2"}
```

**The failure mode was reproduced rather than inferred.** In an ordinary git repository — one where `git worktree add` works — with a `WorktreeCreate` hook whose command exits non-zero, `claude --worktree <name>` printed

```
Error creating worktree: WorktreeCreate hook failed: false: no output
```

and the session never started. **There is no git fallback**: a configured hook preempts git wherever it is declared, so declaring this event means fabrika takes over worktree creation in every repo that installs the plugin, and a verb that fails breaks worktree isolation outright.

That failure mode is not survivable, and the reason is sharper than "it would be bad". [The ruled dispatch-failure policy](#the-dispatch-failure-policy-point) is fail-open, and on this event **fail-open has no form**. The harness reads every non-zero exit as a creation failure, including the two codes the convention reserves for *the verb never ran* — a bare `fabrika` exiting `127` on a machine with no install, and the cross-checkout refusal at `126`. It says so itself, in a build string that covers the hook not running at all:

```
WorktreeCreate hook failed: hook is configured but did not run (workspace not trusted, disableAllHooks set, or matcher mismatch)
```

A machine with no fabrika install would therefore lose `--worktree` entirely, which is the inverse of ADR [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md). Left undeclared.

#### `WorktreeRemove` — the teardown counterpart, also a provider, left undeclared

Registry entry, verbatim:

```
Remove a previously created worktree
Input to command is JSON with worktree_path (absolute path to worktree).
Exit code 0 - worktree removed successfully
Other exit codes - show stderr to user only
```

The payload is the base envelope plus one field, `worktree_path`. The same build's teardown path carries three strings, and the third is the load-bearing one:

```
Removed hook-based worktree at: 
WorktreeRemove hook did not remove worktree, kept at: 
No WorktreeRemove hook configured; falling back to git worktree remove for: 
```

`git worktree remove` is the **fallback for having no hook**. So declaring this event replaces git teardown in every adopting repo, and the harness then checks whether the path actually went away — an observe-only verb makes every managed worktree leak, in a state that reports nothing louder than a line on stderr. Nothing is bought for that: `worktree_path` names a directory, not a lane, an issue or a claim token, so there is no verdict a fabrika verb could reach from it. Left undeclared.

**UNKNOWN:** this event was not fired live. Its hook runs on the in-session worktree cleanup path; the `claude rm <id>` background-job path refused every hook-created worktree (`worktree has files but no repository to verify them against`) and, once the directory was removed by hand, removed the job without invoking the hook. Its payload is therefore a registry read and its fallback behaviour a strings read — read, not seen.

#### `TaskCompleted` — carries a task id, and none of its ids are fabrika's

Registry entry, verbatim:

```
When a task is being marked as completed
Input to command is JSON with task_id, task_subject, task_description, teammate_name, and team_name.
Exit code 0 - stdout/stderr not shown
Exit code 2 - show stderr to model and prevent task completion
Other exit codes - show stderr to user only
```

**It does carry a `task_id`**, so the reason this event cannot be judged from is not the one the planning round assumed — recorded here so nobody re-derives the wrong one. The real blocker is that every id in that payload lives in the harness's own teammate-task namespace: none of them is a GitHub issue or PR number, and none is a fabrika claim token, so no verb can map a completed task back onto the lane it belongs to.

**What a verb would have needed:** one field carrying the issue number or the claim token the lane was opened under — anything `fabrika build confirm` could be addressed to. A build that adds one makes this re-decidable.

A second obstacle stands behind the first even if that field arrives: the blocking code here is `2`, and fabrika allocates `2` nowhere ([the harness exit-code contract](#the-harness-exit-code-contract)). A verb with something to refuse would have no admissible way to say it.

#### `TeammateIdle` — names a teammate, names no lane

Registry entry, verbatim:

```
When a teammate is about to go idle
Input to command is JSON with teammate_name and team_name.
Exit code 0 - stdout/stderr not shown
Exit code 2 - show stderr to teammate and prevent idle (teammate continues working)
Other exit codes - show stderr to user only
```

`teammate_name` identifies the teammate perfectly well; what is missing is the same linkage `TaskCompleted` lacks. Neither field says what the teammate was idle *against* — no issue, no PR, no claim — so an idling teammate is not an event fabrika can attach a verdict to.

**What a verb would have needed:** the lane the teammate held, by issue number or claim token. As with `TaskCompleted`, the blocking code is `2`, which fabrika does not allocate.

#### `SubagentStop` — identifies the subagent, states no outcome

Captured live, which makes this the strongest of the three — seen rather than read:

```json
{"session_id":"…","transcript_path":"…","cwd":"…","prompt_id":"…","permission_mode":"auto",
 "agent_id":"aa2a9583f18c0b8fe","agent_type":"general-purpose","effort":{"level":"medium"},
 "hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"…",
 "last_assistant_message":"PONG","background_tasks":[],"session_crons":[]}
```

It carries `agent_id` and `agent_type`, so the subagent is identified. What no field states is **whether it succeeded** — there is no status, no exit code, no terminal token as data. `last_assistant_message` is prose, and deciding a lane's outcome by pattern-matching prose is exactly the claim-a-tree-does-not-support failure the [`build`](../skills/build/SKILL.md) skill exists to refuse.

**What a verb would have needed:** an outcome field — a status, or the subagent's terminal token carried as data rather than embedded in its last message.

Until then the artifact is the only place an outcome can be read — the PR, the posted verdict, the claim marker — and fabrika's verbs already read it there, which is why nothing is lost by leaving this event undeclared.

<a id="the-harness-exit-code-contract"></a>
### The harness exit-code contract — exit `2` blocks, and only on `PreToolUse`

**On `PreToolUse`, exit `2` is the only blocking code; every other exit shows stderr and the tool call proceeds.** That is the harness's rule, not fabrika's, and it is the reason `2` is allocated by nothing in fabrika's exit tables ([`cli-interface-convention.md`](cli-interface-convention.md) rule 3). Read first-party out of the installed Claude Code binary (`strings`, build 2.1.228), under *Before tool execution*:

```
Exit code 0 - stdout/stderr not shown
Exit code 2 - show stderr to model and block tool call
Other exit codes - show stderr to user only but continue with tool call
```

**`SessionStart` is the contrast, and it is stated here so nobody re-derives it.** The same binary's *When a new session is started* section reads `Exit code 2 - show stderr to user only`. So `2` carries no blocking power there at all — `fabrika hook check` cannot stop anything whatever it exits, and the whole exposure below is `PreToolUse`-only.

Both legs were also confirmed live on build 2.1.227 ([#5423](https://github.com/kamp-us/phoenix/issues/5423)): a probe hook on matcher `Task|Workflow` exiting `2` produced `PreToolUse:Agent hook error: …` and the subagent never ran, while the identical probe exiting `3` let the spawn through. The matcher fires on the spawn tool even though the envelope's `tool_name` reads `Agent`, so fabrika's declaration is correct.

The consequence is a **polarity**, not a style preference. A bootstrap or dispatch failure is a state in which no verb ran and no evidence exists, which ADR [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md) rules must fail **open**; seating any such state on `2` makes it deny instead. Three sites did — `bin.ts`'s `ERR_MODULE_NOT_FOUND`, and `delegate/entry.ts`'s foreign-checkout refusal and walk-fault — plus a fourth found while fixing them, `delegate/resolve.ts`'s spawn fault. All four now exit `126` ([`../../../packages/fabrika-cli/src/verb.ts`](../../../packages/fabrika-cli/src/verb.ts), `NO_IMPLEMENTATION`), and the polarity is pinned by [`../../../packages/fabrika-cli/src/hook/pretooluse-polarity.cli.test.ts`](../../../packages/fabrika-cli/src/hook/pretooluse-polarity.cli.test.ts), which runs the argv out of the committed declaration against a real cross-checkout refusal and asserts the exit code is not the blocking one.

**The intended deny is untouched, and it never used an exit code.** `fabrika hook spawn` denies an off-allowlist model by returning `answer(...)` — exit **0** — carrying `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}` ([`../../../packages/fabrika-cli/src/hook/spawn.ts`](../../../packages/fabrika-cli/src/hook/spawn.ts)). That JSON mechanism is independent of the exit status, so a guard that means to refuse has a way to say so without touching `2`.

<a id="the-dispatch-failure-policy-point"></a>
### The dispatch-failure policy point — RULED, [#5079](https://github.com/kamp-us/phoenix/issues/5079) (ADR [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md))

A fabrika hook's verb can fail to run: a bare `fabrika` exits `127` on a machine with no install ([#4791](https://github.com/kamp-us/phoenix/issues/4791)), and a cross-checkout invocation refuses with exit `126` ([`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts), the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch). The convention reserves both for *the verb never ran*, which is never a verdict ([`cli-interface-convention.md`](cli-interface-convention.md) rule 3).

**Ruled behaviour: fail open, and say so.** The harness event proceeds — a verb that never ran produced no evidence, so it may never deny. What is **banned is the silence**: the cannot-run state owes a visible degraded notice on stderr naming that the hook did not run and which defence is therefore absent. Fail-open-and-loud, never fail-open-and-forgotten. A verb that *runs* and returns a deny still fails closed as designed; the ruling touches the cannot-run case only.

There is **exactly one kind of place** that decides it, and it is the event a hook is declared on in [`../hooks.json`](../hooks.json). Rule 5 admits no wrapper script, so fabrika has nowhere to intercept an exit code from a process that never started; what a dispatch failure can do is therefore fixed by the event. `SessionStart` cannot abort anything. On `PreToolUse` the answer splits by **which** dispatch failure it is, and the split is the exit code:

- **Exit `127` — nothing ran.** No permission decision is produced, which the harness reads as no objection, so the spawn proceeds **unguarded**. This is the fail-open the ruling describes, reached by the process's own absence.
- **Every other non-zero exit — the process ran and refused.** Its stderr is shown and the spawn proceeds, per [the harness exit-code contract](#the-harness-exit-code-contract) above. This is fail-open-**and-loud**, which is what the ruling asks for.
- **Exit `2` — the spawn is blocked.** Not fail-open at all. It is the one code that denies, so no fabrika exit code may take it; that is enforced in the exit tables rather than left to this prose ([#5423](https://github.com/kamp-us/phoenix/issues/5423)).

This section previously grouped `2` and `127` together as "the verb never ran, so the spawn proceeds unguarded". That was true for `127` and **false for `2`**: while a bootstrap failure sat on `2`, a fabrika that could not resolve itself blocked every `Task`/`Workflow` spawn in the session — the inverse of the ruling, recorded here as fact.

Failing *closed* still has no admissible form, and for the reason the ruling gives: it would mean minting the interception rule 5 forbids. Do not spread the behaviour to a per-verb site; this section is the one place a later ruling flips.

The `PreToolUse` hook makes that cost real, and it is named rather than left implicit: a machine where `fabrika` does not resolve runs every spawn with the model defence silently absent — the exact silence the defence exists to remove.

**The notice is owed and only half-implementable today, so it is recorded rather than assumed.** On exit `126` the process did start and fabrika speaks for itself (`resolve.ts`'s foreign-checkout refusal). On exit `127` fabrika cannot speak, because `fabrika` is what failed to resolve, and the seam that would have carried a session-start signal is graded RETIRE below — so that half has **no owner**, and its structural cure is the publish plus install at [#4791](https://github.com/kamp-us/phoenix/issues/4791). ADR 0250 carries the full reasoning, the two-family discriminator behind the polarity, and the requirement that an adversarial review precede any implementation of this horn in either direction.

## The record format

One `###` section per graded v1 piece, under [Records](#records). Each section carries these fields, in this order, and nothing else:

| Field | What it must contain |
| --- | --- |
| **Verdict** | Exactly one of **PORT**, **REDESIGN**, **RETIRE**. One verdict per piece — never two, never a hedge. |
| **Graded against** | The files read, by repo-relative path, with the line or section that carries the claim, and the commit the line numbers are true at. |
| **What it does in v1** | The job, in the v1 author's own terms, so the verdict is checkable against the thing being graded. |
| **The channel property that carries the verdict** | The specific property of the ruled delivery channel — quoted or cited to a line — that makes the verdict follow. A verdict without one is decoration. |
| **What is lost** | Mandatory. What guarantee this piece gave that the channel does not give back, and who would have noticed. Where something replaces it, say what the replacement *is* — a replacement that is weaker (a warning where v1 refused, one branch where v1 covered all of them) is stated as weaker, in those words. Write `nothing` only when the piece guarded nothing. |
| **UNKNOWN** | Mandatory, never omitted. What could not be checked first-hand — including a property this record leans on that lives on a branch with no end-to-end exercise. Write `none` explicitly when there is nothing. An unchecked thing is never written as a pass. |
| **Not graded here** | Deliberate scope boundaries and where each lands instead. Omit only when the record grades the whole piece. |
| **Owner** | The fabrika-side thing this lands against — a verb, this doc, or a follow-up issue. For PORT/REDESIGN, what carries the work. For RETIRE, what carries the residue named in **What is lost**, or `none` when nothing is left to carry. |

The rule behind the format: **a recorded outcome is a claim about reality, so the next reader must be able to re-derive it.** Cite the file and line; mark the uncheckable UNKNOWN.

Three of those fields exist because of how the first three records were graded, and they are not interchangeable:

- **UNKNOWN and Not graded here are different fields on purpose.** "I could not check this" and "I deliberately did not grade this" are different claims, and one field cannot hold both — once a scope note occupies UNKNOWN, the real unknown has nowhere to go. That is not hypothetical: it is exactly how the `pin.sh` record below shipped an unproven property as a discharged one ([#5138](https://github.com/kamp-us/phoenix/pull/5138) round 1).
- **UNKNOWN is mandatory with an explicit `none`** because an omittable field is self-certified — a grader who checks nothing and a grader who checked everything write the same empty space. An explicit `none` is a claim a reviewer can attack.
- **What is lost exists because RETIRE is the verdict that removes something.** A record whose dominant verdict is RETIRE and which has no field for the residue lets a real reduction in guarantee — a refusal traded for a silenceable warning — read as a clean discharge.

## What is proven today, and what is not

The ruled channel — a global install of `@kampus/fabrika-cli` whose binary finds the repo root, asks Node's resolver what copy that root installed, and hands the invocation over ([`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md), *How it is delivered*; [`cli-interface-convention.md`](cli-interface-convention.md) rule 5, *Delivery — one name, two installs, both of them real*) — has **two halves, and only one of them is exercised.**

**Proven: the in-checkout half.** phoenix declares `"@kampus/fabrika-cli": "workspace:*"` in its root [`package.json`](../../../package.json) devDependencies, pnpm links the workspace package, and the resolver finds it. Verified first-hand from a linked worktree at commit `a2729e6e`:

```
$ FABRIKA_DEBUG=1 node packages/fabrika-cli/src/bin.ts --version
fabrika: running here, at <checkout>/packages/fabrika-cli — the repo-local install is this copy
fabrika v0.1.0
```

This is the `run-here` branch of [`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) (L76–77), reached through `createRequire(<root>/package.json).resolve("@kampus/fabrika-cli/package.json")` ([`../../../packages/fabrika-cli/src/delegate/node-resolve.ts`](../../../packages/fabrika-cli/src/delegate/node-resolve.ts) L31). It is the path fabrika runs on inside phoenix today.

**Not proven: the published-global half.** `@kampus/fabrika-cli` is not published; `pnpm add --global @kampus/fabrika-cli` answers a registry 404, tracked by [#4791](https://github.com/kamp-us/phoenix/issues/4791) (README, *How it is delivered*, the IMPORTANT callout). So the `delegate` and `warn-and-run-here` branches have unit tests over the pure resolver ([`../../../packages/fabrika-cli/src/delegate/resolve.unit.test.ts`](../../../packages/fabrika-cli/src/delegate/resolve.unit.test.ts)) but **no end-to-end exercise from a registry-installed global.** Nothing below grades that half as proven.

One honest wrinkle found while grading, worth recording because it is easy to mistake for proof: on a machine where the workspace copy has been hand-linked global (`pnpm link --global`), a bare `fabrika` **is** on `PATH` — but that global is the same checkout's copy, not a published artifact, and from a linked worktree it takes the foreign-checkout refusal (exit `126` — `2` when this was reproduced first-hand, re-seated by [#5423](https://github.com/kamp-us/phoenix/issues/5423); `resolve.ts` L82–89, the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch). A hand-linked global is **not** evidence for the published half.

## Records

### `install.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/install.sh`](../../kampus-pipeline/hooks/install.sh) (whole file, 79 lines) · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered* · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 *Delivery* L213–224 · [`../../../packages/fabrika-cli/src/delegate/node-resolve.ts`](../../../packages/fabrika-cli/src/delegate/node-resolve.ts) L24–43 · [`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L73–74 (the branch an uninstalled root takes). Line numbers true at commit `a2729e6e`.

**What it does in v1:** a SessionStart hook that installs `@kampus/pipeline-cli` into a plugin data dir, version-aware and idempotent. It writes a minimal `package.json` into that dir (L59–65), runs `npm install` there (L69), and stamps the installed version into a marker file it compares on the next session (L39, L49–51). Every failure path degrades to exit 0 so an offline SessionStart still starts (L11–14, L69–79).

**The channel property that carries the verdict:** **the channel has no install step for a hook to perform, and no copy for a hook to place.** Delivery is one global install of the package plus whatever the repo root already installed — "finds the **repo root** above the working directory, asks **Node's own resolver** what copy of `@kampus/fabrika-cli` that root has installed, and hands the invocation to it" (README, *How it is delivered*). Resolution is a *read* of an install a package manager made (`node-resolve.ts` L31), never an install the hook makes. Each of install.sh's three jobs loses its subject:

- **The install** targets a data dir the channel does not have. A repo's copy arrives through its own manifest, not through a hook writing a `package.json` into a plugin dir.
- **The version marker** is replaced by the resolved install's own `version` field, read from the manifest the resolver returned ([`../../../packages/fabrika-cli/src/delegate/local.ts`](../../../packages/fabrika-cli/src/delegate/local.ts) L58–63). A marker exists to remember what a previous install did; a resolver that reads the live manifest has nothing to remember.
- **The degrade-to-exit-0 invariant** is replaced by the delivery's own totality rule — "**No outcome is both silent and wrong**" (README, *How it is delivered*, the five-row table) and the convention's "tiers that can only be right or loudly absent are fine; tiers that can be quietly wrong are the defect" (rule 5, *Delivery*). The worst outcome the channel admits is that the global runs, loudly; there is no session-aborting failure for a hook to swallow.

**What is lost:** the guarantee that the tool is *present before first use*. v1 installed at SessionStart, so by the time anything invoked `pipeline-cli` the copy existed. The channel installs nothing ahead of time: in a repo root that pins `@kampus/fabrika-cli` but has not installed it, the first invocation resolves no local copy and takes the degenerate `warn-and-run-here` branch — the global runs and says so loudly, naming both versions ([`cli-interface-convention.md`](cli-interface-convention.md) L218–221). So the check moves from *before the session* to *at the invocation*, and its outcome moves from *fixed silently* to *reported loudly*. Whoever would have noticed is whoever runs a bare `fabrika` in a checkout they have not installed — they get the global's answer plus a warning, not a failure. Nothing is lost from the degrade-to-exit-0 invariant: a CLI invocation has no session to abort.

**UNKNOWN:** the replacement above lives on the `warn-and-run-here` branch, which has unit tests over the pure resolver but **no end-to-end exercise** (see [What is proven today](#what-is-proven-today-and-what-is-not)). This record does not claim to have seen it fire.

**Not graded here:** install.sh L26 also plants the `.claude/.pipeline` link before doing anything else. That planting is [#5077](https://github.com/kamp-us/phoenix/issues/5077)'s subject, and this record deliberately takes no position on it. This retire covers install.sh's install-and-marker job only; if #5077 finds something that needs planting, its owner is that record, not a revived install.sh.

**Owner:** none. Nothing survives that needs a fabrika-side home; the residue above is the delivery layer's own documented behaviour, not work.

### `resolve-data-dir.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/resolve-data-dir.sh`](../../kampus-pipeline/hooks/resolve-data-dir.sh) (whole file, 28 lines) · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 L196–198 and *Delivery* L226–232 · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered*. Line numbers true at commit `a2729e6e`.

**What it does in v1:** resolves the directory `install.sh` installs into and `guard.sh` looks in (its own header, L2–3). Its whole substance is a hardening: Claude Code applies `settings.json` `env` values **verbatim**, so a wired `KAMPUS_PIPELINE_DATA="${CLAUDE_PROJECT_DIR}/..."` arrives with the token unexpanded, and consuming it created a literal `${CLAUDE_PROJECT_DIR}` directory at the repo root ([#2495](https://github.com/kamp-us/phoenix/issues/2495), L5–15). It discards any value still carrying `${` and fails closed (L22, L26).

**The channel property that carries the verdict:** **there is no data dir, and the channel reads no settings-supplied env value as a path.** Rule 5: "A verb never requires an env var to *locate* itself. Configuration may still arrive by env (a session id, a target repo)" (L196–198). The three delivery env vars are named explicitly as *not* locating anything — `FABRIKA_DEBUG` traces, `FABRIKA_GLOBAL_WARNING_DISABLED` silences, `FABRIKA_SKIP_INFER` guards recursion (*Delivery*, L226–229). Location is answered by walking to the repo root and asking Node's resolver.

The cited passage does carry a **fourth** env var, and it carries a path: `FABRIKA_INVOCATION_DIR`, handed to the delegated child "because its own cwd is set to the repo root" (L231–232). It does not weaken the verdict, and the precise reason is worth writing down rather than waving at. The value is *written by the parent process* from `process.cwd()` ([`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L223, from `entry.ts` L70) and, across the whole package today, **read by nothing**. #2495's mechanism is specifically that `settings.json` `env` values are applied **verbatim**, so a literal `${CLAUDE_PROJECT_DIR}` token survives into whatever consumes it — a value produced by `process.cwd()` and handed over by `exec` cannot carry an unexpanded token. So the narrow claim is the true one: no *settings-supplied* env value is read as a path here, and the one env var that does carry a path is process-supplied and unread.

**What is lost:** nothing. The #2495 hardening defended against consuming a settings-wired path; the channel wires no path through settings, so the defence and the thing defended both go. The one residue is a *habit*, not a guarantee: if fabrika ever adds a verb that reads a settings-supplied env value as a path, rule 5's "never requires an env var to locate itself" is what has to stop it, and that rule is already written down.

**UNKNOWN:** none. Both halves of this grading are readable in-repo; nothing here depends on the unpublished global, and `FABRIKA_INVOCATION_DIR`'s "read by nothing" is a whole-package grep at the commit above, not an inference.

**Owner:** none.

### `pin.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/pin.sh`](../../kampus-pipeline/hooks/pin.sh) (whole file, 22 lines; the pin itself at L22) · [`../../../package.json`](../../../package.json) L24 · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered* · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 *Delivery* L210–224 · [`../../../packages/fabrika-cli/src/delegate/entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts) L77–105 (the branch dispatch) · [`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L66–91 (the resolver) and L132–139 (`globalWarning`). Line numbers true at commit `a2729e6e`.

**What it does in v1:** holds one version string in a sourceable shell file so **two** consumers can read the same value — `install.sh` (what to install) and the `guard.sh` wrapper (what to refuse to dispatch below). The file's own header states why it is a separate file: a wrapper that cannot see the pin "can only test executability, and an executability test cannot tell a current build from a months-old one", which is how a stale tree kept being dispatched for months ([#3742](https://github.com/kamp-us/phoenix/issues/3742), L5–9).

**The channel property that carries the verdict:** **the root manifest devDependency is the pin.** "phoenix carries `@kampus/fabrika-cli` in its root `devDependencies`, so a bare `fabrika` anywhere in a phoenix checkout runs the version this repo pins" (README, *How it is delivered*); the convention states the same property as the reason the shim exists at all — "The property that buys is a **repo-pinned version**: a repo carrying `@kampus/fabrika-cli` in its `devDependencies` gets that version from a bare fence, whatever each machine's global happens to be" (rule 5, *Delivery*, L210–211). phoenix's declaration is [`../../../package.json`](../../../package.json) L24, `"@kampus/fabrika-cli": "workspace:*"`.

A second pin file would be a **second source for a value the manifest already owns** — the exact hand-sync the v1 header was at pains to avoid, reintroduced. That is what carries the verdict, and it is the whole of what carries it: the pin has a home, and it is not a shell file a hook sources.

**What the channel does *not* give back is pin.sh's other half, and this record states it as a loss rather than a discharge.** v1's pin fed a version-gated dispatch wrapper that **refused to dispatch** a build below the pin — the property [#3742](https://github.com/kamp-us/phoenix/issues/3742) was filed for. Traced at the call site, not the definition, the channel's nearest surviving behaviour is a **warning on one branch, and it can be switched off**:

- `globalWarning` ([`resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L132–139, printing the running copy's version beside `declaredVersion` from [`local.ts`](../../../packages/fabrika-cli/src/delegate/local.ts) L113–126) has exactly **one** caller in the package: [`entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts) L85, inside `if (resolution._tag === "warn-and-run-here")` at L82.
- It is **not per invocation.** `run-here` returns at `entry.ts` L81 with no version comparison; `delegate` falls through to `spawnDelegate` at L96 with no version comparison. Only the degenerate branch compares — and that branch is reached when the repo's local install is **absent or corrupt** ([`resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L73–75), not when a working local install is merely old.
- It is **absent from the one branch this record proves end-to-end.** `run-here` is the branch reproduced above; on it, zero drift checking happens.
- It is **suppressible.** `entry.ts` L83 skips the warning entirely when `FABRIKA_GLOBAL_WARNING_DISABLED` is set — the convention names the same switch at L220–221.

So: **a refusal to dispatch, traded for a silenceable warning on the degenerate branch.** The verdict still stands on the pin-has-a-home argument alone, which is checkable in-repo today. It does not stand on drift detection having moved into the binary, because in the sense pin.sh meant it, it has not.

**What is lost:** the refusal. Nothing on the ruled channel declines to run a copy whose version is below what the repo pins; the closest thing prints a line, on one branch, and takes an env var that turns it off. Who would have noticed: exactly the #3742 case — a stale tree dispatched for months because an executability test cannot tell a current build from an old one. On the fabrika channel that case now resolves through `delegate`, which hands over to whatever the root installed and says nothing about its version. Whether that is acceptable is **not** settled: the `guard.sh` decision child ([#5079](https://github.com/kamp-us/phoenix/issues/5079)) ruled the *cannot-run* polarity only (see [the policy point](#the-dispatch-failure-policy-point)) — a stale-but-runnable build is a verb that *can* run, a different question, and that question has no ruling. What this record owes is an accurate statement of the gap.

**UNKNOWN:** whether the replacement warning ever fires in practice. It lives on `warn-and-run-here`, one of the two branches with unit tests over the pure resolver and **no end-to-end exercise** (see [What is proven today](#what-is-proven-today-and-what-is-not)) — so this record has read the branch and not seen it run. Also unknown: whether any fabrika-side consumer will need a version to *compare* rather than merely to resolve; that only becomes answerable once the wrapper decision lands.

**Not graded here:** pin.sh's second reader is the `guard.sh` version-gated dispatch wrapper, and **the wrapper's own fate is not decided here** — it is a separate decision child ([#4927](https://github.com/kamp-us/phoenix/issues/4927)'s split). What this record establishes is narrower and checkable: on the ruled channel the pin lives in the root manifest, so **no fabrika-side reader of a shell pin file exists**. If the wrapper decision later mints a fabrika hook that needs a version to compare, its input is the root manifest through a fabrika verb, not a revived `pin.sh`; that would be a new record in this doc, not an amendment to this one.

**Owner:** this doc. The `guard.sh` decision child ([#5079](https://github.com/kamp-us/phoenix/issues/5079)) has landed and ruled the cannot-run polarity only, so the lost version-gated refusal is **still unowned** — whether it is worth rebuilding on the fabrika side needs its own ruling, and a new record here is where it would land.

### `plant-pipeline-link.sh` + `plant-link-pretooluse.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/plant-pipeline-link.sh`](../../kampus-pipeline/hooks/plant-pipeline-link.sh) (whole file, 123 lines; the forcing constraint at L6–12, the relative/absolute target choice at L57–66, the resolves-not-merely-links proof at L114–120) · [`../../kampus-pipeline/hooks/plant-link-pretooluse.sh`](../../kampus-pipeline/hooks/plant-link-pretooluse.sh) (whole file, 62 lines; why a third planting site exists at L5–15) · the three planting sites — [`../../kampus-pipeline/hooks/install.sh`](../../kampus-pipeline/hooks/install.sh) L26, [`../../kampus-pipeline/hooks/create-worktree.sh`](../../kampus-pipeline/hooks/create-worktree.sh) L160, [`../../kampus-pipeline/hooks.json`](../../kampus-pipeline/hooks.json) L25–34 · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 L185–193 and the exit-code table L97–105 · [`skill-conventions.md`](skill-conventions.md) §4 L100–123 · [`../skills/check-epic-plan/SKILL.md`](../skills/check-epic-plan/SKILL.md) L152–156 · the live fabrika skill corpus under [`../skills/`](../skills/). Line numbers true at commit `a2729e6e`.

**What it does in v1:** plants `<tree>/.claude/.pipeline` as a symlink to the live plugin install, so a skill fence can name the pipeline by a **literal relative path** that resolves in any consuming repo, not just a phoenix checkout (its own header, L2–4). The forcing constraint is the same one fabrika rule 5 records: the harness isolation verifier is a syntactic check on the command string, so a fence may carry no expansion at all — "the only shape that runs is a plain literal path, and the only literal that is true in every repo is one the consuming repo itself provides" (L8–9). A hook is a harness-substituted surface, so it can know where the plugin lives; an agent's top-level command cannot. The script picks a **relative** target for a repo that vendors the plugin and an absolute one otherwise (L57–66), keeps the tree clean through `.git/info/exclude` (L74–97), is idempotent (L99–106), and refuses on a dangling link rather than leaving every fence at 127 (L114–120). `plant-link-pretooluse.sh` is the third firing site, added because `WorktreeCreate` is inert on the harness path that actually provisions `isolation:worktree` trees (L5–10).

**The channel property that carries the verdict:** **the ruled fabrika literal is a bare command name, and a bare command name is not a path — there is nothing for a link to stand at.** Rule 5 fixes it: "**The literal is `fabrika`.** … every fence in every fabrika skill writes `fabrika <group> <verb> …` and nothing else" (L187–189). The v1 link exists to make a *path* literal true; a fence that names no path has no path to repair.

The live corpus matches the rule, counted rather than asserted. Across every ` ```bash ` fence in every file under [`../skills/`](../skills/), **72** invocation lines are of the shape `fabrika <group> <verb> …`, and **every** other non-comment line in those fences is heredoc body or a closing `EOF` — no fence names a path, a variable, or a script. Structurally: `find claude-plugins/fabrika -type d -name scripts` returns **nothing** — fabrika ships no `scripts/` directory in any skill, so there is no path-addressed artifact for a link to point at. The contrast is the size of what the link is actually for: v1 carries **167** `.claude/.pipeline`-rooted fence lines across **12** skills, each naming a script under a `skills/*/scripts/` dir.

**Admissibility is demonstrated, not argued.** The retire rests on "a bare command name is admissible at an agent's top-level command", so that was exercised first-hand rather than inferred from rule 5's prose: run from a linked worktree at `a2729e6e` inside an isolation-verified agent, a bare `fabrika --version` **ran** — the verifier permitted it — and produced the CLI's own foreign-checkout refusal — exit `2` at the time, re-seated to `126` by [#5423](https://github.com/kamp-us/phoenix/issues/5423) ([`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L82–89, the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch) — never a verifier refusal.

**The unresolved-binary state, and whether it needs anything planted.** Exit `127` is the shell reporting that nothing ran (`cli-interface-convention.md` L102, L105), and the corpus already reads it as UNKNOWN rather than as an answer — "any `1`, `126` or `127` — a verb that could not run is never a verdict" ([`../skills/check-epic-plan/SKILL.md`](../skills/check-epic-plan/SKILL.md) L152–156, routing it to `STOPPED`). `@kampus/fabrika-cli` is not published ([#4791](https://github.com/kamp-us/phoenix/issues/4791)), so on a machine with no install a bare `fabrika` answers `127`. **Nothing needs planting in that state**, for a structural reason rather than a hopeful one: planting makes a *path* exist, and the missing thing here is an installed package on `PATH`, not a directory at a known location. There is no link that turns `fabrika build claim` into a resolvable command, the way `.claude/.pipeline` turns `bash ./.claude/.pipeline/skills/write-code/scripts/step4-branch.sh` into one. The cure for `127` is the publish plus the install, already owned at [#4791](https://github.com/kamp-us/phoenix/issues/4791). Probed first-hand this run: an unresolved bare name is a plain `command not found` at exit `127`, with no path component a link could intercept.

**The hook half of the question, checked separately.** A planting hook would also be pointless against fabrika's own hook surface. When this record was written there was no surface at all to address; [#5074](https://github.com/kamp-us/phoenix/issues/5074) has since landed one, and the verdict is unchanged for the reason it always rested on: [The surface](#the-surface) admits exactly one command shape, a bare `fabrika <group> <verb>` literal, so the single hook declared in [`../hooks.json`](../hooks.json) names no path either. There is still no fabrika hook that could be invoked by path.

**What is lost:** one guarantee, and it is narrower than the planting machinery it came from. The path-literal job is lost with nothing to replace it and nothing to miss it — the fabrika corpus names no path, so the thing the link made true is a thing no fence asks for. What is genuinely given up is `plant-pipeline-link.sh`'s **refusal on a dangling link** (L114–120): v1 checked, in one place and ahead of use, that the planted path actually *resolved*, so a broken plant surfaced as a single loud refusal rather than as every fence in every skill reporting `127`. The fabrika channel has no equivalent single place. An uninstalled or unresolvable `fabrika` is a plain shell `command not found` at exit `127`, per fence, and classifying that as "could not run" rather than as an answer now rests on **each skill's own failure vocabulary** — of which only [`../skills/check-epic-plan/SKILL.md`](../skills/check-epic-plan/SKILL.md) L152–156 is confirmed to state the `127` → `STOPPED` rule in its prose. So the check moves from *one hook, before use, refusing* to *each skill, at the fence, on its own discipline*, which is weaker in exactly that sense. Who would have noticed: whoever runs a fabrika skill on a machine with no install — under v1 they got one refusal naming the broken link; here they get a `127` whose reading depends on which skill they happened to run.

**UNKNOWN:** the `127` state is not reproducible on this host, so it is graded from the corpus's documented handling rather than from an end-to-end run. `command -v fabrika` answers a hand-linked global here, so a bare `fabrika` resolves; the `127` probe above ran a deliberately nonexistent name, which proves the *shell's* answer but not what a fabrika **skill run** does when its first verb `127`s. Whether every skill's failure vocabulary covers `127` is therefore not established — only `check-epic-plan` was read stating it. The published-global half stays unexercised until [#4791](https://github.com/kamp-us/phoenix/issues/4791) lands, the same limit [What is proven today](#what-is-proven-today-and-what-is-not) records above; this record inherits it rather than grading around it.

**Not graded here:** two deliberate boundaries, neither of them an unknown.

- **[#5078](https://github.com/kamp-us/phoenix/issues/5078) is a scope deferral, not a doubt.** This record grades the hook surface as it stands — every record in this doc a RETIRE, no hooks declared. If #5078's verdict mints a fabrika hook that is itself a shell file invoked by path, the planting question re-enters *for that hook*, and its home is a new record in this doc, not an amendment to this one.
- **`create-worktree.sh` is the third planting site and is held at [#4934](https://github.com/kamp-us/phoenix/issues/4934).** This record covers the planting mechanism only and takes no position on the worktree hook that calls it.

**Owner:** this doc, plus [#4791](https://github.com/kamp-us/phoenix/issues/4791). The residue splits cleanly: the `127`-classification gap is closed by the publish-and-install at #4791, which removes the state entirely; and if a later record — #5078's, or [#4934](https://github.com/kamp-us/phoenix/issues/4934)'s — ever mints a fabrika artifact that *is* addressed by path, that record is where the planting question is re-decided and where a replacement for the dangling-link refusal would have to be argued.
### `spawn-guard freshness` — RETIRE

**Verdict:** RETIRE.

**Graded against:** `packages/pipeline-cli/src/tools/spawn-guard/command.ts` (deleted with the tool — ADR [0282](../../../.decisions/0282-spawn-guard-retired.md); readable at the pinned commit) L19–29 (the mode's own header, including why the probe imports nothing), L129–141 (the `createRequire` probe), L143–156 (the signal text), L158–177 (the command — `additionalContext` at L164–168, the exit-2 stderr note at L169–173) · [`../../kampus-pipeline/hooks.json`](../../kampus-pipeline/hooks.json) L15 and [`../../../.claude/settings.json`](../../../.claude/settings.json) L87 (the only two wirings in the repo, both through the wrapper) · [`../../kampus-pipeline/hooks/guard.sh`](../../kampus-pipeline/hooks/guard.sh) L25–34 (the fail-open invariant), L51–55 (the CLI-absent no-dispatch), L57–75 (the marker gate), L79 (the dispatch) · [`../../kampus-pipeline/hooks/install.sh`](../../kampus-pipeline/hooks/install.sh) L69–73 and L77 (the marker is written only after a verified install and dropped on any failure) · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered* L44–52 (the five-row table), L57 (the silencer), L74–80 (`FABRIKA_DEBUG`), L91–98 (the unpublished-global callout naming exit `127`) · [`cli-interface-convention.md`](cli-interface-convention.md) rule 3 L97–108 (the exit-code table), rule 5 L185–198 (the literal is `fabrika`), rule 6 L239–242 · [`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L82–89 (the foreign-checkout refusal) and L132–139 (`globalWarning`) · [`../../../packages/fabrika-cli/src/delegate/entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts) L77–96 (the branch dispatch) · [`../.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) (no `hooks` key). Line numbers true at commit `5226c492`.

**What it does in v1:** a SessionStart hook that says, once and at the top of a session, that the hook pack is degraded. Its probe asks `createRequire` whether `@effect/platform-node` resolves (L133–141); when it does not, the whole pack is inert until `pnpm install` runs, so the verb prints a `SessionStart` `additionalContext` telling the agent the worktree-guard and spawn-guard are **not enforcing** and the statusline is a placeholder (L150–168), writes the same line to stderr, and exits `2` so the user sees it (L169–173). On a healthy tree it is silent — exit 0, nothing on either stream (L163). Reproduced first-hand at the commit above: `spawn-guard freshness` on this tree printed nothing and exited 0. The mode exists because the pack's failure is *quiet*: `guard.sh` fail-opens by contract (L25–34), and a PreToolUse hook that exits 0 with no stdout is an implicit allow, so a degraded pack looks exactly like a pack that allowed everything.

Worth recording, because it bounds what is being retired: freshness is reachable only through that same wrapper, and the wrapper refuses to dispatch unless the installed marker equals the pin (L57–75), while `install.sh` writes that marker only after an install it verified and drops it on any failure (L69–73, L77). So the state freshness can report is narrower than the state it warns about — an install `npm` reported success on, whose runtime dep nevertheless does not resolve. Total absence of the CLI was never covered: there the wrapper no-ops at L51–55 and freshness never runs.

**The channel property that carries the verdict:** **on the ruled channel the probe and the thing it probes are the same artifact, so the probe is silent in exactly the state it exists to report.** Rule 5 fixes the literal: "**The literal is `fabrika`.** … every fence in every fabrika skill writes `fabrika <group> <verb> …` and nothing else" (L187–189), and a hook is declared the same way. A fabrika session-start probe is therefore a `fabrika` invocation, and `fabrika` is what fails to resolve — "a bare `fabrika` exits `127` on a machine with no global install, which the interface convention reserves for exactly that: the verb never ran" (README L96–97). v1 did not have this problem: its probe was a shell file at a plugin path the harness substitutes, probing a *separately installed* package, so the probe's own executability was independent of its subject.

The second half is that there is nothing left to be degraded. When this record was written fabrika declared no hooks at all, so the "a whole session passes with every fabrika hook silently doing nothing" case had no hooks to be silent. [#5074](https://github.com/kamp-us/phoenix/issues/5074) has since declared one, so that half is now **narrower than it reads**: a single `SessionStart` hook can go silent, and under the ruled [fail-open policy](#the-dispatch-failure-policy-point) it would. This record does not re-grade itself on that — the circularity above is untouched, because a fabrika probe of that state is still a `fabrika` invocation and `fabrika` is what failed — but the state is no longer empty. [#5079](https://github.com/kamp-us/phoenix/issues/5079) has since ruled it: fail open, with a degraded notice owed, and this record is the reason that notice has no fabrika-side owner for the `127` state. And the half-state v1's probe detects is *manufactured by `install.sh`*: a plugin data dir with a hand-written `package.json` and an `npm install` that degrades to exit 0. That installer is already retired above. A package manager that resolves `@kampus/fabrika-cli` resolves its dependencies in the same act; there is no fabrika equivalent of "installed, but its runtime dep is missing".

**Grading the shim's own signals, one by one — and the answer to whether they cover the gap is no.** All four fire per invocation, on the invoking process, after the decision to invoke:

- **Exit `127`** (README L96–97; rule 3's table L102) is the *shell* reporting that nothing ran. It covers total absence, which v1's freshness never covered — but it arrives at the fence, not at the top of the session.
- **The foreign-checkout refusal, exit `126`** ([`resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L82–89, dispatched at [`entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts) L77–80) is not a freshness signal at all. It answers *which copy*, and it fires only when a copy is invoked by path from another checkout.
- **The global-vs-local version warning** (`globalWarning`, [`resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L132–139, its one caller at [`entry.ts`](../../../packages/fabrika-cli/src/delegate/entry.ts) L84) reaches only the `warn-and-run-here` branch and is switched off by `FABRIKA_GLOBAL_WARNING_DISABLED` (README L57). The `pin.sh` record above already grades it as the weaker replacement for a refusal; it is weaker here for the same reasons.
- **`FABRIKA_DEBUG`** (README L74–80) is opt-in and off by default, so in an unattended session it is not a signal.

So the asymmetry the grading question names is **real**: nothing on this channel speaks once, ahead of use. What does not follow is that a probe should be built, because the state it would report is the state in which it cannot run.

**The one shape that would work, and why it is refused.** A probe *could* fire in that state if it were hosted as a shell file at a plugin path — `"${CLAUDE_PLUGIN_ROOT}"/hooks/…`, exactly v1's shape — since a hook is a harness-substituted surface and can name the plugin. That is the strongest case for building, so it is recorded rather than skipped. It is refused on two counts, neither of them taste: it is a fabrika artifact addressed **by path**, the artifact class [#5077](https://github.com/kamp-us/phoenix/issues/5077) grades and the class fabrika ships none of today (`find claude-plugins/fabrika -type d -name scripts` returns nothing); and rule 5 admits exactly one literal for a fabrika invocation, `fabrika`. Under the admissible shape the probe is circular, and under the shape that would work it is not fabrika's. There is no third option, so the build has no admissible form.

**What is lost:** one notice, delivered **once, before any use, into the agent's own context**. v1's `additionalContext` (L164–168) put "the guards are not enforcing" into the session before the agent planned its first tool call, and the same line reached the human on stderr at exit `2`. The channel gives back nothing session-scoped and nothing agent-addressed: a `127` at whichever fence the agent reached first, into whatever reads that process's stderr. So the notice moves from *once, ahead of use, in context* to *once per invocation, after the fact, in output* — and whether a `127` is read as "could not run" rather than as an answer now rests on each skill's own failure vocabulary — of which [`../skills/check-epic-plan/SKILL.md`](../skills/check-epic-plan/SKILL.md) L152–156 is the one confirmed to state the rule in its prose. Who would have noticed: an agent driving a fabrika skill on a machine with no install. Under v1's analogue it had the warning before step 1; here it learns mid-run, and if it reads the `127` as a verdict, nothing else tells it otherwise. That is weaker, and it is weaker in the direction that matters — the reader who most needed the signal is the one who no longer gets it.

**UNKNOWN:** what Claude Code does when a **declared** hook's command is itself unresolvable. The retire above rests on a fabrika session-start hook being unable to speak when `fabrika` does not resolve, and the probe's silence is established (README L96–97); what is **not** established is whether the harness surfaces anything of its own in that state — a hook-failure line to the user, or nothing. It could not be checked first-hand: when this record was written fabrika declared no hooks, and a `SessionStart` hook cannot be fired from inside a running session. [#5074](https://github.com/kamp-us/phoenix/issues/5074) has since declared one, so the probe is now *possible* on a machine with no install — it is still not *done*, and this record does not claim it. If the harness does report it, that reporting — not a fabrika verb — is what partially covers the loss above, and this record does not claim it does. Also unknown: v1's degraded branch itself. Only the healthy branch was exercised here (silent, exit 0); the exit-2 path could not be reproduced without manufacturing a broken install, so its behaviour is read from the source, not seen.

**Not graded here:** three boundaries, all of them deliberate.

- **The fail-open-vs-fail-closed policy for a fabrika hook whose verb cannot run** was [#5079](https://github.com/kamp-us/phoenix/issues/5079)'s and is now ruled — see [the policy point](#the-dispatch-failure-policy-point). This record grades what a session-start *signal* would be worth; it takes no position on what a hook should *do* in the degraded state.
- **`spawn-guard`'s other two modes**, `guard` and `statusline`, are not graded. The model/allowlist defence is [#5075](https://github.com/kamp-us/phoenix/issues/5075)'s; this record covers the `freshness` subcommand only.
- **Whether fabrika declares a hook surface at all** was [#5074](https://github.com/kamp-us/phoenix/issues/5074)'s, and it now has: see [The surface](#the-surface). This record answers only that `freshness` needs nothing on it, which the landed surface does not change — the hook declared there is the surface's own proof, not a degraded-state signal.

**This record mints no fabrika hook, by path or otherwise, so the planting question stays closed.** [#5077](https://github.com/kamp-us/phoenix/issues/5077)'s record defers to this one on exactly that condition; the condition does not fire.

**Owner:** this doc, plus [#4791](https://github.com/kamp-us/phoenix/issues/4791). The residue in **What is lost** is the unreadable `127`, and #4791's publish-and-install removes the state that produces it. Nothing else survives that needs a fabrika-side home.

### `spawn-guard guard` — PORT

**Verdict:** PORT.

**Graded against:** `packages/pipeline-cli/src/tools/spawn-guard/spawn-guard.ts` (deleted with the tool — ADR [0282](../../../.decisions/0282-spawn-guard-retired.md); readable at the pinned commit) L31 (`ALLOWLIST`), L43 (`MODEL_ALIASES`), L54 (`DEFAULT_PIN`), L87 (the canonicalization), L92–L145 (`decideSpawn`) · `packages/pipeline-cli/src/tools/spawn-guard/command.ts` (likewise deleted) L54–L114 (the `guard` mode: the stdin read, the `WORKFLOW_MODEL` read, the three renderings) · [`../../kampus-pipeline/hooks.json`](../../kampus-pipeline/hooks.json) (the v1 `PreToolUse` declaration) · [`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L66–L91 · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 L185–198, rule 6 L239–242 · ADR [0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md), ADR [0116](../../../.decisions/0116-spawn-guard-durable-default-pin.md), ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md). Line numbers true at commit `066b9c4a`.

**What it does in v1:** a `PreToolUse` hook on `Task|Workflow`. It reads the harness envelope on stdin, takes `tool_input.model`, resolves the `WORKFLOW_MODEL` pin from the environment — an absent pin falling back to a committed default (ADR 0116) — and renders one of three outcomes: allow an allowlisted model, allow an unset request so the spawn inherits the session model, deny an off-allowlist request. It fails closed on a model that is present and wrong (ADR 0092), and its `systemMessage` always states what it checked. The crash mode it defends is a spawn that quietly runs on a cheaper or wronger model than the fleet is meant to use: nothing downstream reports it, so the tokens go and the run looks normal.

**The channel property that carries the verdict:** **nothing about the ruled channel touches the crash mode, so it survives the move intact.** The delivery layer answers *which copy of fabrika runs* — it walks to the repo root and asks Node's resolver ([`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md), *How it is delivered*) — and says nothing about *which model a subagent spawns on*. The other four records above retire because the channel absorbed their subject: there is no data dir, no installed copy to place, no shell pin file, no separately-installed dep to go stale. A model allowlist has no such subject to lose. The one thing the channel does fix is the *form*: rule 5 admits exactly one command shape, so the hook is a plain `fabrika hook spawn` literal, and rule 6 (ADR 0238) makes the decision fabrika's own code rather than a call into v1.

Ported at [`../../../packages/fabrika-cli/src/hook/spawn.ts`](../../../packages/fabrika-cli/src/hook/spawn.ts) (the pure decision) over [`../../../packages/fabrika-cli/src/models.ts`](../../../packages/fabrika-cli/src/models.ts) (the allowlist, the alias map and the default pin — one table, because the requested model is canonicalized through the aliases before the allowlist sees it), with [`../../../packages/fabrika-cli/src/hook/spawn-verb.ts`](../../../packages/fabrika-cli/src/hook/spawn-verb.ts) as the shell. `models.ts` is fabrika's single source for alias knowledge, which is what [#5158](https://github.com/kamp-us/phoenix/issues/5158) consumes.

**What is lost:** two things, both real.

- **The `statusline` and `freshness` modes do not come with it.** `freshness` is already graded RETIRE above; `statusline` is not graded anywhere yet (see *Not graded here*). The port carries the `guard` mode only.
- **The dispatch-failure behaviour is weaker than v1's, on the ruled policy.** v1 reached the guard through `guard.sh`, which fail-opened by contract too — so this is not a regression against v1, but it is not a gain either: a machine where `fabrika` does not resolve runs every spawn with the defence absent and says nothing per-spawn, because a `PreToolUse` command that never ran produces no permission decision. Who would notice: nobody, until a token bill. [#5079](https://github.com/kamp-us/phoenix/issues/5079) ruled the polarity (fail open, notice owed) without closing this exposure; this record states it rather than pretending the port does.

**UNKNOWN:** three.

- **`Workflow` was never captured.** The declaration matches `Task|Workflow`, mirroring v1, but only a `Task` spawn was captured (`PROVENANCE.md`, capture 2) — the two golden spawn envelopes are `Task` ones. Whether a `Workflow` spawn's envelope carries `tool_input.model` in the same place is read from v1's behaviour, not seen.
- **The hook has not been observed firing in an enabled plugin.** The verb is exercised end to end against captured bytes through the argv in the committed declaration, which is the strongest proof available in-repo; what is not established is the harness actually invoking it, since the plugin is inert until enabled and no gate executes the harness (ADR 0180's premise).
- **The alias table is captured for one family only.** `opus` and `opus[1m]` are grounded — the captured spawn envelope carries `"model": "opus"`. Whether the harness has other alias spellings for the same family is not established; an unknown spelling would deny, which is the fail-closed direction.

**Not graded here:** two boundaries.

- **`spawn-guard statusline`** is not graded by this record or any other. It is out of [#5075](https://github.com/kamp-us/phoenix/issues/5075)'s scope by its own terms, and it needs a record before the v1 tool can be called fully graded.
- **The `WORKFLOW_MODEL` pin's own provenance** — who sets it, and whether fabrika should keep reading an env pin at all — is untouched. The port reads it exactly where v1 read it.

**Owner:** `fabrika hook spawn`, declared in [`../hooks.json`](../hooks.json). The dispatch-failure residue is [the ruled policy point](#the-dispatch-failure-policy-point) plus [#4791](https://github.com/kamp-us/phoenix/issues/4791), which removes the `127` state the notice cannot cover; the ungraded `statusline` mode has no owner yet.

## Related

[#5075](https://github.com/kamp-us/phoenix/issues/5075) · [#5076](https://github.com/kamp-us/phoenix/issues/5076) · [#5077](https://github.com/kamp-us/phoenix/issues/5077) · [#5078](https://github.com/kamp-us/phoenix/issues/5078) · [#4927](https://github.com/kamp-us/phoenix/issues/4927) (the container) · [#4791](https://github.com/kamp-us/phoenix/issues/4791) (publish) · ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)
