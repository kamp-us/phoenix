---
id: 0035
title: CLI conventions — small focused tools, name mirrors bin
status: accepted
date: 2026-05-31
tags: [cli, tooling, monorepo, conventions]
---

# 0035 — CLI conventions: small focused tools, name mirrors bin

## Context

phoenix needs repo tooling. Some repeatable operations are currently brittle
when done by hand — the motivating case is SQL migrations for the DOs/D1, where
hand-written migration files are error-prone and "look ugly." The monorepo is
the natural place to build these tools.

The wrong shape is one catch-all `cli` package that accumulates every verb. A
bare `cli` is too vague — you can't tell what it does from its name, and it
becomes the same kind of graveyard ADR 0036 rejects for `features/shared/`.
ADR 0036 already assumes a `phoenix-fate new <feature>` scaffolder exists and
cites this ADR as the place that shape is decided.

This is that ADR (the 0035 slot ADR 0036 references).

## Decision

phoenix builds **small, focused, single-purpose CLIs** in the monorepo — never
one mega `cli`.

- **Each CLI has a specific, descriptive name.** `phoenix-fate` for the fate
  scaffolder/codegen (`phoenix-fate new <feature>`, future verbs); a dedicated
  migration CLI for DO/D1 SQL migrations; etc. A bare `cli` name is banned —
  the name says what the tool is for.
- **A package's name mirrors its bin name.** The npm package name equals the
  executable name, so bin and package are discoverable from each other and
  there's no translation step between "what I run" and "what I depend on."
- **CLIs own repeatable repo operations that are brittle by hand** — migrations
  first. If an operation is worth automating, it gets a focused tool, not a
  README step.

## Consequences

- Each tool is its own named package + bin. More packages, but each is small
  and its purpose is legible from its name.
- No mega-CLI: a new operation either extends the relevant focused CLI with a
  new verb (e.g. another `phoenix-fate` subcommand) or becomes its own named
  tool when it's a distinct concern. It never lands in a catch-all `cli`.
- The convention is predictable enough for scaffolding to assume — ADR 0036's
  `phoenix-fate new <feature>` can generate the standard per-feature footprint
  because the CLI shape is fixed here.
- Hand-written, brittle migration files are on the way out, replaced by a
  migration CLI (separate future work; this ADR fixes the naming/shape it must
  follow).
