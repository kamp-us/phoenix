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

Mechanically enforced for rule 1 by `pipeline-cli trap-status-guard check` (the
`trap-status-guard.yml` job), which reds on `errexit` + an `EXIT` trap inside one runnable shell
unit and fails closed on zero scope per surface ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

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
