---
id: 0240
title: An ADR may cite only an ADR that has landed on the base ref
status: proposed
date: 2026-08-01
tags: [decisions, gates, pipeline]
---

# 0240 — An ADR may cite only an ADR that has landed on the base ref

**What this decides:** When one ADR references another, the referenced ADR has to already be merged
on the base branch. Citing an ADR that only exists inside somebody's open pull request is not
allowed, because that pull request may never merge and the citation would point at nothing.

## Context

A citation to an unmerged ADR reads exactly like a citation to a merged one. Nothing in the file
records which it is, so every downstream reader inherits the author's assumption that the target
exists. When the target's pull request is later closed instead of merged, the citation survives as a
pointer to a decision the repository never made.

The failure is invisible at review time: the reviewer resolves the reference against whatever tree
they happen to hold, and a tree that already contains the target — the author's own branch, say —
makes a dead citation look live.

## Decision

**An ADR cites only ADRs that are present on the base ref at the time the citing ADR's pull request
opens; an ADR that exists solely in an open pull request may not be cited.**

An author who needs to reference an in-flight decision has two options and no third: wait for it to
land, or restate the constraint in their own ADR without the citation. The relationship can be
recorded after the fact as a dated amendment note once the target lands.

**Binding constraints.**
- Every ADR reference resolves against the fetched base ref, never the local working tree.
- A reference that resolves to an open pull request blocks the citing ADR's pull request.

## Consequences

Authors of paired ADRs must sequence them, which costs a round trip when two decisions are drafted
together. In exchange, a reference in a merged ADR is a reference a reader can follow.
