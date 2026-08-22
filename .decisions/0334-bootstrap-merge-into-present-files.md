---
id: 0334
title: bootstrap merges into present files by key-merge or append-if-absent
status: accepted
date: 2026-08-22
tags: []
---

# 0334 — bootstrap merges into present files by key-merge or append-if-absent

**What this decides:** `status bootstrap` surfaces may merge into a file that already exists, through two safe arms, without ever touching bytes they do not own.

## Context

`buildFile` probes with `exists` and returns the `already` outcome before reading stdin, so a present file can never be emitted — and every file an adopting repo needs (`settings.json`, `package.json`, CLAUDE.md) already exists. The never-overwrite invariant is a governed guard with a stated incident: #4557. Relaxing it informally inside a code slice was the named rabbit-hole of epic #5979, so the qualification is ruled here first, by the founder (issue #7005, approved 2026-08-22).

## Decision

**A bootstrap surface that targets a present file merges into it through exactly one of two arms, refuses otherwise, and stays idempotent — a re-run over an adopted repo writes nothing.**

- **JSON key-merge arm.** Parse the present file as JSON, merge only the surface's declared keys, preserve unknown keys verbatim, write once. A target that fails to parse as JSON refuses without writing.
- **Append-if-absent arm.** A marker-delimited block appended once to a present text file when its marker heading is absent; byte-identical no-op when present.
- **Still refuses, both arms.** A target that fails to parse as its kind, and any target outside the repo root.
- **Arm per surface.** `settings-patch` and `dep-pin`'s manifest edit take the JSON arm; `claude-md-section` takes the append arm.
- **Idempotency is absolute.** No arm produces a second copy, a duplicate key, or any delta on a second run.

The guard's core survives: no surface ever replaces or deletes content it did not declare.

## Consequences

Adoption becomes verb-emitted end to end (#5979): bootstrap can produce the full consumer-file set in repos where all four files exist — which is every real repo. The cost is that `exists` stops meaning "untouched"; reviewers of bootstrap surfaces must now judge merge correctness (unknown-key preservation, marker matching), not just absence of writes.
