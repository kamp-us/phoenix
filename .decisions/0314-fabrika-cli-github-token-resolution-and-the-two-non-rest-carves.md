---
id: 0314
title: fabrika-cli resolves its GitHub token from the environment first, and GraphQL is a two-item carve
status: accepted
date: 2026-08-20
tags: [fabrika-cli, github, http, credentials]
---

# 0314 — fabrika-cli resolves its GitHub token from the environment first, and GraphQL is a two-item carve

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
