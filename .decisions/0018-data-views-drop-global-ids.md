---
id: 0018
title: Data views are the schema; drop global IDs and the Node interface
status: accepted
date: 2026-05-23
tags: [fate, schema, modeling]
---

# 0018 — Data views are the schema; drop global IDs and the Node interface

## Context

The GraphQL schema used hand-written object types, a `Node` interface, and
base64 global IDs (`encodeNodeId`, `${Type}:${id}`) because Relay required
globally-unique identifiers. fate's native protocol carries the `type` on
every operation, so global IDs are unnecessary.

## Decision

Each entity is a `dataView<Row>("Type")({...})`; the exported `Entity<>` types
are the shared contract. Modeling rules:

- **IDs are raw per-type values.** The protocol carries `(type, id)`, so there
  is no global-id encoding, no `Node` interface, and no `node(id)` dispatch.
- **Connections are `list(view)`**, not `Connection`/`Edge`/`PageInfo` types.
- **Heterogeneous feeds use a discriminant field**, not a union (fate has no
  union type).
- **Enum-style args are plain validated strings.**
- **Selection masking is the field-level authorization surface** — a client
  cannot read a field the view didn't declare; `authorize` returns `null`.

## Consequences

- **Easier:** far fewer types, no SDL, simpler ids, masking as the auth gate.
- **Cost:** drop `encodeNodeId` from the wire (relocate it only if some store
  needs internal disambiguation); remodel the profile contributions feed with
  a discriminant instead of a union.
- See [fate-data-views.md](../.patterns/fate-data-views.md).
