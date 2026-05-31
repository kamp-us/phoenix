---
id: 0038
title: Dependency patches are local-only
status: accepted
date: 2026-05-31
tags: [dependencies, build, conventions]
---

# 0038 — Dependency patches are local-only

## Context

The alchemy cutover surfaced cases where a dependency needs a fix that isn't
yet released — e.g. the alchemy `InferEnv`/`Platform` typing work. The tempting
shortcuts are to point the dependency at a fork branch, a git URL, or an
unmerged upstream PR and move on. Each of those makes phoenix's build depend on
state that lives **outside this repo** and outside our control: the remote can
force-push, the PR can be rebased or rejected, the branch can disappear. When
that happens the build breaks for reasons invisible in the repo, and there's no
record of what the patch even did.

## Decision

phoenix never depends on a dependency patch sourced from outside the repo — not
a fork branch, not a git dependency, not an unmerged upstream PR.

Order of preference when a dependency is wrong:

1. **Fix it properly with no patch** — type the seam, follow the dependency's
   intended API, or work around it in our own code.
2. **If a patch is genuinely unavoidable: a local `pnpm patch`** committed to
   this repo.
3. **Never** an external/remote patch source (fork branch, git dependency,
   unmerged upstream PR) as the thing the build resolves against.

## Consequences

- Patch files live in-repo and are reviewable in the diff; anyone can see
  exactly what was changed and why.
- The build is reproducible from a clean checkout with no external state —
  no dependency on a remote branch staying put.
- A `pnpm patch` is a visible, intentional cost. It shows up in review and
  invites the question "can we upstream and drop this?" rather than hiding as
  an invisible fork dependency.
- Upstreaming a fix is still encouraged — but the merged release, not the
  in-flight PR, is what phoenix depends on. Until then we carry a local patch.
