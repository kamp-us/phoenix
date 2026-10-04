---
id: 0466
title: A .fabrika.jsonc key lets ship scope run from the main working tree, never a command-line flag
status: accepted
date: 2026-10-04
tags: [fabrika, cli, pipeline, ship, config, worktree]
---

# 0466 — A .fabrika.jsonc key lets ship scope run from the main working tree, never a command-line flag

**What this decides:** a repo that keeps one checkout, or ships by hand, turns on one config key
and `fabrika ship scope` then runs from the repo's main folder. Every other repo keeps the refusal.

## Context

`fabrika ship scope` refuses on exit `33` when it runs in the repository's main working tree. The
refusal protects a driver: a shipper that reads from the driver's checkout lets another seat move
that checkout's branch mid-drive, which changes which build of the verbs the driver runs.

That reason holds for a repo that drives lanes from linked worktrees. It does not hold for a person
shipping by hand, or for a repo with a one-checkout rule, and neither had a way through.
[#10034](https://github.com/kamp-us/phoenix/issues/10034) reports what happened in an adopter repo:
two shippers read the refusal as "the chain cannot run" and merged with a raw REST call, which
skipped every guard. A third skipped `scope` and ran the rest. The sibling ship verbs (`gate`,
`checks`, `floor`, `threads`, `merge`) never carried the refusal.

Triage put two options to the founder: add an override, or keep the refusal and only reword it to
name the `git worktree add` step. The founder ruled on #10034 on 2026-10-03, verbatim
([ruling comment](https://github.com/kamp-us/phoenix/issues/10034#issuecomment-5974043005)):

> yeah, let's activate this behind a flag inside fabrika config file

That picks the override, and places it in `.fabrika.jsonc` rather than on the command line.

## Decision

**`.fabrika.jsonc` carries a key that lets `ship scope` run from the main working tree, and a repo
that does not declare it keeps the exit `33` refusal.**

The ruling settles three things:

1. `ship scope` may run from the main working tree.
2. The switch is a value in the fabrika config file.
3. It is "behind a flag", so it is off until a repo turns it on.

The ruling names no key and no values. This record's build chose them, and they are the builder's
proposal rather than the founder's words:

- The key is `shipScope`, an object with one field, `mainWorkingTree`.
- The values are `refuse` and `allow`. The shipped default is `refuse`.
- `"shipScope": {"mainWorkingTree": "allow"}` lifts the refusal. The verb then reads the pull request
  and prints one notice on stderr naming the file that allowed it.
- The exit `33` message names that declaration, so a reader who hits the refusal sees the way
  through.
- A value that does not decode, or a config file that cannot be read, refuses on exit `11`. It never
  falls to `refuse`, which would hide a declaration the repo believes it made, and never to `allow`.
- The key is read from the checkout the verb stands in, and only after git proves that checkout is
  the main working tree. A run in a linked worktree never opens it.
- The key is not machine-local. ADR [0398](0398-machine-local-config-layer.md) bars a local layer
  over any key that weakens a gate, and this key lifts a refusal.

**Binding constraints.**

- No command-line flag and no environment variable lifts the refusal. The ruling placed the switch
  in the config file.
- The shipped default stays `refuse`. Changing it is a new ruling.
- `recipe unpark`'s in-process read stays exempt as before. This key does not touch it.

## Consequences

- A one-checkout repo ships through the full guard chain after a one-line config edit, instead of
  merging around it.
- A repo that turns the key on gives up the protection the refusal carried. A shipper there can
  stand in a checkout whose branch another seat moves. That trade is the repo's to make, in a tracked
  file a reviewer sees.
- The guide-side half of the report, telling an adopter that a code PR needs an issue before work
  starts, stays on [#10051](https://github.com/kamp-us/phoenix/issues/10051).
- Option 2's rewording, naming `git worktree add` in the refusal, was not ruled and is not built
  here.
