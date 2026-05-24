---
id: 0022
title: Server types are the single source of truth; fate codegen replaces relay-compiler
status: accepted
date: 2026-05-23
tags: [fate, codegen, types, build]
---

# 0022 — Server types are the single source of truth; fate codegen replaces relay-compiler

## Context

The Relay toolchain has several moving parts kept in sync by hand: a committed
`schema.graphql` (refreshed via `schema:fetch` against the running worker),
`relay-compiler`, the `@swc/plugin-relay` transform, and a generated
`src/__generated__/` directory.

## Decision

The server's exported `Entity<>` types plus the fate manifest are the single
source of truth for types. fate's codegen (`fate generate` / its Vite plugin)
reads them and emits the `react-fate/client` module; the client imports the
server's `Entity<>` types **type-only**. There is no SDL artifact, no schema
fetch step, and no `relay-compiler`/`@swc/plugin-relay` in the build.

## Consequences

- **Easier:** one type contract, nothing to keep in sync, no committed schema
  file drifting from the code.
- **Cost:** remove the Relay toolchain and committed `schema.graphql`; wire
  fate codegen into the client build.
- See `.patterns/fate-server-wiring.md` and `fate-client-setup.md`.
