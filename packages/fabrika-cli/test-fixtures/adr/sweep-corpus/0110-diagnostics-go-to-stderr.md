---
id: 0110
title: Diagnostics go to stderr, answers to stdout
status: accepted
date: 2026-08-01
tags: [platform]
---

# 0110 — Diagnostics go to stderr, answers to stdout

**What this decides:** Only the answer lands on stdout.

## Context
Progress chatter mixed into the answer breaks every caller that parses it.

## Decision
**Stdout carries the answer; progress, warnings and scope lines go to stderr.**

## Consequences
Callers parse stdout with no filtering.
