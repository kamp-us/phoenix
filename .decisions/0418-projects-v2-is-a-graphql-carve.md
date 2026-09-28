---
id: 0418
title: fabrika-cli reaches GitHub Projects (v2) through GraphQL, the fourth carve from its REST default
status: amended-in-part by [0431](0431-batched-issue-reads-graphql-carve.md)
date: 2026-09-27
tags: [fabrika-cli, github, graphql, betting-table]
---

# 0418 — fabrika-cli reaches GitHub Projects (v2) through GraphQL, the fourth carve from its REST default

**What this decides:** the betting table's Projects (v2) client in `packages/fabrika-cli` talks to
GitHub through GraphQL, and that is a fourth named exception to the package's REST-by-default rule.

## Context

[ADR 0315](0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md) makes REST the
package's default and names a closed list of GraphQL carves: review threads, the auto-merge mutation
and, since its 2026-08-21 amendment, the closing-issue link. Its words are that "anything else
reaching for GraphQL is a new decision".

The betting table (epic [#9850](https://github.com/kamp-us/phoenix/issues/9850)) keeps its state in
a GitHub Projects (v2) project. The founder ruled that in
[#9821 R4.1](https://github.com/kamp-us/phoenix/issues/9821#issuecomment-5850673082), ruled
[here](https://github.com/kamp-us/phoenix/issues/9821#issuecomment-5850679567), and the ruled
round names the trade-off in so many words: "fabrika reads it through GraphQL, and each adopter's
token needs the `project` scope." The first client (`src/io/projects.ts`, built for
[#9854](https://github.com/kamp-us/phoenix/issues/9854)) widened the list to four without a record,
and governance failed that range for it.

The first draft of that client said Projects (v2) "has no REST surface". That is false today.
GitHub's published OpenAPI description (`github/rest-api-description`,
`descriptions/api.github.com/api.github.com.json`) lists REST operations for listing and reading
projects, listing and adding fields, listing, adding, updating and deleting items, and creating a
view. A live `GET /orgs/kamp-us/projectsV2/20/fields` answers 200. REST publishes no operation to
create a project, link one to a repository, list a repository's linked projects, set a project's
README, list or update views, post a status update, or read who last set each field value.

## Decision

**The Projects (v2) client is a GraphQL carve, by the founder's R4.1 ruling, and nothing else in
the package widens with it.**

- The carve covers `src/io/projects.ts`: the table's project, its owner and repository links, its
  fields and iteration, its views, its items and their field values, and its status updates.
- It reaches GitHub only through `gh-api.ts`'s `graphqlRead`, so it adds no second transport and no
  second credential path.
- Issue and pull-request reads stay REST, and issue search stays REST, exactly as 0315 rules.
- The carve rests on the ruling, not on an absence of REST. REST now publishes part of this domain,
  and R4.1 did not weigh that. Whether the REST-published edges move to REST is an open question
  for the founder, filed as [#9952](https://github.com/kamp-us/phoenix/issues/9952). Until it is
  answered, this record does not claim REST is absent.

**Binding constraints.**

- No other module reaches Projects (v2) through GraphQL. A second Projects client is a new decision.
- Prose that lists the carves (`gh-api.ts`'s docblocks, the skill conventions' GraphQL exceptions)
  names four and must not say Projects (v2) has no REST surface.

## Consequences

- 0315's list grows from three to four. The rest of 0315 stands: the credential order, the refusal,
  REST as the default, and issue search on REST.
- Every adopter's token needs the `project` scope for the `table` verbs, and `table setup` refuses
  without it, naming `gh auth refresh -h github.com -s project`. Other verbs are unaffected.
- If #9952 moves some edges to REST, this carve narrows by amendment. Nothing here needs undoing
  first.

## Records

no vocabulary impact
