---
id: 0315
title: fabrika-cli resolves its GitHub token from the environment first, and GraphQL is a two-item carve
status: accepted
date: 2026-08-20
tags: [fabrika-cli, github, http, credentials]
---

# 0315 — fabrika-cli resolves its GitHub token from the environment first, and GraphQL is a two-item carve

**What this decides:** the package's GitHub transport is a fetch client whose credential comes from
`GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token` only when `gh` is on `PATH`; an unresolvable
credential is a refusal naming both env vars, never an anonymous request. Every read is REST except
two named carves.

## Context

Every adapter in `packages/fabrika-cli/src/` reaches GitHub by spawning `gh api`. That makes the `gh`
binary a hard install requirement for a package published to npm, and it costs a process per request.
It also loses the response's structure: `httpStatusOf` (`src/io/issues.ts`) scrapes `(HTTP 404)` out
of a `gh` error string to tell absent from unreadable, and `pagedWithLinkProof`
(`src/ship/github.ts`) parses the `Link` header back out of `gh api -i`'s printed status block.

`packages/fabrika-cli/src/io/gh-api.ts` replaces the transport with `effect/unstable/http`, which was
already a live dependency of this package (`src/review-ui/upload-leg.ts`). The two disciplines the
`gh` adapters hold — read the status before the bytes, return a completeness proof beside every list
— carry over unchanged; only how the status and the `Link` header are reached gets simpler.

## Decision

### The credential resolves in one order, and the `gh` leg is not a fallback

`GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`.

**The env path is the contract.** It is what makes the package binary-free: CI, a container, and any
consumer who installed it from npm set an env var and nothing else. The published package must not
require a second tool to be installed for its verbs to work at all.

**The `gh auth token` leg is a developer-machine convenience, not a fallback on a request path.** It
resolves a credential once, before any request is issued, on a machine that is already logged in so
the operator does not have to mint a second token to run a verb locally. Nothing retries into it, and
no request path can reach it: `resolveToken` is the only producer of a token and every leg of the
client takes the token as an argument, so a caller who could not resolve one holds nothing to pass.
An anonymous request has no way to be constructed.

**`gh` absent from `PATH` and `gh` present but logged out are different facts that end on the same
refusal**, and the client keeps them apart in the read (a spawn fault versus a non-zero exit) even
though both mean "no credential here". The refusal names **both env vars** rather than telling the
reader to run `gh auth login`, because the reader is as likely to be in CI, where that instruction
sends them somewhere they cannot go.

### REST is the default; GraphQL is a carve with exactly two items on it

Issue and pull-request reads stay REST. This org's Projects-classic integration errors GraphQL issue
queries out — both `src/io/issues.ts` and `src/ship/github.ts` already say so at the top — so a
GraphQL issue query is not a style choice here, it is a broken read.

Two things carve out of that, and the list is closed:

1. **Review threads.** Thread resolution state, the reply mutation and the resolve mutation have no
   REST equivalent at all.
2. **The auto-merge mutation.** `enablePullRequestAutoMerge` is the GraphQL replacement for
   `gh pr merge --auto`, which is the last `gh` subcommand on the merge path.

Anything else reaching for GraphQL is a new decision, not an application of this one.

## Consequences

- `src/run.ts` merges `FetchHttpClient.layer` beside `NodeServices.layer`. `NodeServices` carries the
  spawner, filesystem, path, crypto, stdio and terminal, and no HTTP client — verified against
  `@effect/platform-node@4.0.0-beta.92`'s `NodeServices.ts`, which merges exactly those six.
- Unit tests script the `HttpClient` service (`fakeHttp` in `src/fakes.test-support.ts`), the same
  substituted-platform-layer move `fakeShell` makes for `ChildProcessSpawner`. The seam a test
  replaces stays the seam production runs on.
- `src/ui/pull-head.ts` is the tracer: one read, ported end to end, and its verb runs with `gh` absent
  from `PATH`. Every other adapter still spawns `gh` and every existing helper stays exported, so the
  two transports coexist until the remaining adapters are ported.
- The `gh` binary stops being a hard requirement for the ported reads and stays one for the rest.

## Amendment, 2026-08-20 — the argument-passed rule binds the client's own legs, not every adapter

