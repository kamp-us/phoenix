#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016
# Reviewer-runnable proof that write-code's corpus follows the ADR-0232 executed/stdout convention and
# the .patterns/skill-script-shell-shape.md shape.
#
# It REPLACES `verify-byte-move.sh` and `verify-repair-extraction.sh`, whose shared premise ADR 0232
# retired: both proved the scripts and repair.md were BYTE-IDENTICAL to the fenced blocks they came
# from, and a conversion of those very bytes cannot preserve byte-identity. Keeping a proof whose
# claim the ruling falsified would be worse than no proof — it would go red on the correct diff and
# then be routinely overridden. What is still checkable is the property the conversion has to hold,
# and that is what this asserts.
#
# Checks 5 and 6 are the #4605 portability half, and they are LIVE PROBES rather than greps: the
# corpus now reaches its own scripts through `.claude/.pipeline`, a hook-planted symlink at the live
# plugin install, so both the link's presence and its absence are runtime states this file has to
# characterize rather than assume.
#
# Usage:  bash claude-plugins/kampus-pipeline/skills/write-code/scripts/verify-executed-contract.sh
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)" || exit 1
cd "$ROOT" || exit 1
REL=claude-plugins/kampus-pipeline/skills/write-code
PLUGIN=claude-plugins/kampus-pipeline
LINKED=./.claude/.pipeline
fail=0

SCRIPTS=$(git ls-files "$REL/scripts/*.sh" | grep -v "/verify-")
if [ -z "$SCRIPTS" ]; then
  echo "FAIL: zero scope — no script resolved under $REL/scripts (ADR 0092)"
  exit 1
fi
echo "scope: $(printf '%s\n' "$SCRIPTS" | wc -l | tr -d ' ') script(s) under $REL/scripts, plus SKILL.md and repair.md"

echo "=== 1. shell shape: \`set -uo pipefail\`, never \`-e\`, and no cleanup EXIT trap"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! grep -qx 'set -uo pipefail' "$f"; then
    printf 'BAD   %s — no column-0 `set -uo pipefail` line\n' "$f"; fail=1
  fi
  if grep -qE '^set -[a-z]*e[a-z]* ' "$f"; then
    printf 'BAD   %s — enables errexit; `-e` launders a `set -u` abort into exit 0 under a cleanup trap\n' "$f"; fail=1
  fi
  if grep -qE '^[[:space:]]*trap[[:space:]].*EXIT' "$f"; then
    printf 'BAD   %s — installs an EXIT trap; banned outright in this corpus (#4476, class #4479)\n' "$f"; fail=1
  fi
done <<EOF
$SCRIPTS
EOF
[ "$fail" -eq 0 ] && echo "OK    every script opens \`set -uo pipefail\`, none enables -e, none installs an EXIT trap"

echo "=== 2. the retired sourced-class header must be gone"
# shellcheck disable=SC2086
hits=$(grep -nl 'SOURCED, never executed' $SCRIPTS 2>/dev/null || true)
if [ -z "$hits" ]; then
  echo "OK    no script still declares itself SOURCED, never executed"
else
  echo "BAD   still declared sourced:"; printf '%s\n' "$hits"; fail=1
fi

echo "=== 3. no fenced block in SKILL.md / repair.md sources at the TOP LEVEL, and none interpolates CLAUDE_PLUGIN_ROOT"
# Column-0 is where the extraction convention puts every runnable line, and a leading `. ` / `source `
# there is exactly the form the harness's isolation verifier refuses (by ANY path shape).
for doc in "$REL/SKILL.md" "$REL/repair.md"; do
  hits=$(grep -nE '^(\.|source)[[:space:]]' "$doc" || true)
  if [ -n "$hits" ]; then
    printf 'BAD   %s carries a top-level sourcing line:\n' "$doc"; printf '%s\n' "$hits"; fail=1
  fi
  hits=$(grep -nE '^[[:space:]]*(\.|source|bash)[[:space:]].*CLAUDE_PLUGIN_ROOT' "$doc" || true)
  if [ -n "$hits" ]; then
    printf 'BAD   %s invokes a script through the interpolated CLAUDE_PLUGIN_ROOT idiom:\n' "$doc"; printf '%s\n' "$hits"; fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "OK    both docs invoke scripts only by literal path"

