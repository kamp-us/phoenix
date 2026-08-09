# fabrika hook surface

fabrika's home for one question: **which piece of v1's Claude Code hook layer survives into fabrika, and in what form.** The v1 layer is frozen (ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)); the audit method that binds any answer here is *port by default, retire only per-hook on evidence* ([#4927](https://github.com/kamp-us/phoenix/issues/4927)).

This doc holds two things: the **record format** every grading child writes into, and the **records themselves**.

Today fabrika declares **no hooks at all**. Its plugin manifest, [`../.claude-plugin/plugin.json`](../.claude-plugin/plugin.json), carries no `hooks` key and the plugin directory contains no `hooks.json` — so every verdict below is a verdict about whether something needs to *enter* this surface, not about changing something already on it.

## The record format

One `###` section per graded v1 piece, under [Records](#records). Each section carries these fields, in this order, and nothing else:

| Field | What it must contain |
| --- | --- |
| **Verdict** | Exactly one of **PORT**, **REDESIGN**, **RETIRE**. One verdict per piece — never two, never a hedge. |
| **Graded against** | The files read, by repo-relative path, with the line or section that carries the claim, and the commit the line numbers are true at. |
| **What it does in v1** | The job, in the v1 author's own terms, so the verdict is checkable against the thing being graded. |
| **The channel property that carries the verdict** | The specific property of the ruled delivery channel — quoted or cited to a line — that makes the verdict follow. A verdict without one is decoration. |
| **UNKNOWN** | Anything that could not be checked first-hand, named as UNKNOWN. Never write an unchecked thing as a pass. Omit the field only when nothing was unchecked. |
| **Owner** | PORT/REDESIGN only: the fabrika-side thing it lands against — a verb, this doc, or a follow-up issue. |

The rule behind the format: **a recorded outcome is a claim about reality, so the next reader must be able to re-derive it.** Cite the file and line; mark the uncheckable UNKNOWN.

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

One honest wrinkle found while grading, worth recording because it is easy to mistake for proof: on a machine where the workspace copy has been hand-linked global (`pnpm link --global`), a bare `fabrika` **is** on `PATH` — but that global is the same checkout's copy, not a published artifact, and from a linked worktree it takes the foreign-checkout refusal (exit `2`, `resolve.ts` L82–89, the [#4956](https://github.com/kamp-us/phoenix/issues/4956) branch), reproduced first-hand. A hand-linked global is **not** evidence for the published half.

## Records

### `install.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/install.sh`](../../kampus-pipeline/hooks/install.sh) (whole file, 79 lines) · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered* · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 *Delivery* · [`../../../packages/fabrika-cli/src/delegate/node-resolve.ts`](../../../packages/fabrika-cli/src/delegate/node-resolve.ts) L24–43. Line numbers true at commit `a2729e6e`.

**What it does in v1:** a SessionStart hook that installs `@kampus/pipeline-cli` into a plugin data dir, version-aware and idempotent. It writes a minimal `package.json` into that dir (L59–65), runs `npm install` there (L69), and stamps the installed version into a marker file it compares on the next session (L39, L49–51). Every failure path degrades to exit 0 so an offline SessionStart still starts (L11–14, L69–79).

**The channel property that carries the verdict:** **the channel has no install step for a hook to perform, and no copy for a hook to place.** Delivery is one global install of the package plus whatever the repo root already installed — "finds the **repo root** above the working directory, asks **Node's own resolver** what copy of `@kampus/fabrika-cli` that root has installed, and hands the invocation to it" (README, *How it is delivered*). Resolution is a *read* of an install a package manager made (`node-resolve.ts` L31), never an install the hook makes. Each of install.sh's three jobs loses its subject:

- **The install** targets a data dir the channel does not have. A repo's copy arrives through its own manifest, not through a hook writing a `package.json` into a plugin dir.
- **The version marker** is replaced by the resolved install's own `version` field, read from the manifest the resolver returned ([`../../../packages/fabrika-cli/src/delegate/local.ts`](../../../packages/fabrika-cli/src/delegate/local.ts) L58–63). A marker exists to remember what a previous install did; a resolver that reads the live manifest has nothing to remember.
- **The degrade-to-exit-0 invariant** is replaced by the delivery's own totality rule — "**No outcome is both silent and wrong**" (README, *How it is delivered*, the five-row table) and the convention's "tiers that can only be right or loudly absent are fine; tiers that can be quietly wrong are the defect" (rule 5, *Delivery*). The worst outcome the channel admits is that the global runs, loudly; there is no session-aborting failure for a hook to swallow.

**UNKNOWN:** install.sh L26 also plants the `.claude/.pipeline` link before doing anything else. That planting is **not graded here** — it is [#5077](https://github.com/kamp-us/phoenix/issues/5077)'s subject, and this record deliberately takes no position on it. This retire covers install.sh's install-and-marker job only; if #5077 finds something that needs planting, its owner is that record, not a revived install.sh.

### `resolve-data-dir.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/resolve-data-dir.sh`](../../kampus-pipeline/hooks/resolve-data-dir.sh) (whole file, 28 lines) · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 L196–198 and *Delivery* L226–232 · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered*. Line numbers true at commit `a2729e6e`.

**What it does in v1:** resolves the directory `install.sh` installs into and `guard.sh` looks in (its own header, L2–3). Its whole substance is a hardening: Claude Code applies `settings.json` `env` values **verbatim**, so a wired `KAMPUS_PIPELINE_DATA="${CLAUDE_PROJECT_DIR}/..."` arrives with the token unexpanded, and consuming it created a literal `${CLAUDE_PROJECT_DIR}` directory at the repo root ([#2495](https://github.com/kamp-us/phoenix/issues/2495), L5–15). It discards any value still carrying `${` and fails closed (L22, L26).

**The channel property that carries the verdict:** **there is no data dir, and the channel forbids locating the binary by env var at all.** Rule 5: "A verb never requires an env var to *locate* itself. Configuration may still arrive by env (a session id, a target repo)" (L196–198). The three delivery env vars are named explicitly as *not* locating anything — `FABRIKA_DEBUG` traces, `FABRIKA_GLOBAL_WARNING_DISABLED` silences, `FABRIKA_SKIP_INFER` guards recursion (*Delivery*, L226–232). Location is answered by walking to the repo root and asking Node's resolver. The #2495 hazard is a hazard **of reading a settings-supplied env value as a path**; a channel that reads no env value for a path cannot reproduce it. There is no surviving pattern to redesign — the defence and the thing defended both go.

**UNKNOWN:** none. Both halves of this grading are readable in-repo; nothing here depends on the unpublished global.

### `pin.sh` — RETIRE

**Verdict:** RETIRE.

**Graded against:** [`../../kampus-pipeline/hooks/pin.sh`](../../kampus-pipeline/hooks/pin.sh) (whole file, 22 lines; the pin itself at L22) · [`../../../package.json`](../../../package.json) L24 · [`../../../packages/fabrika-cli/README.md`](../../../packages/fabrika-cli/README.md) *How it is delivered* · [`cli-interface-convention.md`](cli-interface-convention.md) rule 5 *Delivery* L210–224. Line numbers true at commit `a2729e6e`.

**What it does in v1:** holds one version string in a sourceable shell file so **two** consumers can read the same value — `install.sh` (what to install) and the `guard.sh` wrapper (what to refuse to dispatch below). The file's own header states why it is a separate file: a wrapper that cannot see the pin "can only test executability, and an executability test cannot tell a current build from a months-old one", which is how a stale tree kept being dispatched for months ([#3742](https://github.com/kamp-us/phoenix/issues/3742), L5–9).

**The channel property that carries the verdict:** **the root manifest devDependency is the pin.** "phoenix carries `@kampus/fabrika-cli` in its root `devDependencies`, so a bare `fabrika` anywhere in a phoenix checkout runs the version this repo pins" (README, *How it is delivered*); the convention states the same property as the reason the shim exists at all — "The property that buys is a **repo-pinned version**: a repo carrying `@kampus/fabrika-cli` in its `devDependencies` gets that version from a bare fence, whatever each machine's global happens to be" (rule 5, *Delivery*, L210–211). phoenix's declaration is [`../../../package.json`](../../../package.json) L24, `"@kampus/fabrika-cli": "workspace:*"`.

A second pin file would be a **second source for a value the manifest already owns** — the exact hand-sync the v1 header was at pains to avoid, reintroduced. And the drift-detection job pin.sh existed to enable now happens *inside the binary, per invocation*: the degenerate branch reads the version the root manifest declared and prints it beside the running copy's own version ([`../../../packages/fabrika-cli/src/delegate/resolve.ts`](../../../packages/fabrika-cli/src/delegate/resolve.ts) L132–139; `declaredVersion` in [`../../../packages/fabrika-cli/src/delegate/local.ts`](../../../packages/fabrika-cli/src/delegate/local.ts) L113–126). That is pin.sh's purpose, discharged by the delivery layer rather than by a shell file a hook sources.

**UNKNOWN:** pin.sh's second reader is the `guard.sh` version-gated dispatch wrapper, and **the wrapper's own fate is not decided here** — it is a separate decision child ([#4927](https://github.com/kamp-us/phoenix/issues/4927)'s split). What this record establishes is narrower and checkable: on the ruled channel the pin lives in the root manifest and the version comparison lives in the binary, so **no fabrika-side reader of a shell pin file exists**. If the wrapper decision later mints a fabrika hook that needs a version to compare, its input is the root manifest through a fabrika verb, not a revived `pin.sh`; that would be a new record in this doc, not an amendment to this one.

## Related

[#5076](https://github.com/kamp-us/phoenix/issues/5076) (this record) · [#5077](https://github.com/kamp-us/phoenix/issues/5077) · [#5078](https://github.com/kamp-us/phoenix/issues/5078) · [#4927](https://github.com/kamp-us/phoenix/issues/4927) (the container) · [#4791](https://github.com/kamp-us/phoenix/issues/4791) (publish) · ADR [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)
