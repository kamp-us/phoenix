---
id: 0103
title: A pull request that never merges leaves no record behind
status: accepted
date: 2026-08-01
tags: [decisions, pipeline]
---

# 0103 — A pull request that never merges leaves no record behind

**What this decides:** Only a merged pull request contributes a record to the repository.

## Context
Work that lives in an open pull request may be closed instead of merged.

## Decision
**A record counts as landed only once its pull request merges onto the base branch.**

## Consequences
An author waits for the merge before depending on it.
