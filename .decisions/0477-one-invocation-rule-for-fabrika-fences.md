---
id: 0477
title: The interface convention owns the one fabrika invocation rule, with scratch copies its named exception
status: accepted
date: 2026-10-05
tags: [fabrika, cli, skills]
---

# 0477 — The interface convention owns the one fabrika invocation rule, with scratch copies its named exception

**What this decides:** how a fabrika command is written in a skill is stated in one place,
interface-convention §5. Fences use the short `fabrika` command, except in a fresh worktree an agent
works in, where they name the copy outright as `node <fabrika>`.

## Context

Two documents gave an author opposite orders. Interface-convention §5 said every fence in every
skill writes `fabrika <group> <verb>` and nothing else. The `operate` skill said never use the bare
`fabrika` command, because "in a worktree it resolves to another checkout's code", and wrote every
command as `node <fabrika>`. An author writing an operator example could not follow both
([#9442](https://github.com/kamp-us/phoenix/issues/9442)).

`operate`'s reason was also older than the code. ADR
[0287](0287-delegation-stays-inside-one-repository.md) made the short form hand the call to the
calling worktree's own copy. The trace recorded on
[#5764](https://github.com/kamp-us/phoenix/issues/5764) showed what is left: a worktree with no
install of its own runs the global install instead, and warns loudly naming both versions. A fresh
agent worktree with no install is a normal state, so that narrow case is real.

The founder ruled on #9442
([comment 5752590240](https://github.com/kamp-us/phoenix/issues/9442#issuecomment-5752590240)):
the shared convention doc owns the rule, the scratch-copy case is written down there as a named
exception, and the other doc stops giving its own contradicting order.

## Decision

**Interface-convention §5 is the only home of the fabrika invocation rule, and the scratch-copy
case is its one named exception.**

- **The default is the short form**, `fabrika <group> <verb> …`, in every skill fence, `--help`
  example, contract spec and command written for a person.
- **A scratch copy is a git worktree an agent works in for one run.** It is the one place
  the short form can run another tree's code, so a fence run there writes `node <fabrika>`, where
  `<fabrika>` is the repo-relative source path in fabrika's own repo and the absolute installed bin
  everywhere else.
- **The exception reaches** every fence in `operate`, the lane verbs the stage skills run off a
  spawn brief's fields, and, at run time, every verb a briefed shell runs through its brief's
  `fabrika:` field. Nothing else.
- **The hazard is stated as the #5764 trace found it**: the short form runs the calling tree's copy
  when that tree has an install, runs the global and warns loudly naming both versions when it has
  none, and refuses at `126` across repositories.

**Binding constraints.**

- A skill states no invocation policy of its own. It links §5 and the exception.
- The hazard is never restated as "a worktree always resolves to another checkout's code"; that was
  the #5679 defect ADR 0287 fixed.

## Consequences

**An author reads one section and writes the right form.** `operate`'s entrypoint section now
points at §5 rather than repeating the two paths and the ban.

**No guard enforces the form.** Text drift is caught in review, as before.

**The `lane-brief` wire text still carries the old wording.** Its byte-fixed rule and its
`fabrika:` field error still say a binstub "resolves to another checkout's code". Correcting that
text is code work outside this record.

## Records

- Transcribes the founder's ruling on
  [#9442, comment 5752590240](https://github.com/kamp-us/phoenix/issues/9442#issuecomment-5752590240),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The hazard's three outcomes are ADR [0287](0287-delegation-stays-inside-one-repository.md)'s
  resolution, coded in `packages/fabrika-cli/src/delegate/resolve.ts`.
- The rule lives in `claude-plugins/fabrika/docs/interface-convention.md` §5, under
  *The scratch-copy exception*.

Vocabulary impact: names the **scratch copy**, the founder's word in the ruling, defined in §5 as a
git worktree an agent works in for one run. It is the tree an `isolation:worktree` spawn works in
([TERMS](../.glossary/TERMS.md)); no glossary row is added.
