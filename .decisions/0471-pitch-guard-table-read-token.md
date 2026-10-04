---
id: 0471
title: The pitch guard reads the table project with TABLE_READ_TOKEN when it is set, and no other read leaves the ruled credential order
status: accepted
date: 2026-10-04
tags: [fabrika-cli, github, credentials, pitch-guard, betting-table]
---

# 0471 — The pitch guard reads the table project with TABLE_READ_TOKEN when it is set, and no other read leaves the ruled credential order

**What this decides:** `fabrika guard pitch-guard check` may read the betting table's project with a
second token, taken from the `TABLE_READ_TOKEN` environment variable. Every other read in the
package still uses the one credential the ruled order resolves.

## Context

[ADR 0315](0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md) rules one
credential order (`GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`) and says "`resolveToken` is
the only producer of a token".
[ADR 0418](0418-projects-v2-is-a-graphql-carve.md) says the Projects (v2) client "adds no second
transport and no second credential path", and lists "the credential order" first among the parts of
0315 that stand.

The pitch guard needs two things that one token in CI does not give it.

- [ADR 0425](0425-a-bet-set-on-founder-say-so-approves.md) makes a `bet` on the table count as a pitch
  approval, so the guard has to read the table's project. The workflow's `github.token` cannot read
  a Projects (v2) project, so in CI a bet alone went red
  ([#9982](https://github.com/kamp-us/phoenix/issues/9982)).
- [ADR 0055](0055-acl-sourced-review-authz.md) roots approval in the repository ACL, so the
  guard has to read a commenter's permission. The read is fail-closed: a permission it cannot read
  counts as not authorized.

The founder ruled yes to a read-only token for the table project, stored as a repo secret:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/9982#issuecomment-5974150429). The
secret is `TABLE_READ_TOKEN`. [#10503](https://github.com/kamp-us/phoenix/pull/10503) handed it to
the guard as its one token. The run after that merge,
[37233815003](https://github.com/kamp-us/phoenix/actions/runs/37233815003), read the table and then
went red on a valid `pitch-approved:` comment: the table token could not read the commenter's
permission. So neither token can make every read, and the guard needs both.

The ruling says the table gets its own read-only token. It does not say in so many words that the
CLI may take a credential outside the ruled order. This record states that exception, as #9982's
acceptance criteria ask for it, and it lands in the pull request that carries the code, so the
control-plane owner who approves that pull request approves this record with it. Which token
plumbing the CLI uses is a platform choice
([ADR 0078](0078-product-driven-decisions-by-default.md)).

## Decision

**The pitch guard's table read may run under a token read from `TABLE_READ_TOKEN`, and that is the
only credential in the package that `resolveToken` does not produce.**

- `TABLE_READ_TOKEN` set and not blank: the guard finds the table's project and reads its items with
  that token. These are the two Projects (v2) reads in `readTable`
  (`packages/fabrika-cli/src/table/bets-read.ts`).
- Every other read in the guard stays on the ambient credential, in 0315's order: the issue, its
  comments, the permission of a commenter or a Stage setter, each head issue, and the issue graph
  behind a bet row.
- `TABLE_READ_TOKEN` unset, empty or blank: one token makes every read, as 0315 rules. An unset
  Actions secret arrives as an empty string, so empty must mean unset.
- A table token that is set and cannot read the table makes the table `unread`. An unread table
  approves nothing, and the comments decide. The guard does not retry the table under the ambient
  token.
- The table token still goes through `gh-api.ts`'s `graphqlRead`. This adds no transport, and the
  rule that a leg takes its token as an argument is unchanged.

This amends 0315's "`resolveToken` is the only producer of a token" and 0418's "no second credential
path" for this one read. The resolution order, the refusal that names both env vars, and the
GraphQL carves all stand.

**Binding constraints.**

- No other verb, guard or workflow reads `TABLE_READ_TOKEN`. A second reader is a new decision.
- The table token never reads repository data. A permission read under it would fail every comment
  approval closed, which is the regression this record answers.
- No other environment variable supplies a credential. A third source is a new decision.
- The guard never falls back from a failing table token to the ambient one for the table read.

## Consequences

- `.github/workflows/pitch-guard.yml` passes two variables to the one step:
  `GH_TOKEN: ${{ github.token }}` and `TABLE_READ_TOKEN: ${{ secrets.TABLE_READ_TOKEN }}`.
- An adopter whose ambient token already carries the `project` scope sets nothing and sees no
  change. This covers every developer machine that 0418's `gh auth refresh -h github.com -s project`
  covers.
- The repo owns one more secret to rotate. It needs project read and nothing else.
- 0315's reason for one env var, that any context can inject the token it wants, now takes two
  variables for this one guard in a context whose main token cannot read the project.
- Prose that calls `resolveToken` the one producer names this exception.
  `packages/fabrika-cli/src/io/gh-api.ts`'s header does.

## Records

no vocabulary impact