echo "=== 4. every literal-path invocation names an EXISTING script, through the PORTABLE prefix"
# The teeth of this check are the two assertions below — a target that exists, and a prefix that is
# not the repo-relative `./claude-plugins/` literal. Nothing here credits the extraction regex with
# more than it does: `grep -o` reads one line at a time, so a fence a future editor reformats across
# a `\` continuation simply falls out of the scan, and the property is then held by check 4b's
# corpus-wide prefix sweep (which is line-shape-blind) and by the live 127 probe in check 5 — not by
# this capture. Stating that here rather than claiming the capture is exhaustive is the point: a
# check whose header over-claims is a check nobody re-derives (#4605 acceptance condition 5).
#
# `./claude-plugins/…` resolves ONLY inside a phoenix checkout. A marketplace consumer installs the
# plugin into its own cache, outside its repo, so that literal is a guaranteed `No such file or
# directory` there — the #4605 incident. The portable literal is `./.claude/.pipeline/…`, a symlink
# the SessionStart / WorktreeCreate hooks plant at whatever install is live.
INVOKED=$(grep -hoE 'bash \./\.claude/\.pipeline/skills/[a-z-]+/scripts/[A-Za-z0-9_.-]+\.sh' \
  "$REL/SKILL.md" "$REL/repair.md" | sed 's|^bash \./\.claude/\.pipeline/||' | sort -u)
if [ -z "$INVOKED" ]; then
  echo "FAIL: zero scope — the docs invoke no script by the portable literal path at all (ADR 0092)"
  fail=1
else
  echo "      scope: $(printf '%s\n' "$INVOKED" | wc -l | tr -d ' ') distinct literal-path invocation target(s)"
  # Resolve against the physical plugin dir, not through the link: this harness must be runnable in a
  # bare checkout (CI, a reviewer's clone) where no session has planted the link yet. In this repo the
  # two are the same tree by construction — the link's in-repo target IS `claude-plugins/kampus-pipeline`.
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ ! -f "$ROOT/$PLUGIN/$p" ]; then printf 'BAD   %s is invoked but does not exist\n' "$p"; fail=1; fi
  done <<EOF
$INVOKED
EOF
  [ "$fail" -eq 0 ] && echo "OK    every portable literal-path invocation names a script that exists"
fi

echo "=== 4b. no runnable line in the write-code corpus carries the non-portable ./claude-plugins/ literal"
hits=$(grep -nE '(^|[^[:alnum:]./_-])\./claude-plugins/[A-Za-z0-9._-]+/(skills|bin|lib|hooks)/' \
  "$REL/SKILL.md" "$REL/repair.md" || true)
if [ -z "$hits" ]; then
  # The corpus-wide counterpart of this check is the skill-corpus lint's fence-portability gate,
  # run by the `skill-gh-lint.yml` job; this one is the write-code-scoped, authoring-time restatement.
  echo "OK    zero repo-relative ./claude-plugins/ path literals in the write-code docs"
else
  echo "BAD   non-portable literal(s) — these break in every consuming repo (#4605):"; printf '%s\n' "$hits"; fail=1
fi

echo "=== 5. a MISSING link is 127 with ZERO stdout bytes — and 127 is RESERVED for it"
# The sharpest property in this file. When `.claude/.pipeline` is absent or dangling, every fence in
# the corpus is `bash <path-that-does-not-exist>`, which exits 127. A caller that reads a bare
# non-zero as "the script answered no" would then treat the remedy's own startup state as an ordinary
# negative and fail OPEN — the exact hazard #4605 acceptance condition 2 forbids.
#
# The discrimination is the PAIR (exit code, stdout bytes) plus the reservation of 127:
#   * link missing        -> exit 127, ZERO stdout bytes        (the script never ran: UNKNOWN)
#   * legitimate negative -> a NON-127 exit, and for a §ZS refusal also zero bytes
#   * legitimate answer   -> exit 0 with the answer on stdout
# Neither operand alone separates the three; 127-with-no-stdout is decisive only because no corpus
# script may exit 127 as an answer, which is asserted rather than assumed at the end of this check.
PROBE=skills/write-code/scripts/step3_5-my-claim.sh
TMP="$(mktemp -d)"
if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
  echo "FAIL: mktemp -d produced no temp root — refusing to probe against nothing (ADR 0092)"
  exit 1
fi

