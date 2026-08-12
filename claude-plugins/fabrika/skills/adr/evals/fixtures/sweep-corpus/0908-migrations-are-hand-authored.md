---
id: 0908
title: Database migrations are hand-authored and flat
status: accepted
date: 2026-08-01
tags: [platform]
---

# 0908 — Database migrations are hand-authored and flat

**What this decides:** Migrations are written by hand, numbered, and never regenerated.

## Context
A generated migration hides what it does to live data.

## Decision
**Migrations are hand-authored SQL in a flat numbered sequence.**

## Consequences
More typing, readable history.
