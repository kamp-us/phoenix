# Verb output pin surfaces — the six places a printed shape is written down

A fabrika verb prints one grammar, and that grammar is hand-copied into six surfaces. Nothing
compares them. Change what a verb prints, miss a copy, and the copy you missed still reads as true
to everyone who opens it — CI stays green, the test suite stays green, and the only thing that
catches it is a reviewer who happened to open that file.

This doc is the list, so a sweep has a defined scope instead of whatever the builder thought to
grep. It ships no guard and no tooling: that is the founder's ruling on
[#6523](https://github.com/kamp-us/phoenix/issues/6523), which picked the list over a
`--help`-versus-contract diff guard, because contracts are free prose with no machine-readable
grammar block to diff against.

## The rule

**A change to a verb's printed output updates every listed surface in the same PR.** This is ADR
[0308](../.decisions/0308-bounded-evidence-output-shape.md)'s Consequence "Contracts move with their
verb, in the same PR" with the surfaces named — the ADR states the rule, this doc says where to
apply it.

## The six surfaces

Examples are from `ship checks` and `ship evidence`, the pair whose collapse under ADR 0308 burned
all three of child [#6482](https://github.com/kamp-us/phoenix/issues/6482)'s repair rounds, one
surface per round.

| Surface | Where it lives | Example |
|---|---|---|
| Contract prose | the skill's `contract.md`, the verb's **Output** paragraph | [`claude-plugins/fabrika/skills/ship/contract.md`](../claude-plugins/fabrika/skills/ship/contract.md) — the `ship checks` **Output** paragraph spelling out `checks\t<sha>\t<green\|red\|…>`, `run\t<count>`, the `check\t…` tally and the `facts\t…` line |
| Contract worked examples | the fenced `$ fabrika …` blocks in the same `contract.md`, further down under **Examples** | the four `fabrika ship checks` blocks in that file — a plain, a `no-runs`, a `no-producer` and a `--wait` run, each printing the rows literally |
| The skill's `SKILL.md` | the step that runs the verb and names its terminals | [`claude-plugins/fabrika/skills/ship/SKILL.md`](../claude-plugins/fabrika/skills/ship/SKILL.md) — step 4 routing off `green` / `red` / `wedged` / `no-runs` / `no-producer` and off what the notes channel names |
| The verb's `Command.withDescription` help string | `packages/fabrika-cli/src/<group>/command.ts` | the `checks` and `evidence` help strings in [`packages/fabrika-cli/src/ship/command.ts`](../packages/fabrika-cli/src/ship/command.ts), each opening "First stdout line is …". `Command.withShortDescription` sits one line above and usually pins the same shape in a clause — read both |
| The README group section | the group's table row in the package README | the `ship checks` and `ship evidence` rows under `## The ship group` in [`packages/fabrika-cli/README.md`](../packages/fabrika-cli/README.md) |
| Source docblocks | the verb module's top docblock and any helper's | [`packages/fabrika-cli/src/ship/checks-verb.ts`](../packages/fabrika-cli/src/ship/checks-verb.ts)'s module docblock naming the rollup states, and [`packages/fabrika-cli/src/evidence.ts`](../packages/fabrika-cli/src/evidence.ts)'s docblock defining what an evidence-array collapses to |

## Sweeping them

Three things make a copy easy to miss, and each has a cheap answer:

- **The file-extension boundary.** A sweep scoped to `claude-plugins/**` never opens a `.ts` file,
  which is exactly how #6482's third round died. Grep the whole repo for the literal row prefix
  (`checks\t`, `run\t`) rather than a directory.
- **Prose and examples are two passes, not one.** The **Output** paragraph and the fenced blocks
  sit hundreds of lines apart in the same `contract.md`; fixing the paragraph does not put you
  anywhere near the blocks.
- **Short and long descriptions are two strings.** `withShortDescription` is a separate line from
  `withDescription`, and a shape clause hides in either.

The copy count is expected to shrink once
[#6713](https://github.com/kamp-us/phoenix/issues/6713)'s diataxis pass splits the fabrika-cli docs,
which today mix reference, rationale and how-to on one surface. Until then, six is the number.
