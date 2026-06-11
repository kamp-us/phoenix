---
id: 0020
title: fate mutation conventions
status: accepted
date: 2026-05-23
tags: [fate, mutations, errors]
---

# 0020 — fate mutation conventions

## Context

The write path needs consistent conventions for naming, validation, response
shape, error codes, and list membership, now that mutations are entries on
`createFateServer({mutations})` rather than GraphQL fields.

## Decision

- Mutations are `{type, input?, resolve: fateMutation(...)}`, named
  **`entity.verb`** (`definition.add`, `post.submit`, `comment.delete`).
- **Validation stays in service methods** (per [0013](0013-validation-in-service-methods.md)).
  fate's `input` schema is thin shape-coercion only, not domain rules.
- After the write, the resolver **re-resolves the affected entity** through
  the source plan, so the response is masked exactly like a read. **Deletes
  return the re-resolved parent entity** so the client's normalized cache
  updates the surrounding list.
- Domain failures map to wire codes via `encodeFateError` (returns a
  `FateRequestError`, keyed on `Data.TaggedError._tag`), sharing
  `src/lib/mutationErrorCodes.ts` with the SPA.

## Consequences

- **Easier:** uniform write responses; one error-code contract across the
  wire; cache updates fall out of the returned entity.
- **Harder:** every mutation re-resolves the entity; the `_tag`→code table
  must be maintained as the protocol contract.
- See [fate-mutations.md](../.patterns/fate-mutations.md) and [fate-effect-interpreter.md](../.patterns/fate-effect-interpreter.md) (bridge doc retired, ADR 0042).
