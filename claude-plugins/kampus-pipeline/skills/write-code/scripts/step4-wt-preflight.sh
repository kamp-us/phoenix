#!/usr/bin/env bash
# shellcheck shell=bash disable=SC1007,SC1091
# The per-mutation worktree preflight — the guard every commit / branch op / verified-push in
# Steps 4–5 and repair R2/R3 is gated on. EXECUTED, never sourced (ADR 0232): it runs the whole
# fail-closed classification here and prints the resolved worktree ROOT on stdout; every
# diagnostic and every refusal line goes to stderr. The caller consumes that root and addresses
# git at it explicitly (`git -C "$WT" …`) — the DECISION stays in the script, only its EFFECT
# moves to the caller, which is what the stdout contract (#4510) is for. A subprocess cannot
# change its parent's directory, and ADR 0232 retires leave-state-in-the-caller's-shell as a
# design property outright.
#
# The guard body itself is NOT here: `wt_preflight` and `lane_worktree` live in `lib/common.sh`,
# sourced below. This script owns only the EXECUTED FORM — run the guard, narrate to stderr, print
# the resolved root. The body stays in the lib because it has other consumers that call it as a
# function in their own shell (`shared/scripts/iso-preflight.sh`, `review-code/scripts/
# materialize-head.sh`, `ship-it/scripts/step0-preflight.sh`); a subprocess's functions never reach
# its parent, and no CI check can see that break (#4449 repair round 2).
#
# `set -uo pipefail`, never `-e`: errexit aborts a fail-closed branch before it prints its BLOCKING
# line, and paired with a cleanup EXIT trap it launders a `set -u` abort into exit 0
# (`.patterns/skill-script-shell-shape.md`). No EXIT trap is installed here either.
set -uo pipefail
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# `>&2` routes the guard's whole narration — the ambient-classification line and every refusal —
# to stderr WITHOUT touching a moved line, leaving stdout carrying exactly one thing: the root.
# Silence on stdout plus a non-zero exit is therefore UNKNOWN/REFUSED, never a permissive answer.
wt_preflight >&2 || exit 1
printf '%s\n' "$WT"