Founder ruling on [#6704](https://github.com/kamp-us/phoenix/issues/6704), recorded at
[this comment](https://github.com/kamp-us/phoenix/issues/6704#issuecomment-5361592162): *"yeah, token
from env so that we can actually inject whatever token we want."*

**What changed.** The rule above reads "every leg of the client takes the token as an argument". Read
as binding every *adapter* signature too, it does not survive contact with the port. The six phase-2
adapters take `(repo, …)` and have nowhere to accept an `env`, and publishing
`HttpClient.HttpClient` up out of an `io/` adapter reds 45 verb modules that annotate themselves as
`Shell<…>` or `Effect<…, ChildProcessSpawner>`. Each of the six hit that wall separately and each
invented its own way round it.

**The amended rule.** The argument-passed credential binds `gh-api.ts`'s own legs and nothing else.
Inside that file a leg still takes `token` and cannot construct an anonymous request. Outside it,
`ambientToken` resolves the credential once per process off `process.env`, in the same order §"The
credential resolves in one order" rules, and memoises the answer — including a refusal, because the
env does not move mid-run and re-asking a logged-out `gh` per request is the subprocess cost this
port removes. The transport requirement is erased at the same boundary: `onTransport` reads the
caller's `HttpClient` through `Effect.serviceOption` and falls back to `FetchHttpClient.layer`.
Adapters keep their `(repo, …)` signatures and publish neither `HttpClient` nor an `env` parameter.

**The test seam is unchanged, and that is the load-bearing part.** `HttpClient.HttpClient` is a
`Context.Service`, not a defaulted `Context.Reference`, so `Effect.serviceOption` is
`Context.getOption` over the fiber's context and answers `None` only when nothing above provided one
(`effect@4.0.0-beta.92`, `src/internal/effect.ts`, `serviceOption`; `src/unstable/http/HttpClient.ts`
declares `HttpClient` via `Context.Service`). A provided `fakeHttp` therefore always wins, and the
fallback is reached only by a caller who provided nothing — which in the shipped CLI never happens,
since `src/run.ts` provides `FetchHttpClient.layer` at the root.

**The founder's reason, which is wider than this package.** One env var is what lets any context —
iOS, CI, a consumer repo — inject the token it wants. A credential threaded through 45 signatures is
a credential only this repo's call graph can supply.

**What did not change.** The resolution order, the refusal naming both env vars, the `gh auth token`
leg being a developer convenience rather than a request-path fallback, and the two-item GraphQL
carve all stand exactly as ruled above.

### The write leg, landed with this amendment

`gh-api.ts` gains the two calls the adapters cannot be ported without:

- `restCall(token, {method, path, body?, accept?})` — `GET | POST | PATCH | PUT | DELETE`, an
  optional JSON body **omitted entirely rather than sent as `null`**, and an optional `Accept`
  override for the diff and patch reads. `restRead` becomes its read arm.
- `pagedExistence(token, path)` — `pagedWithLinkProof`'s walk, answering `Existence` so a **404 stays
  a verdict about the issue** rather than collapsing into an empty list. That is the
  `404-IS-A-VERDICT` discipline `src/io/edges.ts` anchors: the dependency endpoints answer `200 []`
  for a real issue with no edges and `404` for an issue that does not exist, and fusing the two
  prints a proven negative over zero scope (ADR 0092).

## Amendment, 2026-08-21 — phases 2 and 3 landed: the coexistence ended, and the carve is three items

Recorded on the epic-tail review of [#6690](https://github.com/kamp-us/phoenix/pull/6690), which
red this record against the tree the same commit ships
([review-doc](https://github.com/kamp-us/phoenix/pull/6690#issuecomment-5363699640),
[governance](https://github.com/kamp-us/phoenix/pull/6690#issuecomment-5363634729)).

**The Consequences section above describes the phase-1 world, and it is retracted.** Two of its
bullets — "`src/ui/pull-head.ts` is the tracer … every other adapter still spawns `gh`" and "the `gh`
binary … stays one for the rest" — were true of the tracer commit and false of the epic. Every
adapter in the package is ported, the `gh`-shaped parser layer is deleted, and
`fabrika guard no-gh check` reds a second transport in CI. There is no `gh` prerequisite, which is
what [the package README](../packages/fabrika-cli/README.md) says one screen away.

**The carve has three items, not two.** `openPullsClosing` (`src/io/pulls.ts`) reads
`repository.issue.closedByPullRequestsReferences` through GraphQL, live in `lane brief`, `lane prove`
and `recipe unpark`. It is forced the same way the other two are: the closing-issue link edge — which
PR a `Fixes #N` binds — is published on no REST route at all. The alternative that was tried,
matching `search/issues` prose, parked a lane on a false match (#5805).

**And the ground the closed list rested on was wider than its fact.** "This org's Projects-classic
integration errors GraphQL issue queries out" reads as every GraphQL issue query. What breaks is the
GraphQL **search** connection over this org's issues; `repository(...){issue(number:)}` works, and
`openPullsClosing` has been running it since before this port. The rule the corpus should carry is
narrower: **issue search stays REST**, and a GraphQL read is a carve wherever REST publishes no
equivalent edge. Anything else reaching for GraphQL is still a new decision.

**Two adapter conventions shipped, and the amendment above names one.** "Adapters keep their
`(repo, …)` signatures and publish neither `HttpClient` nor an `env` parameter" describes
`io/edges.ts`, `io/issues.ts`, `io/pulls.ts`, `ship/github.ts` and `heal-ci/github.ts`.
`build/github.ts` does the opposite — `env` first, `HttpClient.HttpClient` published up into
thirteen verbs. **The ambient shape is the preferred one** and is what a new adapter takes;
`build/github.ts` is the outlier, [#6693](https://github.com/kamp-us/phoenix/issues/6693) tracks
normalising it. `ship/roster.ts` reaches the ambient `defaultBranch` in `ship/github.ts` rather than
`build/github.ts`'s for exactly this reason: it is called from `Shell<…>` sites that thread no `env`.

**The page cap is a real behaviour change and it is stated here rather than left to a reader.**
`gh api --paginate` had no cap; this transport walks at most `PAGE_CAP = 50` pages. So a list longer
than that is a state the old transport could not produce and this one can. Every list read in
`io/issues.ts` and both search reads therefore **refuse** a walk that reached the cap with a
`rel="next"` still outstanding, rather than answering the short list: eight of them seat proven
negatives (`openIssuesTitled`'s duplicate check, `issueTimeline`'s twin scan,
`openIssuesWithLabel`'s dedup sweep), and there a short list is a wrong answer, not a short one.
`EnvelopeRead` carries `exhausted` beside `declared` so the truncated state is representable at all —
without it a capped envelope walk is a plain `Ok`, and a caller that does not reconcile `declared`
reads it as the whole answer.
