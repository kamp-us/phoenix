# fabrika hook surface

The reference for fabrika's Claude Code hook layer: **the surface** — where a fabrika hook is declared and how it invokes a verb — and **the record format** every grading child writes into. Which pieces of v1's Claude Code hook layer survived into fabrika, one recorded verdict per graded v1 piece plus the proven/unproven account of the delivery channel, is the sibling page's subject: [`hook-records.md`](hook-records.md).

## The surface

fabrika declares its hooks in one file, [`../hooks.json`](../hooks.json), in the plugin directory. There is no dispatch script, no installed-copy path to resolve and no version marker to compare, and that is not an omission — it falls out of two rules that are already ruled, so this section cites them instead of restating them:

- **A hook command is a plain literal `fabrika <group> <verb>` string** — no `$VAR`, no `${VAR:-default}`, no command substitution, no `source` ([`cli-interface-convention.md`](cli-interface-convention.md) rule 5, and ADR [0232](../../../.decisions/0232-agents-execute-skill-scripts-never-source-them.md)).
- **A hook calls only verbs implemented in [`../../../packages/fabrika-cli/`](../../../packages/fabrika-cli/)** — never `pipeline-cli`, never anything under `../../kampus-pipeline/` ([`cli-interface-convention.md`](cli-interface-convention.md) rule 6, ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)).

Which copy of the CLI serves the invocation is answered by the repo-root shim, not by the hook: [`../../../packages/fabrika-cli/docs/packaging.md`](../../../packages/fabrika-cli/docs/packaging.md), *Which copy serves an invocation*. That is what deletes v1's wrapper / data-dir / pin apparatus from this surface — every job those three did has a home somewhere else, as the [Records](hook-records.md#records) grade one by one.

