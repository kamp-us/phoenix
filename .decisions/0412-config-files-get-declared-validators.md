---
id: 0412
title: A config-only diff is validated by declared validators, not a fifth build check surface
status: accepted
date: 2026-09-27
tags: [fabrika, cli, build, validators, config]
---

# 0412 — A config-only diff is validated by declared validators, not a fifth build check surface

**What this decides:** a root config file such as `lefthook.yml` gets its `fabrika build check`
validation from commands the repo declares under a new `configValidators` key in `.fabrika.jsonc`.
That key uses the same grammar as `workflowValidators`.

## Context

`build check` has four surfaces: `code`, `prose`, `plan` and `workflows` (`SURFACES` in
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts)).
Root config files (`lefthook.yml`, `.fabrika.jsonc`, `biome.json` and the like) fall into none of
their classes. They land in `unvalidatable`, and a diff made only of such files refuses on exit 22:
"no surface validates any changed file". That refusal is deliberate.
[#5229](https://github.com/kamp-us/phoenix/issues/5229) made "unvalidated" a named refusal so that a
green can never mean "I could not tell".

The gap still costs every config-only lane. PR
[#6912](https://github.com/kamp-us/phoenix/pull/6912) (issue
[#6172](https://github.com/kamp-us/phoenix/issues/6172)) changed only `lefthook.yml`. The builder
ran `lefthook validate` by hand and spent a Deviations bullet disclosing the hole. That is noise in
the section reviewers read for real deviations, and a malformed config can still reach CI with no
local check.

The founder ruled **yes** on 2026-09-02:
https://github.com/kamp-us/phoenix/issues/6913#issuecomment-5519863564. A config-only diff gets its
validation from declared validators in `.fabrika.jsonc`, extending the `workflowValidators` shape.
The lens he set for the batch was to reduce process toil, pick the cheapest option, and add no new
gate or token unless a failure actually recurred. This record transcribes that ruling. Where the
ruling left a sub-choice of shape open, the sub-choice below is the cheapest option under that lens,
and the reason says so.

## Decision

**A config-only diff is validated by entries the repo declares under `configValidators` in
`.fabrika.jsonc`, and `build check` gains no fifth surface.**

- **A new key that reuses the grammar.** `configValidators` is a sibling of `workflowValidators`.
  Each entry is `{"command": [argv], "reads": [paths]}`, decoded by the same rules
  [`packages/fabrika-cli/src/config/keys/workflow-validators.ts`](../packages/fabrika-cli/src/config/keys/workflow-validators.ts)
  applies today. `workflowValidators` is not generalized. Its meaning in every adopting repo stays
  what it is, and `--surface workflows` keeps counting only workflow files as opened. A second key
  costs one registry row and changes nothing a repo already wrote.
- **`reads` stays a fixed list of exact paths, not globs.** A declared command reads a fixed set of
  files, which is why `reads` exists: it makes a green checkable per file. A glob would let an entry
  claim files the command never opens. Only one failure has recurred, and it names one file
  (`lefthook.yml`), so there is no need a glob grammar would answer.
- **The shipped default is the empty list.** fabrika installs into repos it does not control, and the
  command that validates a config file is that repo's own tool. This repository declares one entry:
  `lefthook validate`, reading `lefthook.yml`. That is the file behind the recurring failure. Other
  config files get entries when a lane actually hits them.
- **A file named in some entry's `reads` is no longer `unvalidatable`.** Every `build check` run
  whose diff touches such a file spawns the entries that read it, whatever `--surface` names. This
  follows how ADR [0381](0381-local-tree-guards-run-in-build-check.md) runs the local-tree guards on
  every surface. So a config-only diff can go green under the surface token the builder already
  names, and the builder learns no new token. A config file that no entry reads stays
  `unvalidatable` and still refuses.
- **The surface list gains no fifth member.** `SURFACES` in
  [`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts)
  stays `code | prose | plan | workflows` under this ruling.

### Rejected alternatives

- **A fifth hardcoded `config` surface.** This is the "no" half of the question the founder answered
  yes to. It adds a token every builder must learn and pick. The surface would still have to run
  something per file, and only the repo knows what that is, so it would end up needing a declared
  list anyway.
- **Widening the `code` surface's globs to take config files.** This is unsound. `pnpm typecheck`
  does not open `lefthook.yml`, and #5229's rule is that a class holds only while every validator its
  surface claims actually opens the file. A widened glob would green `lefthook.yml` under `code` on
  the strength of validators that never read it. That is the false green the named refusal exists to
  prevent.

## Consequences

A config-only lane goes green in its own tree once the implementation lands. It stops spending a
Deviations bullet on the gap, and a malformed `lefthook.yml` reds locally before CI. A repo that
declares nothing keeps today's exit-22 refusal. That is honest, and the fix is one config entry.

This ticket changes no behaviour in `packages/fabrika-cli/`. The implementation is
[#9875](https://github.com/kamp-us/phoenix/issues/9875).

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/6913
- Ruling: https://github.com/kamp-us/phoenix/issues/6913#issuecomment-5519863564
- Implementation: https://github.com/kamp-us/phoenix/issues/9875
- Precedent for surface-independent runs: ADR [0381](0381-local-tree-guards-run-in-build-check.md)
