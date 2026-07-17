# Probe discipline — fail-OPEN liveness/health probes

The crew's conducting roles (the **engineering-manager** engine, the **chief-of-staff**
verifier) routinely probe an external surface for liveness — most often "is the GitHub API
reachable/healthy right now?" before dispatching a lane, verifying a landing, or reading the
board. **This doc is the single source for how those probes must behave.** The two conductor
defs cite it; they never re-derive the rule inline.

A probe that cannot itself execute must resolve to **"unknown", never "down".** That one rule
is the durable fix; the no-bare-`timeout` convention below is belt-and-suspenders.

## Why this exists — the ~5h false-outage stall (#3411)

A conductor session wrapped its GitHub-API liveness probe in a bare `timeout …`. On the macOS
shell the crew runs on there is **no `timeout` on PATH** — GNU `timeout` ships as `gtimeout`
via coreutils, or is absent (`command -v timeout` → not found, `command -v gtimeout` → not
found). So every probe command exited non-zero because the **wrapper binary was missing**, not
because the probed API was unhealthy. The conductor mapped that non-zero to "API still down",
held all agent dispatches, and baked idle for ~5 hours — while the API was fine throughout
(concurrent `gh` reads kept succeeding; rate limit ~4994). A real transient blip earlier had
killed the in-flight agents; the missing-binary probe is what turned a momentary blip into a
5-hour false outage, silent until a human asked why the conductor wasn't working.

That is a **fail-CLOSED probe**: a probe that could not execute resolved to "down" instead of
"unknown", and a broken liveness probe that concludes "system down" can strand a whole
conductor lane indefinitely with nothing surfaced upward. It is the same class as the
harness-worktree stripped-PATH incident (#787–#789): an agent command assuming a binary/PATH
that isn't there. Grounding it once here keeps a future conductor from re-improvising the trap.

## The rule — three outcomes, and "unknown" never gates

A liveness/health probe resolves to **exactly one of three** outcomes; keep them distinct:

1. **reachable / healthy** — the probe ran and the target answered healthy. Proceed.
2. **reachable / unhealthy ("down")** — the probe **actually ran** and observed the target
   failing (a real HTTP error, a timeout the target itself blew, a definitive unhealthy body).
   This is the **only** outcome that may gate/hold dispatches.
3. **UNRUNNABLE ("unknown")** — the probe **could not execute**: a missing binary (the `timeout`
   trap above), a PATH strip, an exec/spawn error, no network stack, a malformed command. This is
   **not** "down". It carries no information about the target's health.

The load-bearing distinction is between (2) and (3): "the target answered unhealthy" versus "I
could not ask the target". A non-zero exit alone does **not** distinguish them — the missing-
binary exit and the target-is-down exit look identical at the shell. So a conductor must not
collapse "the probe failed" into "the API is down".

**A conductor never takes a destructive or holding action on "unknown".** Never hold dispatches,
strand a lane, or conclude an outage from an unrunnable probe. On "unknown" the safe default is
to **proceed as if reachable** (fail-open) and let the *actual* operation surface a real error if
the target truly is down — the board is the durable truth surface (a climbing needs-triage count,
an unmoving PR), not a probe's inability to run. Only outcome (2) — a probe that ran and observed
the target unhealthy — may gate.

## The no-bare-`timeout` convention (belt-and-suspenders)

Don't wrap a probe (or any command) in a binary that may not exist on the shell. Concretely:

- **Never assume `timeout` is on PATH.** It is absent on the crew's macOS shell. A bare
  `timeout N cmd …` fails on the *missing wrapper*, not on `cmd`, and that failure is exactly
  the fail-closed trap above.
- **If you need a bound, use a portable one:** `gtimeout` *only if* `command -v gtimeout`
  succeeds; else a backgrounded-PID + kill; else no bound at all. The harness Bash tool already
  enforces its own multi-minute ceiling, so most probes need no explicit timeout wrapper.
- **A node-based bounded probe** (an `AbortController` + `fetch`, run with `node`) is the
  portable, dependency-free bound when you genuinely need one — it needs no coreutils binary and
  distinguishes "could not run" from "ran, target failed" cleanly in its own exit handling. This
  matches the crew's Node-over-shell-glue convention.
- **Guard the binary before you lean on it:** `command -v <bin> >/dev/null || { … treat as
  unknown, do not conclude down … }`. A guard that resolves a missing binary to "unknown" is the
  code-level shape of the fail-open rule.

Carry both rules together: fail-open semantics neutralize the whole class regardless of which
binary a future probe reaches for, and the portable-bound convention keeps a probe from tripping
on the missing binary in the first place.