Both rules are checked as **data**, not by eye: [`../../../packages/fabrika-cli/src/hook/declaration.ts`](../../../packages/fabrika-cli/src/hook/declaration.ts) reads `hooks.json` and reports every command that carries a shell construct, is not a plain `fabrika <group> <verb>` literal, or names something outside fabrika — and [`../../../packages/fabrika-cli/src/hook/envelope.golden.test.ts`](../../../packages/fabrika-cli/src/hook/envelope.golden.test.ts) reds on a non-empty report, and on an empty surface (a declaration with zero hooks is never a pass — ADR [0092](../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

### The declared hooks, and how they are proven

One hook is declared **on this surface** today. This repo declares a second on its own, in
[`.claude/settings.json`](../../../.claude/settings.json) — `fabrika hook worktree-create` on
`WorktreeCreate` — for the reason [below](#worktreecreate--a-provider-hook-left-undeclared): that
event is safe where the toolchain is guaranteed and unsafe where it is not, so it lives where the
guarantee holds and never here. Both documents are read by the same
[`declaration.ts`](../../../packages/fabrika-cli/src/hook/declaration.ts) and judged against the same
two rules; what differs is which events each may carry.

`fabrika hook check` on `SessionStart` is this surface's proof — it reads the envelope the harness writes to a hook's stdin and answers whether it is one fabrika can act on ([`../../../packages/fabrika-cli/src/hook/check-verb.ts`](../../../packages/fabrika-cli/src/hook/check-verb.ts)).

There was a second: `fabrika hook spawn` on `PreToolUse`, the model-allowlist guard. It is **retired** — verb, declaration and decision all deleted — by ADR [0331](../../../.decisions/0331-fabrika-spawn-hook-retired.md), which carries ADR [0282](../../../.decisions/0282-spawn-guard-retired.md)'s ruling into fabrika. The graded record ([`spawn-guard guard` — PORT](hook-records.md#spawn-guard-guard--port), now marked superseded) is kept as history and no longer describes live code. So **no fabrika hook decides anything today**; the surface answers questions and blocks nothing.

A declared hook nobody ever runs is the false-green this repo keeps paying for, so the proof does not stop at the declaration. The test **runs the argv it reads out of the committed `hooks.json`** — never a literal in the test — against **captured** `SessionStart` and `PreToolUse` envelopes, with the two subagent-spawn captures pinned by shape, all committed at [`../../../packages/fabrika-cli/src/hook/__fixtures__/`](../../../packages/fabrika-cli/src/hook/__fixtures__/) with their capture method, date and harness version beside them in `PROVENANCE.md` (ADR [0180](../../../.decisions/0180-capture-real-runtime-artifact-before-coding.md); the method is [`../../../.patterns/golden-real-payload-fixtures.md`](../../../.patterns/golden-real-payload-fixtures.md)). Two properties are what make that a proof rather than a schema asserted against itself: the argv comes from the declaration, so a green test cannot be exercising a verb the surface does not name; and the fixtures are what Claude Code 2.1.226 really sent, so the shape assertions pin keys a doc-assumed envelope would have missed — `PreToolUse` carries `prompt_id`, `permission_mode` and `effort`, and v1's hand-authored spawn-guard envelope knew about none of them.

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

A machine with no fabrika install would therefore lose `--worktree` entirely, which is the inverse of ADR [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md). **Left undeclared on this surface, and that refusal is unchanged.**

> **The event is now declared elsewhere, and the distinction is the whole reason it could be (ADR [0337](../../../.decisions/0337-worktree-provisioning-rehomed-onto-repo-settings.md), #7220).** Everything above binds a *plugin* declaration, which travels to every adopting repo — that is what makes the no-fail-open exposure unbounded. phoenix's own [`.claude/settings.json`](../../../.claude/settings.json) travels nowhere, and a phoenix checkout without fabrika is already broken, so the same event carries a bounded cost there: it declares `fabrika hook worktree-create` with a 600s timeout, which provisions the worktree ADR [0109](../../../.decisions/0109-worktree-deps-provision-not-share.md)'s install would otherwise leave dep-less. rule 5 binds that command exactly as it binds one here, and [`declaration.ts`](../../../packages/fabrika-cli/src/hook/declaration.ts) reads both documents — so the golden test asserts, per document, that no `Worktree*` event ever appears on **this** surface. That assertion is the refusal above, with teeth.

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

**A deny never used an exit code anyway.** The retired `fabrika hook spawn` denied by returning exit **0** carrying `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`. That JSON mechanism is independent of the exit status, so any future `PreToolUse` hook that means to refuse has a way to say so without touching `2`. fabrika declares no `PreToolUse` hook today (ADR [0331](../../../.decisions/0331-fabrika-spawn-hook-retired.md)), so the exposure this section describes is latent, not live — the polarity is pinned regardless, because the bootstrap sites it constrains are shared by every hook.

<a id="the-dispatch-failure-policy-point"></a>
### The dispatch-failure policy point — RULED, [#5079](https://github.com/kamp-us/phoenix/issues/5079) (ADR [0250](../../../.decisions/0250-fabrika-hook-cannot-run-fails-open.md))

A fabrika hook's verb can fail to run: a bare `fabrika` exits `127` on a machine with no install ([`../../../packages/fabrika-cli/docs/running-fabrika-in-a-repo.md`](../../../packages/fabrika-cli/docs/running-fabrika-in-a-repo.md), *Install the CLI and confirm it runs*), and a cross-checkout invocation refuses with exit `126` ([`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts), the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch). The convention reserves both for *the verb never ran*, which is never a verdict ([`cli-interface-convention.md`](cli-interface-convention.md) rule 3).

**Ruled behaviour: fail open, and say so.** The harness event proceeds — a verb that never ran produced no evidence, so it may never deny. What is **banned is the silence**: the cannot-run state owes a visible degraded notice on stderr naming that the hook did not run and which defence is therefore absent. Fail-open-and-loud, never fail-open-and-forgotten. A verb that *runs* and returns a deny still fails closed as designed; the ruling touches the cannot-run case only.

There is **exactly one kind of place** that decides it, and it is the event a hook is declared on in [`../hooks.json`](../hooks.json). Rule 5 admits no wrapper script, so fabrika has nowhere to intercept an exit code from a process that never started; what a dispatch failure can do is therefore fixed by the event. `SessionStart` cannot abort anything. On `PreToolUse` the answer splits by **which** dispatch failure it is, and the split is the exit code:

- **Exit `127` — nothing ran.** No permission decision is produced, which the harness reads as no objection, so the spawn proceeds **unguarded**. This is the fail-open the ruling describes, reached by the process's own absence.
- **Every other non-zero exit — the process ran and refused.** Its stderr is shown and the spawn proceeds, per [the harness exit-code contract](#the-harness-exit-code-contract) above. This is fail-open-**and-loud**, which is what the ruling asks for.
- **Exit `2` — the spawn is blocked.** Not fail-open at all. It is the one code that denies, so no fabrika exit code may take it; that is enforced in the exit tables rather than left to this prose ([#5423](https://github.com/kamp-us/phoenix/issues/5423)).

This section previously grouped `2` and `127` together as "the verb never ran, so the spawn proceeds unguarded". That was true for `127` and **false for `2`**: while a bootstrap failure sat on `2`, a fabrika that could not resolve itself blocked every `Task`/`Workflow` spawn in the session — the inverse of the ruling, recorded here as fact.

Failing *closed* still has no admissible form, and for the reason the ruling gives: it would mean minting the interception rule 5 forbids. Do not spread the behaviour to a per-verb site; this section is the one place a later ruling flips.

The `PreToolUse` hook makes that cost real, and it is named rather than left implicit: a machine where `fabrika` does not resolve runs every spawn with the model defence silently absent — the exact silence the defence exists to remove.

**The notice is owed and only half-implementable today, so it is recorded rather than assumed.** On exit `126` the process did start and fabrika speaks for itself (`resolve.ts`'s foreign-checkout refusal). On exit `127` fabrika cannot speak, because `fabrika` is what failed to resolve, and the seam that would have carried a session-start signal is graded RETIRE in the [`spawn-guard freshness` record](hook-records.md#spawn-guard-freshness--retire) — so that half has **no owner**, and its structural cure is installing the package — now published, so the cure is available to any machine that takes it, and absent on any that does not. ADR 0250 carries the full reasoning, the two-family discriminator behind the polarity, and the requirement that an adversarial review precede any implementation of this horn in either direction.

## The record format

One `###` section per graded v1 piece, under [Records](hook-records.md#records). Each section carries these fields, in this order, and nothing else:

| Field | What it must contain |
| --- | --- |
| **Verdict** | Exactly one of **PORT**, **REDESIGN**, **RETIRE**. One verdict per piece — never two, never a hedge. |
| **Graded against** | The files read, by repo-relative path, with the line or section that carries the claim, and the commit the line numbers are true at. |
| **What it does in v1** | The job, in the v1 author's own terms, so the verdict is checkable against the thing being graded. |
| **The channel property that carries the verdict** | The specific property of the ruled delivery channel — quoted or cited to a line — that makes the verdict follow. A verdict without one is decoration. |
| **What is lost** | Mandatory. What guarantee this piece gave that the channel does not give back, and who would have noticed. Where something replaces it, say what the replacement *is* — a replacement that is weaker (a warning where v1 refused, one branch where v1 covered all of them) is stated as weaker, in those words. Write `nothing` only when the piece guarded nothing. |
| **UNKNOWN** | Mandatory, never omitted. What could not be checked first-hand — including a property this record leans on that lives on a branch with no end-to-end exercise. Write `none` explicitly when there is nothing. An unchecked thing is never written as a pass. |
| **Not graded here** | Deliberate scope boundaries and where each lands instead. Omit only when the record grades the whole piece. |
| **Owner** | The fabrika-side thing this lands against — a verb, [`hook-records.md`](hook-records.md), or a follow-up issue. For PORT/REDESIGN, what carries the work. For RETIRE, what carries the residue named in **What is lost**, or `none` when nothing is left to carry. |

The rule behind the format: **a recorded outcome is a claim about reality, so the next reader must be able to re-derive it.** Cite the file and line; mark the uncheckable UNKNOWN.

Three of those fields exist because of how the first three records were graded, and they are not interchangeable:

- **UNKNOWN and Not graded here are different fields on purpose.** "I could not check this" and "I deliberately did not grade this" are different claims, and one field cannot hold both — once a scope note occupies UNKNOWN, the real unknown has nowhere to go. That is not hypothetical: it is exactly how the [`pin.sh` record](hook-records.md#pinsh--retire) shipped an unproven property as a discharged one ([#5138](https://github.com/kamp-us/phoenix/pull/5138) round 1).
- **UNKNOWN is mandatory with an explicit `none`** because an omittable field is self-certified — a grader who checks nothing and a grader who checked everything write the same empty space. An explicit `none` is a claim a reviewer can attack.
- **What is lost exists because RETIRE is the verdict that removes something.** A record whose dominant verdict is RETIRE and which has no field for the residue lets a real reduction in guarantee — a refusal traded for a silenceable warning — read as a clean discharge.

**Amendment, [#5726](https://github.com/kamp-us/phoenix/issues/5726) — "the channel property" reads the harness too, and a PORT may be scoped.** Two changes to the format above, stated here rather than applied silently.

- **The channel is not always the delivery channel.** The six channel-delivery records ([`install.sh`](hook-records.md#installsh--retire) through [`spawn-guard guard`](hook-records.md#spawn-guard-guard--port)) all grade a piece whose fate is decided by *how fabrika is delivered*. The worktree records are decided by something else: what Claude Code enforces natively on the version this repo runs. So **The channel property that carries the verdict** admits an observed harness behaviour, cited to the version and the observation, in place of a delivery-channel property. A behaviour asserted from a changelog or a doc page is not admissible in that field — only something run.
- **A PORT may name a narrower subject than the v1 piece.** Several worktree records survive in part: one of two refusals, one of two entry points. Writing PORT unqualified would hand a builder the whole v1 scope back, and writing RETIRE would drop the live half. Such a record states its verdict as **PORT**, and its first line names the shrunken subject. The dropped half is accounted for in **What is lost**, with the harness behaviour that covers it.