probe_row() {   # <label> <tree> <expected-rc> <expected-bytes-are-zero:yes|no>
  local label="$1" tree="$2" want_rc="$3" want_empty="$4" out rc bytes
  out="$(cd "$tree" && THREADED_CLAIM_TOKEN=probe-token bash "$LINKED/$PROBE" 2>/dev/null)"
  rc=$?
  bytes=$(printf '%s' "$out" | wc -c | tr -d ' ')
  local empty=no; [ "$bytes" -eq 0 ] && empty=yes
  if [ "$rc" = "$want_rc" ] && [ "$empty" = "$want_empty" ]; then
    printf 'OK    %-22s rc=%-3s stdout-bytes=%s\n' "$label" "$rc" "$bytes"
  else
    printf 'BAD   %-22s rc=%-3s stdout-bytes=%s (want rc=%s, empty=%s)\n' "$label" "$rc" "$bytes" "$want_rc" "$want_empty"
    fail=1
  fi
}

mkdir -p "$TMP/absent/.claude" "$TMP/dangling/.claude" "$TMP/good/.claude"
ln -s "$TMP/no-such-install" "$TMP/dangling/.claude/.pipeline"
ln -s "$ROOT/$PLUGIN" "$TMP/good/.claude/.pipeline"
probe_row "link absent"    "$TMP/absent"   127 yes
probe_row "link dangling"  "$TMP/dangling" 127 yes
probe_row "link good"      "$TMP/good"     0   no

# And the legitimate negative, through a GOOD link: the same script with no claim token refuses. It
# must be non-zero (so `|| exit 1` still stops the caller) and it must NOT be 127 (so the caller can
# tell "answered no" from "never ran").
neg_out="$(cd "$TMP/good" && env -u THREADED_CLAIM_TOKEN -u CLAUDE_CODE_SESSION_ID bash "$LINKED/$PROBE" 2>/dev/null)"
neg_rc=$?
neg_bytes=$(printf '%s' "$neg_out" | wc -c | tr -d ' ')
if [ "$neg_rc" -ne 0 ] && [ "$neg_rc" -ne 127 ] && [ "$neg_bytes" -eq 0 ]; then
  printf 'OK    %-22s rc=%-3s stdout-bytes=%s — distinguishable from a missing link\n' "legitimate negative" "$neg_rc" "$neg_bytes"
else
  printf 'BAD   %-22s rc=%-3s stdout-bytes=%s (want a non-zero, non-127 exit with 0 bytes)\n' "legitimate negative" "$neg_rc" "$neg_bytes"
  fail=1
fi

# The reservation, asserted per FILE: 127 in this corpus means one thing only — a could-not-run of
# the pipeline-cli shim (`kp_pcli`'s miss, a literal shim resolution's miss, or the verb-level 127
# either forwards). That is the same UNKNOWN class as a missing link, never an ordinary answer. A
# file that exits 127 without ever reaching the shim is overloading the code, and that overload is
# exactly what would erase the missing-link signal this check exists to keep decisive.
res=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -qE '(^|[^[:alnum:]_])exit[[:space:]]+127' "$f" || continue
  grep -qE 'kp_pcli|bin/pipeline-cli' "$f" && continue
  res="$res $f"
done <<EOF
$SCRIPTS
EOF
if [ -z "$res" ]; then
  echo "OK    127 is reserved for a could-not-run: every script that exits 127 does so off the kp_pcli miss"
else
  echo "BAD   script(s) exit 127 without reaching the shim — that erases the missing-link signal:$res"; fail=1
fi

echo "=== 6. FOREIGN INSTALL: the fence resolves from a repo that does not vendor the plugin"
# The property no existing check asserted, and the exact gap that let #4605 ship. Build the consumer's
# actual shape — a git repo with NO `claude-plugins/` directory, and the plugin living in a cache
# OUTSIDE it — plant the link with the shipped hook script, and execute a real fence from the
# consumer's root. Hermetic and network-free: the probe script reads env only.
CACHE="$TMP/plugin-cache/kampus-pipeline"
CONSUMER="$TMP/consumer"
mkdir -p "$TMP/plugin-cache" "$CONSUMER"
cp -R "$ROOT/$PLUGIN" "$CACHE"
( cd "$CONSUMER" && git init --quiet ) || { echo "FAIL: could not init the consumer fixture"; rm -rf "$TMP"; exit 1; }
if [ -e "$CONSUMER/claude-plugins" ]; then
  echo "BAD   the consumer fixture vendors claude-plugins/ — it is not a foreign install"; fail=1
