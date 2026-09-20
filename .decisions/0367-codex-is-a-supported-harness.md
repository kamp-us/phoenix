---
id: 0367
title: Codex is a supported Fabrika harness
status: accepted
date: 2026-09-08
tags: [fabrika, harness, codex, packaging]
---

# 0367 — Codex is a supported Fabrika harness

**What this decides:** Fabrika supports Codex alongside Claude Code and pi through the shared plugin skills and a deterministic CLI dispatch adapter.

## Context

The founder requested a Codex plugin equivalent to Fabrika's Claude Code and pi integrations and authorized its complete pipeline delivery in [issue #8617](https://github.com/kamp-us/phoenix/issues/8617).

[ADR 0360](0360-retire-opencode-harness.md) requires a separate decision before admitting a third harness. This record supplies that decision and amends only its two-harness constraint. Its retirement of opencode, removal of executable pointers, and preservation of the neutral session override remain binding.

The questions settled here are: may Codex run Fabrika stages, and which component owns its stage isolation and completion proof?

## Decision

**Codex is a supported Fabrika harness alongside Claude Code and pi.**

The existing Fabrika plugin tree carries a Codex manifest pointing to the shared skills. The existing Fabrika CLI owns Codex lane dispatch; no additional published npm package is required.

The adapter creates and verifies a dedicated git worktree, preloads the required stage skills through a fixed prompt envelope, and preserves the emitted lane brief verbatim within that envelope. It runs Codex in that worktree and verifies a fresh task report and live artifact evidence after the child exits. Child output alone is not completion evidence.

**Binding constraints.**

- Codex admission does not restore opencode support or its retired distribution surfaces.
- Shared skills remain the stage contract; Codex plugin installation does not imply native registration of Fabrika agent roles.
- Dispatch preserves configured sandbox, approval, and model policy rather than overriding them. Operators must configure child policy explicitly when their parent session uses transient overrides.
- The neutral session override remains authoritative; Codex session identifiers are fallback identity sources.
- Claude Code and pi remain supported through their existing integrations.

## Consequences

Codex users can install the same skills and run isolated pipeline stages with deterministic completion checks. Fabrika must maintain the Codex adapter and its integration tests alongside the existing harness integrations. Failed or incomplete child runs retain their worktrees for inspection and repair.

## Records

no vocabulary impact
