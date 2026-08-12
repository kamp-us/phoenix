---
id: 0901
title: A citation resolves against the fetched base ref, never the local working tree
status: accepted
date: 2026-08-01
tags: [decisions, gates]
---

# 0901 — A citation resolves against the fetched base ref, never the local working tree

**What this decides:** Every citation is resolved against a freshly fetched base ref.

## Context
A reader who resolves a reference against their own tree sees a citation the base ref does not carry.

## Decision
**Every citation resolves against the fetched base ref; a local working tree is never the authority.**

## Consequences
One fetch per resolution.
