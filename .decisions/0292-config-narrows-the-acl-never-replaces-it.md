---
id: 0292
title: A `.fabrika.jsonc` authority set narrows the live repo ACL, it never replaces one
status: accepted
date: 2026-08-18
tags: [fabrika, config, security, pipeline, plugin-portability]
---

# 0292 — A `.fabrika.jsonc` authority set narrows the live repo ACL, it never replaces one

**What this decides:** when a fabrika verb reads *who* may do a privileged thing out of the repo's
`.fabrika.jsonc`, that configured set is a narrowing on top of a live `write+` ACL read, never a
source of authority on its own. The first instance is `capClearAuthors`, the set that may clear a
repair round (#5959).

## Context

ADR [0055](0055-acl-sourced-review-authz.md) supersedes 0051 because a checked-in identity
list is "instructions, not enforcement": the same actor it constrains can edit it. ADRs 0063, 0071,
0140, 0213 and 0253 each restate it — a committed file has no author gate.

ADR [0286](0286-standing-lanes-come-from-config.md) then moved a different repo-specific set out of
CLI source and into `.fabrika.jsonc`, on the founder's rule that "everything we use today can be
default config but it should be configurable". #5959's ruling extends that to the cap-clear set
verbatim: *"'founder' concept can change repo by repo, let's make it a configuration? it can be an
array of github usernames and github teams"*.

Those two records pull in opposite directions if `capClearAuthors` is read as *the* authority. As
first written it was: `build clear` resolved the invoking login and tested only membership of the
configured set, and the honour-read judged a landed `cap-cleared` marker under the same one test. A
login in the file with no collaboration on the repo could clear a round, and on a stacked PR the
config is read at a base ref its own author controls. That is `AUTHORIZED_REVIEWERS` under a new
key, guarding a different privilege — exactly the shape 0055 forbids.

The sibling verb both modules cite as the shape being copied does not have that hole:
`grill rule` resolves `permissionFor` and refuses anything below `write`
([`packages/fabrika-cli/src/grill/rule-verb.ts`](../packages/fabrika-cli/src/grill/rule-verb.ts)).

The two records are only in tension over what the file *is*. 0286 rules where a repo-specific set is
written down. 0055 rules where authority comes from. Read that way both hold at once, and the
resolution is an intersection rather than a choice.

## Decision

**A `.fabrika.jsonc` authority set is a narrowing predicate over a live ACL read, and both clauses
are conjunctive.**

1. The account must be named by the configured set, resolved at the PR's base ref so a PR cannot
   widen the set that governs it (#981).
2. The account must hold `admin`, `maintain` or `write` at GitHub's collaborator ACL, read live at
   the moment of the act — the same `write+` floor 0055 fixed and every other fabrika verb applies.

Neither clause substitutes for the other. Widening the file grants nothing to an account with no
collaboration; holding `write+` grants nothing to an account the repo did not name. A configured set
can therefore only ever be *more* restrictive than the ACL, which is what makes it safe to keep it in
a committed file at all.

A permission read that fails is UNKNOWN — the verb refuses, and the honour-read holds the whole fold
UNKNOWN rather than resolving to "nobody granted".

This does not amend 0055; it states how a config key coexists with it. Any future
`.fabrika.jsonc` key naming *who may act* inherits this rule without a new ADR.

## Consequences

- `build clear` reads the invoking login's permission after the config clause and refuses on `25`
  below the write floor; the honour-read in
  [`packages/fabrika-cli/src/build/clearances.ts`](../packages/fabrika-cli/src/build/clearances.ts)
  applies the same clause per marker author, so the set that may post a grant and the set whose
  grant counts stay one set.
- The stacked-PR path is closed by clause 2 rather than by trusting the base ref: an author who lands
  their own login on a branch they control still resolves to whatever the ACL says they are.
- Config keys that name *values* rather than *actors* (0286's `lanes`) are untouched — this rule
  binds authority keys only.
