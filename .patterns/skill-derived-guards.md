# Skill-derived guards — parse the skill, never mirror it

A lot of pipeline behaviour is *shipped as prose*: the shell an agent runs lives in a `SKILL.md`
step, not in a module. When a test wants to pin that behaviour, the tempting move is to re-express
the logic in TypeScript next to a comment saying "keep this in step with the skill". That mirror is
worse than no test: it reads as coverage, but a one-line edit to the skill leaves it green while the
shipped shell drifts underneath ([#4054](https://github.com/kamp-us/phoenix/issues/4054)).

**The rule: derive the assertion from the skill's own text.** The skill file stays the single
source; the guard parses the literal line it depends on and fails when that line changes shape.

## The shape

1. A pure parser module (`packages/pipeline-cli/src/tools/<tool>/*.ts`) that extracts the
   load-bearing literal — a regex assignment, a shell condition, a variable binding — out of the
   skill text it is handed. No IO, no path knowledge.
2. A **fail-closed** resolution for anything it cannot read: an unreadable, renamed, or truncated
   source resolves to the value that makes the consumer *refuse or go red*, never the value that
   makes it pass ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)).
3. A test that reads the real file repo-relative off its own location
   (`join(dirname(fileURLToPath(import.meta.url)), "../../../../..", …)`, CI-safe in a worktree and
   in Actions alike), asserts the live literal, and *feeds the parsed value into whatever executable
   mirror exists* so drift can't sit beside a passing behavioural test.
4. A falsification case in the same suite: apply the drift to the source text in memory and assert
   the parse no longer resolves. That is what proves the binding is load-bearing rather than
   decorative.

## Where it is used

- `class-probe.ts` — `parseClassProbes` / `parseUiProbe` read the canonical `HAS_*_RE=` and `UI_RE=`
  lines out of `gh-issue-intake-formats.md` §CLASS and `ship-it/SKILL.md`, with `FAILCLOSED_PROBES`
  over-dispatching gates on an unreadable source.
- `step3-contract.ts` — `parseStep3EntryTest` reads ship-it Step 3's branch-2 entry condition and
  resolves the rollup fields it tests, so `checks.unit.test.ts`'s branch mirror derives its pending
  predicate from the skill instead of copying it.

## The failure it prevents

A guard that *mirrors* prose passes over the exact edit it was written to catch. Editing ship-it
Step 3's entry test from the pending sets back to the rollup colour — the
[#3999](https://github.com/kamp-us/phoenix/issues/3999) fail-open, which happened once inside its own
fix's history — now flips the two regression cases to `proceed` and reds the suite, instead of
leaving a green test over a drifted shell.
