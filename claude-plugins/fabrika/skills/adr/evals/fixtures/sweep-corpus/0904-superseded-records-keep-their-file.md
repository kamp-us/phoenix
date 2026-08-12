---
id: 0904
title: A superseded record keeps its file and gains a status line
status: accepted
date: 2026-08-01
tags: [decisions]
---

# 0904 — A superseded record keeps its file and gains a status line

**What this decides:** Superseding a record edits its status line and deletes nothing.

## Context
A deleted record breaks every pointer into it.

## Decision
**A superseded record keeps its file; the supersession is recorded on the status line alone.**

## Consequences
The directory grows monotonically.