fi
if bash "$CACHE/hooks/plant-pipeline-link.sh" "$CONSUMER" >/dev/null; then
  link_target="$(readlink "$CONSUMER/.claude/.pipeline")"
  case "$link_target" in
    /*) echo "OK    planted an ABSOLUTE link into the out-of-repo install (a consumer has nothing in-tree to point at)" ;;
    *)  echo "BAD   planted a relative link ($link_target) in a repo that does not vendor the plugin"; fail=1 ;;
  esac
  f_out="$(cd "$CONSUMER" && THREADED_CLAIM_TOKEN=foreign-token bash "$LINKED/$PROBE" 2>/dev/null)"
  f_rc=$?
  if [ "$f_rc" -eq 0 ] && [ "$f_out" = "MY_CLAIM=foreign-token" ]; then
    echo "OK    \`bash $LINKED/$PROBE\` runs from the consumer root and resolves its sibling lib/ through the link"
  else
    printf 'BAD   the foreign fence failed: rc=%s stdout=[%s]\n' "$f_rc" "$f_out"; fail=1
  fi
  # The consumer's tree must stay CLEAN. We cannot edit their `.gitignore` — it is theirs — and a
  # tree the link dirties is a tree the worktree sweep KEEPS forever (#3943), so every lane would
  # leak. `.git/info/exclude` is what keeps the artifact invisible without touching their VCS.
  dirty="$(git -C "$CONSUMER" status --porcelain 2>/dev/null)"
  if [ -z "$dirty" ]; then
    echo "OK    planting left the consumer's working tree clean (excluded per-clone, never in their .gitignore)"
  else
    printf 'BAD   planting DIRTIED the consumer tree: [%s]\n' "$dirty"; fail=1
  fi
  # The design asymmetry, made visible rather than left as prose: inside the link the LOGICAL path
  # looks in-repo while the physical file lives in the cache, so anything that shells out to git from
  # there resolves the CACHE's location, not the consumer's repo. `kp_pcli` therefore resolves the
  # shim from its own file location and never from `git rev-parse --show-toplevel` (#4605).
  if grep -qE 'show-toplevel[^\n]*claude-plugins' "$CACHE/lib/common.sh"; then
    echo "BAD   lib/common.sh still derives a plugin path from \`git rev-parse --show-toplevel\` — wrong for every consumer"; fail=1
  else
    echo "OK    lib/common.sh derives the plugin root from its own location, never from the caller's git repo"
  fi
else
  echo "BAD   plant-pipeline-link.sh could not plant into the foreign consumer fixture"; fail=1
fi

echo "=== 7. the PreToolUse belt plants into the tool's OWN tree, and can never block a tool call"
# WorktreeCreate is inert on the harness path that provisions isolation:worktree agent trees (#4180),
# so the belt is what actually covers a worktree lane. Two properties, both load-bearing: it plants
# into the payload's `cwd` (which for an isolated subagent is its worktree, not the project dir), and
# it exits 0 unconditionally — a PreToolUse hook's non-zero exit is a BLOCK, and a link-planting
# convenience must never be able to stop an agent from working.
BELT="$CACHE/hooks/plant-link-pretooluse.sh"
LANE="$TMP/lane"
mkdir -p "$LANE"
printf '{"cwd":"%s","hook_event_name":"PreToolUse"}' "$LANE" | bash "$BELT" >/dev/null 2>&1
belt_rc=$?
if [ "$belt_rc" -eq 0 ] && [ -d "$LANE/.claude/.pipeline/skills" ]; then
  echo "OK    the belt planted a resolving link into the payload's own tree (rc=$belt_rc)"
else
  printf 'BAD   the belt did not plant into the payload tree: rc=%s\n' "$belt_rc"; fail=1
fi
printf 'not json at all' | bash "$BELT" >/dev/null 2>&1
belt_rc=$?
if [ "$belt_rc" -eq 0 ]; then
  echo "OK    a garbage payload still exits 0 — the belt can never block a tool call"
else
  printf 'BAD   the belt exited %s on a garbage payload — a PreToolUse non-zero BLOCKS the tool\n' "$belt_rc"; fail=1
fi

rm -rf "$TMP"
[ "$fail" -eq 0 ] || { echo "FAIL: the executed/stdout convention is not held."; exit 1; }
echo "OK: write-code follows the ADR-0232 executed/stdout convention, and its fences are portable (#4605)."
