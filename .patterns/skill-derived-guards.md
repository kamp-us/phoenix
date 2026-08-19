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

## The skill's text is not one file — parse the SURFACE

A skill's shell no longer lives only in its `SKILL.md`: epic #4435 moves fenced blocks into
`<skill>/scripts/*.sh`, sourced back by a `. "$<SKILL>_SCRIPTS/<name>.sh"` line. A parser handed
`readFileSync(SKILL.md)` therefore stops reaching the shell it parses **on a pure relocation** — and
the two ways that goes wrong are not equally visible:

- it **reds** on a change that altered no behaviour (the noisy case), or
- it **quietly stops asserting** — the parse resolves an empty population and every `notInclude` /
  "these two differ" row over it passes vacuously. `adoption-lint`'s ordering pin scoped itself to
  writers whose *text* contained a layer-one write, so when that write moved into a script the whole
  skill dropped out of a pin about its own claim ordering, with the suite still green
  ([#4509](https://github.com/kamp-us/phoenix/issues/4509)).

**So a section's surface is its heading slice plus the content of every `scripts/*.sh` the slice
sources.** `packages/pipeline-cli/src/skill-shell-surface.ts` owns that resolution once
(`resolveSection`), and the rules it fixes are worth stating because each was a real trap:

- **Slice on the pristine markdown, then append** the followed scripts. Inlining *before* the slice
  lets a script that emits markdown from a heredoc carry a `## ` line that truncates the section.
- **Sibling-scoped**, never the whole plugin tree: the plugin `lib/*.sh` is a library many skills call,
  so folding it into every caller's surface lets one shared half-procedure satisfy every skill's own
  rule (the same scoping `kp_skill_shell_surfaces` chose, #4470).
- **Scope by demonstrated dependency, not directory membership** — and keep the widening on the one
  check that needs it (ADR 0230; the record lands separately, so this cites it by number).
  Directory scoping alone punishes the correct move: a skill that extracts its wiring into a shared
  helper and sources it has nothing left on its own surface but a comment, so the guard starts
  passing on prose (#4541). The repair is per-skill, per-edge inclusion — a shared file counts for a
  skill because that skill's own executable text sources it (`kp_skill_source_edges`), one hop,
  fail-closed on an edge that will not resolve. Two rules keep this from becoming the whole-tree fold
  by another route: feed the widened surface **only** to the check that needs the shared file, never
  to the per-skill marker checks; and match `.sh` surfaces on **comment-stripped** text, so a
  commented-out edge stops following and a citation in a docblock proves nothing.
- **A sourced script that will not read back is UNRESOLVED, not absent** — the caller resolves its
  fail-closed constant, even if the constant it wanted is sitting inline right beside the source
  line. A partial read is not a read.
- **Emit the scanned scope** (`scanned`), and have the consumer *assert* it — a zero-length scope is
  what a renamed heading looks like, and it must red rather than resolve
  ([ADR 0092](../.decisions/0092-gates-fail-closed-on-zero-scope.md)).
- **Pin any population the parse derives from text.** If the parser discovers its own subject set
  (the outcome words of a `case`, the members of a list), assert its expected *membership* against
  an independent source — the classifier's own union, not the text — or a dropout is invisible.

Non-vacuity is worth one extra assertion: pin that the markdown slice *alone* no longer carries the
literal, so the positive match can only have come through the follow path. Counting scanned files
does not prove it — a section that sources three scripts is satisfied by an unrelated sibling.

## Where it was proven (retired instances, #5937 — cited as the pattern's provenance)

All three instances read the v1 `kampus-pipeline` skills and retired with them:
`class-probe.ts` (the `HAS_*_RE=`/`UI_RE=` probe lines), `step3-contract.ts` (ship-it Step 3's
branch-2 entry test) and `step55-contract.ts` (Step 5.5's poll budget + dispositions). The
pattern outlives them: the next time behaviour ships as SKILL.md prose, pin it by parsing the
skill's literal line, not by hand-mirroring it in TS.

## The failure it prevents

A guard that *mirrors* prose passes over the exact edit it was written to catch. Editing ship-it
Step 3's entry test from the pending sets back to the rollup colour — the
[#3999](https://github.com/kamp-us/phoenix/issues/3999) fail-open, which happened once inside its own
fix's history — now flips the two regression cases to `proceed` and reds the suite, instead of
leaving a green test over a drifted shell.
