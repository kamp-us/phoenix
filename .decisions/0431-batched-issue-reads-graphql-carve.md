---
id: 0431
title: fabrika-cli reads a wave of table issues through batched GraphQL, the fifth carve from its REST default
status: accepted
date: 2026-09-28
tags: [fabrika-cli, github, graphql, betting-table, rate-limit]
---

# 0431 — fabrika-cli reads a wave of table issues through batched GraphQL, the fifth carve from its REST default

**What this decides:** the table readers in `packages/fabrika-cli` read many issues' state, parent,
sub-issues, blocked-by, blocking and comment count in one GraphQL request, and that is a fifth named
exception to the package's REST-by-default rule.

## Context

[ADR 0315](0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md) makes REST the
package's default and closes its GraphQL list: "anything else reaching for GraphQL is a new
decision". Its 2026-08-21 amendment narrowed the reason: what this org's Projects-classic integration
errors out is the GraphQL issue **search** connection, while `repository(...){issue(number:)}`
works. [ADR 0418](0418-projects-v2-is-a-graphql-carve.md) added Projects (v2) as the fourth carve and
bound every prose list of the carves to name four.

A whole-table `table flags` or `table prep` run read each issue over REST: the issue, its three edge
lists, its comments, and the issue again for the comment count. That is about six REST calls a row,
so 1,300 to 1,800 calls on phoenix's ~210-row table. It drained the account's 5,000-an-hour budget
to zero twice on 2026-09-27 and parked every other lane's verbs until reset
([#10097](https://github.com/kamp-us/phoenix/issues/10097)). REST publishes every one of those
edges, so this carve does not rest on a missing REST edge. It rests on cost: REST has no way to read
many issues' edges in one call, and GraphQL's aliased issue nodes do, on a budget REST does not
share.

A live aliased query against `kamp-us/phoenix` answered `subIssues`, `blockedBy`, `blocking` and
`comments.totalCount` on every issue node, and answered a pull request number and a missing number
with a per-alias `NOT_FOUND` error beside a `null` node.

## Decision

**The batched issue read in `src/io/issue-batch.ts` is a GraphQL carve, and issue search stays
REST.**

- The carve covers aliased `repository{iN: issue(number: N){…}}` nodes, at most 50 to a request,
  read for state, parent, sub-issues, blocked-by, blocking and the comment count, or for the comment
  count alone.
- It reaches GitHub only through `gh-api.ts`'s `graphqlRead`.
- Every connection carries its completeness proof: `totalCount` must equal the nodes received. An
  issue whose connection runs past one page, or whose node alone carries an error, is re-read over
  REST rather than handed on short. A request that fails as a whole reads every issue in it as
  unknown, and the reader refuses.
- A per-alias `NOT_FOUND` is the issue's absence, so a pull request number is still no table row.
- A comment list stays REST. Its count is read after the list, in one batched request per wave, so
  the count stays the later fact the
  [completeness proof](../.patterns/github-read-completeness-proofs.md) divides by.

**Binding constraints.**

- No other module reads issues through GraphQL on this carve's authority. A second batched reader
  is a new decision.
- Prose that lists the carves (`gh-api.ts`'s docblocks, the skill conventions' GraphQL exceptions)
  names five.

## Consequences

- 0315's list grows from four to five, and 0418's "names four" constraint now reads "names five".
  The rest of both stands: the credential order, REST as the default, issue search on REST, and the
  Projects (v2) carve.
- A whole-table read spends one REST call a row for the comment list, plus a GraphQL request per 50
  issues for the graph and another per 50 for the counts, drawn from GraphQL's separate budget.
- A GraphQL outage now refuses a table read that REST alone might have finished. That is the same
  fail-closed direction every table read already takes.

## Records

no vocabulary impact
