# Extracted skill scripts — the shell shape that fails closed on bash 3.2

The shell under `claude-plugins/kampus-pipeline/skills/**` runs through `#!/usr/bin/env bash`,
which on macOS is **bash 3.2** — the interpreter every local agent run gets. Every gate written
there is trusted precisely because it is green, so the shape it is written in has to make a green
exit *mean* something. Two of bash 3.2's status/expansion behaviours defeat the shape good
practice recommends, so they are written down here rather than rediscovered per script
([#4479](https://github.com/kamp-us/phoenix/issues/4479); epic
[#4435](https://github.com/kamp-us/phoenix/issues/4435) is multiplying this corpus from 12 files
to ~106).

## The rule

1. **`set -uo pipefail` — never `-e`.** Two independent reasons, either one sufficient:
   `errexit` aborts a fail-closed branch *before* it prints its BLOCKING line (turning fail-closed
   into fail-**open**), and `errexit` combined with a cleanup `EXIT` trap swallows a `set -u`
   abort into **exit 0** (below).
2. **Default every array expansion** — `"${arr[*]-}"` / `"${arr[@]-}"` — so a `set -u` abort is
   impossible in the first place. This holds on every bash version, which is why it is the belt to
   rule 1's braces.
3. **Test emptiness before expanding an array into an argument list.** On bash 3.2 `"${arr[@]-}"`
   over an *empty* array expands to **one empty-string argument**, not to nothing — so
   `grep -q pattern "${files[@]-}"` reads an empty file list as the file `""`. Gate it:
   `[ "${#files[@]}" -eq 0 ] && { …refuse…; }`.
4. **Guard an unmatched glob.** bash 3.2 has no `nullglob` rescue in these scripts, so
   `for f in "$dir"/*/scripts/*.sh` yields the *literal* unmatched pattern — `[ -f "$f" ] || continue`
   before use.
5. **Anything `errexit` used to catch is checked explicitly.** Dropping `-e` means a failed
   command substitution no longer aborts, so the assignments a script's correctness rests on
   (`mktemp -d`, a resolved root) get their own fail-closed check.
6. **A resolver read through process substitution withholds its output on a failed scan.** In
   `done < <(resolve …)` the producer's exit status is unobservable *even in principle*, so a
   partially-failing `find` (unreadable subdirectory, a race with a writer — it prints what it
   could read and exits non-zero) would hand the caller a silently narrowed but **non-empty** list
   that its `-eq 0` zero-scope guard reads as complete. Capture the status where the pipeline runs,
   and on failure emit **nothing** on stdout, a diagnostic on stderr, and a non-zero return: the
   empty stdout is what reaches the caller's existing zero-scope guard
   ([#4487](https://github.com/kamp-us/phoenix/issues/4487)). A genuinely empty surface still
   exits 0 — empty is a fact, a failed scan is UNKNOWN, and the two must not look alike.

## Where each rule is mechanically enforced

Two different rules about the `EXIT` trap, two different enforcers, two different scopes — they
are not interchangeable, and citing one for the other's job is a live mis-authoring path
([PR #4526](https://github.com/kamp-us/phoenix/pull/4526) did exactly that):

| Rule | Scope | Enforcer |
|---|---|---|
| Rule 1's co-occurrence: `errexit` enabled **together with** an `EXIT` trap in one runnable shell unit | the extracted `scripts/*.sh` of `claude-plugins/kampus-pipeline/**` | **no CI job** since [#6098](https://github.com/kamp-us/phoenix/issues/6098): `trap-status-guard.yml` retired with the rest of `pipeline-cli`'s self-policing guards. `claude-plugins/fabrika/**` carries no `.sh` file and no extracted-script idiom, so the pair the guard reddened on cannot occur there; the v1 corpus it did cover retires with the plugin ([#5937](https://github.com/kamp-us/phoenix/issues/5937)). Check 6 below is what still runs. |
| No cleanup `EXIT` trap **at all** in executable code | the extracted `scripts/*.sh` of the skill(s) the verifier is run over | [`claude-plugins/kampus-pipeline/skills/plan-epic/scripts/verify-extraction.sh`](../claude-plugins/kampus-pipeline/skills/plan-epic/scripts/verify-extraction.sh) check 6 ([#4476](https://github.com/kamp-us/phoenix/issues/4476), class [#4479](https://github.com/kamp-us/phoenix/issues/4479)) |

`trap-status-guard` red on the *pair* and nothing else: a cleanup trap without `errexit` was fine by
it, which was correct — that combination keeps the abort's status (see the matrix below). Check 6 is
stricter because an extracted script that later regains `-e` would silently re-enter the fail-open,
so the trap is banned outright in that corpus. Neither enforces the sourced class's no-options shape;
that one survives on the header idiom below.

## The two invocation classes — executed and sourced

The rule above is the **executed** class's shape, and executed is the sanctioned class: an agent
runs a skill script as `bash ./.claude/.pipeline/skills/<skill>/scripts/<script>.sh`
and reads the results off stdout ([ADR 0232](../.decisions/0232-agents-execute-skill-scripts-never-source-them.md)).
The `.claude/.pipeline` prefix is a symlink the plugin's hooks plant at the live install: a fence may
carry no expansion at all, so the only path that resolves both in this repo and in a marketplace
consumer's tree is a literal the consuming repo itself provides
([#4605](https://github.com/kamp-us/phoenix/issues/4605); the mechanism is in the plugin's
[README](../claude-plugins/kampus-pipeline/README.md)). **A missing link is exit 127 with empty
stdout — UNKNOWN by the §ZS rule above, never a negative answer.**

The corpus also holds a **sourced** class — the ~61 files that set *no* shell options at all. Read
them as history, not as a choice on offer:

- **Recognize one by its header, and leave it alone.** The idiom is an explicit "SOURCED, never
  executed" note plus zero `set -` lines. The exemplar is
  [`claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2-verdict-gate.sh`](../claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2-verdict-gate.sh),
  whose header states the reason: *"this file deliberately sets NO shell options — several guards
  here depend on `pipefail` being OFF."* The missing `set -uo pipefail` is the design, not an
  omission — adding it "for consistency" changes those guards' behavior.
- **Why no options.** `set` in a sourced file runs in the *caller's* shell, so the options persist
  and change every subsequent command in that session — including commands the script's author
  never saw.
- **A sourced file must default EVERY read, because it inherits options it did not choose.** Setting
  no options is not the same as running without them: the caller's `set -u` is in force inside the
  sourced body, so one undefaulted `$VAR` aborts the caller's shell *at the read* — before the
  script's scope line, before any clause completes, before a refusal can name itself. The caller
  then sees a reasonless non-zero, which is indistinguishable from the guard running and refusing,
  and the state that fires it can be the ordinary one (`iso_preflight` read `$WORKTREE_ROOT` bare,
  and that variable is unset on every local agent run, so its green branch was unreachable —
  [#4591](https://github.com/kamp-us/phoenix/issues/4591)). Defaulting is not the fail-open it looks
  like *provided the defaulted signal can only tighten the answer*: check that the variable appears
  only in clauses that arm a refusal, and that the permissive branch rests on something else.
- **Report an absent signal three ways, not two.** `${VAR:+set}` renders unset and exported-blank
  identically, which erases the difference between "I checked and the answer is no" and "I could not
  check". When a guard's conclusion turns on a signal, print `${VAR+d}${VAR:+v}`'s three cases so
  the log says which one it saw.
- **What ADR 0232 settled.** Sourcing a skill script at an agent's top-level command is banned
  (the harness's isolation verifier refuses `.` itself, by any path form), the sourced class
  converts to executed scripts, and *leave-state-in-the-caller's-shell* is retired as a design
  property — the harness resets shell state between an agent's Bash calls, so it never carried
  cross-call value. Do not design a new script to mutate its caller's shell.
- **In-script sourcing of the shared helper lib stays sanctioned.** The verifier judges only the
  agent's top-level command; a script sourcing the shared lib internally is unaffected, and
  `verify-extraction.sh` check 5 *requires* it (a local copy would drift). The cycle validators of
  [ADR 0230](../.decisions/0230-cycle-validators-follow-the-source-edge.md) follow that source edge
  as before.

## The dual-mode shape — an executed entry over a preserved source edge

A shared script under `skills/shared/scripts/` is reached two ways at once, and ADR 0232 retires only
one of them. An **agent** invokes it as a top-level command, which must be literal-path execution
with results on stdout. Another **script** sources it in-chain for the functions or variables it
defines — the edge ADR 0232 explicitly keeps sanctioned, [ADR 0230](../.decisions/0230-cycle-validators-follow-the-source-edge.md)'s
validators follow, and `verify-extraction.sh` check 5 requires. Converting such a file to a
source-hostile executed script orphans its in-script consumers at `rc 127`, which no CI check sees.

So the converted shape is **both**: the file's existing top-level body and function definitions stay
exactly as they were, and an **executed entry** is added that runs them and prints their results.
Four rules make it hold:

1. **Two literal guards, `[ "${BASH_SOURCE[0]}" = "$0" ]`** — one near the top applying the shell
   options, one at the bottom holding the entry. The condition is written out at both sites rather
   than hidden behind a helper function, because a helper is itself state the sourcing caller
   inherits.
2. **`set -uo pipefail` fires in executed mode only.** `set` in a sourced file runs in the *caller's*
   shell, and several in-chain consumers (`ship-it/scripts/step0-*.sh`) deliberately set no options —
   applying the options unconditionally would silently change their guards' behaviour, which is
   exactly the not-a-relay change ADRs [0228](../.decisions/0228-scripts-relay-never-derive.md)/[0229](../.decisions/0229-mechanical-combination-is-relay.md)
   forbid.
3. **The in-script `.` line does not move and does not indent.** `kp_skill_source_edges` matches the
   sourcing idiom anchored at **column 0**; wrapping one in an `if` makes the edge invisible, which
   narrows a cycle validator's surface in silence, and re-writing one with an interpolated directory
   makes the whole edge list UNRESOLVED and reds the skill.
4. **The entry's exit status is `could I answer`, never `did I find something` — and no `grep` or
   `while` may set it by accident.** The stdout rule below says what an entry must *print*; this says
   what it must *return*, and the two are equally load-bearing, because the intake contract's §SHARED
   tells every reader to *read the exit status first* and treat any non-zero as UNKNOWN. So an entry
   whose ordinary answer is *nothing found* must still return **0** — and under rule 2's `pipefail`
   two ordinary shapes silently return 1 instead:
   - a **filter left inside the pipeline** (`… | grep <pattern> | while …`) leaks `grep`'s no-match
     exit 1 as the pipeline's status. Capture the filter's output into a variable first, with an
     explicit `|| true`, then loop over the variable.
   - an **`&&` loop body** (`while read -r x; do [ -n "$x" ] && printf …; done`) over an *empty*
     variable makes the failing `[ -n "" ]` the loop's last executed command, so the `while` — and
     the script — returns 1. Use an `if … fi` body, whose status is 0 when no branch runs.

   Both mis-fire only on the **empty/clean** input, which is exactly the class a
   populated-input-only recipe cannot see: `cp-guard-adr.sh`, `dev-tier-m.sh` and `cp-read.sh
   team-roster` each shipped this defect and each returned 1 on its clean answer (#4571). Prove the
   entry's status against the **empty** input as well as the populated one, or the rule is untested.

The executed entry prints one `NAME=value` line per value the sourced form used to leave in the
shell (a multi-valued one repeats a singular key — `CP_FILE=<path>` alongside `CP_FILES_N=<n>`), so
the two modes' answers correspond line for line. It adds no decision logic: it relays what the
sourced body already computed.

Rule 4's *empty means 0* is not the same as *empty means fine*: whether an empty result is a fact or
a failed read is the **script's** call, made in its body, and the entry only relays it. `cp-read.sh`
carries both answers — `changed-files` treats zero files as a failed read (non-zero, nothing on
stdout) because a PR always changes at least one file, while `team-roster` prints `CP_MEMBERS_N=0` at
exit 0 because an empty team is a real answer (the ADR-0175 N==0 STOP). The failure rule 4 removes is
the entry *inventing* a non-zero the body never decided.

## Why: the measured matrix

Measured on `GNU bash 3.2.57(1)-release (arm64-apple-darwin23)`. Each script assigns a temp dir,
optionally installs the trap, then reads an unset variable under `set -u`:

| options | EXIT trap | script exit | what the trap sees in `$?` |
|---|---|---|---|
| `set -uo pipefail` | none | **1** | — |
| `set -uo pipefail` | `rm -rf "$t"` | **1** | `1` |
| `set -uo pipefail` | `rc=$?; rm -rf "$t"; exit $rc` | **1** | `1` |
| `set -euo pipefail` | none | **1** | — |
| `set -euo pipefail` | `rm -rf "$t"` | **0** — fail OPEN | `0` |
| `set -euo pipefail` | `rc=$?; rm -rf "$t"; exit $rc` | **0** — fail OPEN | `0` |

Two consequences worth stating out loud, because both contradict the obvious reading:

- **`-e` is the discriminator, not the trap body.** Without `-e` the abort's status survives the
  same cleanup trap. With `-e` it is already gone.
- **A status-preserving trap does not rescue it.** `trap 'rc=$?; …; exit $rc' EXIT` is the usual
  advice and it is *useless here*: under `-e` the trap runs with `$?` already reset to 0, so the
  trap faithfully preserves and re-exits **0**. Only a trap that ends in a *failing* command, or
  an explicit non-zero `exit`, produces non-zero — neither of which a cleanup trap can know.

What is *not* swallowed under `-e`: a plain command failure (`false` → exit 1) and an explicit
`exit 1` both survive a succeeding EXIT trap. The loss is specific to the `set -u` abort.

**bash >= 4 is UNVERIFIED.** CI runs `ubuntu-latest` (bash 5.x) and there is no bash >= 4 on the
macOS box this was measured on, so whether the swallow reproduces there is an open question — do
not assert either direction without a real bash-5 run. It is not load-bearing for the rule: rules
1 and 2 make the outcome version-independent, which is why the rule is stated as a shape rather
than as a version workaround.

## The banned shape, for recognition

Shown as non-runnable text on purpose — do not copy it:

```text
set -euo pipefail
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT
...
grep -q "$needle" "${files[@]}"      # empty array + set -u -> abort -> laundered to exit 0
```

The house shape:

```bash
set -uo pipefail

tmp_root="$(mktemp -d)"
if [ -z "$tmp_root" ] || [ ! -d "$tmp_root" ]; then
	echo "FAIL: mktemp -d produced no temp root — refusing to run against nothing (ADR 0092)"
	exit 1
fi
trap 'rm -rf "$tmp_root"' EXIT

if [ "${#files[@]}" -eq 0 ]; then
	echo "FAIL: zero scope — no file resolved (ADR 0092)"
	exit 1
fi
grep -q "$needle" "${files[@]-}"
```

## Where it is used

- `claude-plugins/kampus-pipeline/skills/validate-cycle-absence.sh` and
  `validate-cycle-presence.sh` — both carried `set -euo pipefail` + a `mktemp -d` cleanup trap;
  both now run `set -uo pipefail` with explicit checks on the two assignments `errexit` used to
  cover. The undefaulted `${scanned_paths[*]}` that made the fail-open reachable was fixed
  separately ([#4476](https://github.com/kamp-us/phoenix/issues/4476), PR
  [#4473](https://github.com/kamp-us/phoenix/pull/4473)).
- `claude-plugins/kampus-pipeline/skills/validate-gate-path-drift.sh` — the `[ -f "$sh" ]`
  unmatched-glob idiom (rule 4).
- `claude-plugins/kampus-pipeline/skills/shared/scripts/iso-preflight.sh` — the sourced-class
  defaulting rule above. Pinned by
  `claude-plugins/kampus-pipeline/skills/shared/scripts/iso-preflight-setu-proof.sh`, which stands
  the guard up in a sandbox primary / linked-worktree / symlinked-primary matrix under a
  `set -uo pipefail` sourcing caller across all three states of each signal, and asserts the guard
  reached its answer rather than merely returning the expected status
  ([#4591](https://github.com/kamp-us/phoenix/issues/4591)).
- `claude-plugins/kampus-pipeline/lib/common.sh` — `kp_skill_shell_surfaces`, the
  surface resolver both cycle validators consume through `< <(…)` (rule 6). Pinned by
  `lib/common-test.sh`, which forces a partial `find` failure with an unreadable
  subdirectory and asserts non-zero + empty stdout + a stderr diagnostic; run in the `skills` CI
  job.

## The failure it prevents

A guard that hits an unbound variable **passes**. The status is the only thing a caller reads —
`.github/workflows/ci.yml` invokes these validators as a bare `- run: bash …` with no `|| true`
and no `continue-on-error`, so the fail-open is handed straight to the required check, which goes
green over a validator that stopped executing partway through.

Adjacent fail-open classes, cross-linked not merged: `jq -e` returning a false-y success
([#4431](https://github.com/kamp-us/phoenix/issues/4431)), the clean-exit umbrella
([#4482](https://github.com/kamp-us/phoenix/issues/4482)), and `mapfile` inside `< <(…)`
discarding the substituted command's status
([#4508](https://github.com/kamp-us/phoenix/issues/4508)).
