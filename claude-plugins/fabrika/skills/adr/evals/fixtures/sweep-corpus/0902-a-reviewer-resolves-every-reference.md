---
id: 0902
title: A reviewer resolves every reference in the pull request under review
status: accepted
date: 2026-08-01
tags: [gates, review]
---

# 0902 — A reviewer resolves every reference in the pull request under review

**What this decides:** A reviewer follows each reference a pull request adds before approving it.

## Context
An unfollowed reference is a claim nobody checked.

## Decision
**A reviewer resolves every reference a pull request adds, and blocks the pull request on a dead one.**

## Consequences
Review costs one resolution per reference.
