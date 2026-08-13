---
id: 0107
title: Every push runs the whole test suite
status: accepted
date: 2026-08-01
tags: [platform]
---

# 0107 — Every push runs the whole test suite

**What this decides:** Continuous integration runs everything, every time.

## Context
A partial run hides the failure it did not cover.

## Decision
**Every push runs the whole suite; no subset selection.**

## Consequences
Slower runs, no hidden gaps.
