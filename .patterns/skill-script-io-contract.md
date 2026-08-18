# Pipeline shell — the stdout/stderr contract

Every shell unit whose output a caller reads — a workflow `run:` step, a git-hook body, any
script whose stdout feeds a decision — writes on two streams, and which stream a byte lands on
is a **contract**, not a formatting choice. (The corpus this was measured on, the v1
`kampus-pipeline` plugin's shared lib and per-skill scripts, retired with that plugin — #5937;
the contract is what `fabrika`/`pipeline-cli` verbs and the remaining repo shell still honor.)

It became load-bearing when [ADR 0232](../.decisions/0232-agents-execute-skill-scripts-never-source-them.md)
made **stdout the return channel**: an isolated agent runs
`bash ./.claude/.pipeline/skills/<skill>/scripts/<script>.sh` and reads the result off
stdout, because sourcing at an agent's top-level command is refused by the harness. A diagnostic
printed on stdout is therefore not noise — it is **corruption of the return value**. That already
happened once: `cp_changed_files` put its §ZS scope sentence on stdout, a consumer whose stdout is a
machine channel sourced that sentence as if it were a path, and the read died on the literal text of
a §CP scope line ([#4510](https://github.com/kamp-us/phoenix/issues/4510)).

This doc states the channel rule and the exit taxonomy. The *shape* the shell is written in —
`set -uo pipefail`, defaulted array expansions, the trap enforcers — is
[skill-script-shell-shape.md](./skill-script-shell-shape.md); read both, they do not overlap.

## The rule

**Stdout is the unit's answer. Everything else is stderr.**

Applied per unit, where "the unit" is whatever the caller invokes and "the answer" is whatever the
caller consumes:

1. **Name the answer channel first.** Before writing a line, ask what this unit returns and how the
   caller reads it. Three shapes exist in this corpus, and they are not interchangeable:
   - **A machine channel** — stdout is parsed, sourced, or split by the caller (a handle path, a
     path list, a state word, a resolved repo). Nothing but the answer may land there.
   - **A prose channel** — stdout is the unit's human-readable verdict, and the caller matches on
     lines within it (`BLOCKING (…)`). The verdict *and* its §ZS scope statement belong there.
   - **No channel** — the unit is a sourced helper whose result is the variables it leaves in the
     caller's shell. Its stdout carries nothing, so **all** of its output is diagnostic and goes to
     stderr. This is the shape `cp-read.sh`'s functions have.
2. **Diagnostics go to stderr, always.** Progress, warnings, failure explanations, and the
   §ZS scope statement of a unit with a machine or absent answer channel.
3. **A §ZS scope statement is emitted by the unit that JUDGES, on that unit's own answer
   channel.** A guard states the scope its verdict rests on
   ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md) §ZS #1) — so a classifier whose
   stdout is prose prints its own scope line there, deriving the count from the helper rather than
   letting the helper print into its answer. A helper that only supplies an input does not judge, so
   its scope line is a diagnostic.
4. **Never make the caller redirect.** `helper >&2` at a call site is the smell this contract
   removes: it means the helper is writing on the wrong stream and every future caller has to know
   it. Fix the helper.

## The exit taxonomy

**Exit 0 means "I produced the answer on stdout". Any non-zero means "I could not produce one" —
UNKNOWN, never the permissive answer** ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

| Exit | Meaning | stdout | stderr |
|---|---|---|---|
| `0` | The answer was produced | the answer (possibly a legitimately empty set, see below) | nothing, or progress |
| non-zero | The unit could not run, or its input was UNKNOWN | **nothing** | a named diagnostic |
| `127` | The unit never ran at all (unresolved shim/binary — §CLI, [ADR 0207](../.decisions/0207-gh-path-shim-retired.md)) | **nothing** | a named diagnostic |

Two consequences that are easy to get backwards:

- **A helper that CANNOT RUN must FAIL, not emit the permissive answer.** The permissive answer is
  usually the empty/zero one — "no §CP path touched", "no violations found", "no dependencies", "no
  claim conflict" — and a failed read produces exactly that shape by accident. `cp_changed_files`
  treats a *successful* read returning zero files as a **failed read** for this reason: a PR always
  changes at least one file, so zero is not a clean negative. The counterexample worth naming is
  `cp_team_roster`, which returns zero members as a real answer and exits 0 — an empty team is a
  fact, an empty PR file list is not. Decide which one your unit is, and say so in its header.
- **Zero scope is not the only way this fails.** `parseBaseline` read a field-less manifest as
  `undefined`, and `undefined === 0` is `false`, so a zero-scope baseline read as *usable* — a guard
  vouching for a corpus it never scanned
  ([#4383](https://github.com/kamp-us/phoenix/pull/4383)). Assert on the positive shape you require,
  never on the absence of the failure you imagined.

## Non-zero with zero bytes of stdout is a fail-open, on the caller's side

The producer half of the rule above — *emit nothing on stdout when you fail* — is what makes a
failure reach a caller's existing zero-scope guard. But it hands that caller a stdout that is
**byte-identical to a successful empty answer**, and a caller that reads empty stdout as a positive
answer has nothing left to misread as a refusal
([#4488](https://github.com/kamp-us/phoenix/issues/4488) is the standing ticket for that refusal
shape; it is cross-cited here, not resolved here).

So the contract has a second half:

- **The positive answer must be a positive token, never an absence.** A unit whose stdout is prose
  states its scope and its verdict explicitly, so "ran and found nothing" and "never ran" are
  distinguishable at the caller without consulting anything else. `classify-control-plane.sh`
  (review-design) and `cp-classify-entry.sh` both key their ordinary answer on *the absence of a
  `BLOCKING (…)` line*; each therefore prints its own §CP scope line first, and that line — not the
  emptiness of stdout — is the evidence the run happened.
- **Read the exit status before the stdout**, and treat a non-zero as a hold regardless of what
  stdout says.
- **Assert on a state word, never on an exit status alone**, when a unit has more than two outcomes.
  An exit code discriminates outcomes only once the unit has *run*, so `… || ordinary` fail-opens on
  a usage error (`1`) or a missing binary (`127`).

## A meaningful exit code does not survive a pipeline

If a non-zero exit is carrying information beyond "failed", it must not be routed through a wrapper
that rewrites it. Measured on this repo's macOS box (BSD `xargs`, bash 3.2): a child exiting `42`
and a child exiting `3` both surface as `1`, so the code is gone. GNU `xargs` is recorded as
flattening child exits 1–125 to `123` ([#4568](https://github.com/kamp-us/phoenix/issues/4568)) —
different value, same loss. Either way a caller downstream of `xargs` cannot tell *"found
violations"* from *"could not run"*.

The rule that follows: **put the discriminator in a stdout state word, and keep the exit code binary
(`0` = answer produced, non-zero = UNKNOWN)** for any unit whose result crosses a pipeline. A
process substitution is worse still — in `done < <(producer …)` the producer's status is
unobservable *even in principle*, which is why the shape doc's rule 6 makes the producer withhold
its stdout instead ([#4487](https://github.com/kamp-us/phoenix/issues/4487)).

## Where it was proven (retired corpus, #5937 — cited as the contract's provenance)

- `claude-plugins/kampus-pipeline/lib/common.sh` —
  conforms throughout, and is the reference: `kp_skill_shell_surfaces`, `kp_surface_text` and
  `kp_skill_source_edges` each emit **nothing** on stdout, a named diagnostic on stderr, and a
  non-zero return when their scan is UNKNOWN; `kp_repo`, `kp_pcli` and `kp_scratch_*` print one
  value on stdout and fail closed rather than yield an empty string. Pinned by
  `lib/common-test.sh`, which asserts non-zero + empty stdout + a stderr diagnostic on a forced
  partial `find` failure.
- `claude-plugins/kampus-pipeline/skills/shared/scripts/cp-read.sh` —
  the sourced §CPREAD helpers: no stdout at all, results in `CP_*` variables, every scope and
  failure line on stderr.
- `skills/review-code/scripts/classify-control-plane.sh` — a **machine** answer channel of
  `KEY=value` lines, which is why every failure path prints the flags as a §CP sentinel before
  exiting non-zero rather than leaving stdout empty. Its `%q`-quoted flags are the positive-token
  rule applied literally: the ordinary not-§CP answer is `''`, not an absence. Its siblings
  `materialize-head.sh` and `run-evidence-read.sh` are the same shape — each once returned a path to
  a §SP handle for the caller to source, and ADR 0232 moved the answer onto stdout while the handle
  stayed behind purely for the *later scripts of the same skill* to re-source in-process (#4574).
- `skills/review-design/scripts/classify-control-plane.sh` and
  `skills/shared/scripts/cp-classify-entry.sh` — **prose** answer channels, each printing its own
  §CP scope line ahead of the `BLOCKING (…)` lines.
