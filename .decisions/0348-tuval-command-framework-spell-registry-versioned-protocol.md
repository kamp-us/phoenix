---
id: 0348
title: The Tuval command framework is a spell registry on Effect Schema with one versioned protocol
status: accepted
date: 2026-09-03
tags: [tuval, commands, protocol, effect-schema]
---

# 0348 — The Tuval command framework is a spell registry on Effect Schema with one versioned protocol

**What this decides:** every command in Tuval is a *spell*, a schema-typed record in one registry
built from config; the page and the kernel talk over one named, versioned protocol of four Effect
Schema messages; and the palette, the key bindings and an AI agent's tools all run the same spells
through the same registry.

## Context

Tuval is being rebuilt under `apps/tuval` (ADR [0345](0345-tuval-lives-under-apps.md)) against the
program/process contract of epic [#7496](https://github.com/kamp-us/phoenix/issues/7496). The kernel
landed with programs, processes, ports and a registry, and no way to *ask it for anything*. The
shell's command line ([#7555](https://github.com/kamp-us/phoenix/issues/7555)) and the AI agents'
tools ([#7620](https://github.com/kamp-us/phoenix/issues/7620)) were both about to grow their own
dispatch, which would have meant two catalogues of what Tuval can do, drifting from each other from
the first week.

Grilling [#7617](https://github.com/kamp-us/phoenix/issues/7617) worked that fog down over four
rounds on 2026-09-03 and the founder ruled on all thirteen questions. The session graduated into
epic [#7627](https://github.com/kamp-us/phoenix/issues/7627), whose children built the framework:
the registry (#7636), the protocol (#7637), the executor and scope (#7638), the parser and
completion (#7639), the key bindings (#7640), the discovery spells (#7641), and the process spells
and bridge (#7642). Three more children sit outside that list: the palette (#7643, re-sequenced off
this epic's tail), this record and its companion pattern doc (#7644), and the proof (#7645). This
ADR is written after the seven code children landed, so every claim below is the code's, not the
plan's.

### Prior art, read and not imported

Two of the founder's own projects supplied the shape, and neither is a dependency. Nothing is
imported or copied from either; both are cited by repository and path.

- **`@usirin/spellbook`** (`usirin/monorepo`, `packages/spellbook/src/spellbook.ts`) supplied the
  spell shape: an addressable command with a path, a description, a parameter schema, a result
  schema and an execute function. Its schemas are Standard Schema and its `execute` returns a
  Promise. The rewrite here is on Effect Schema with an Effect `execute`, so a spell's failures and
  service requirements ride its own type and there is only one validation stack in the app.
- **wormhole** (`usirin/wormhole`, `packages/wormhole/src/Protocol.ts`) supplied the protocol shape:
  one `Schema.Class` per message, one union per direction, a decode that refuses rather than
  coercing. Its binary framing and channels are deliberately left behind; see the fifth ruling
  below.

## Decision

### The thirteen rulings

Each row is a question from [#7617](https://github.com/kamp-us/phoenix/issues/7617), the founder's
answer, and where the code that implements it lives. The full ruling comments are on that issue.

| Ruling | What was decided | Where it landed |
|---|---|---|
| **R1.1** | A spell is `{path, describe, params, result, execute, capabilities}`, the `@usirin/spellbook` shape rewritten on Effect Schema. Founder: "yes, next question" | [`commands/spell.ts`](../apps/tuval/src/commands/spell.ts) |
| **R1.2** | Programs declare their spells at registration time, on the program row, swapped whole on config reload; never invented at runtime from inside a process. Founder: "Okay, this also makes things easy to type I guess" | `spells` on [`registry/program.ts`](../apps/tuval/src/registry/program.ts); `buildRegistry` and `swap` in [`commands/registry.ts`](../apps/tuval/src/commands/registry.ts) |
| **R1.3** | A spell call is the only page-to-kernel message, so windows, keys and the command line all speak one wire; all desk state lives in the kernel and a tab keeps only tab-ephemeral state. Founder: "I love it" | `SpellCall` and `PageToKernel` in [`protocol/messages.ts`](../apps/tuval/src/protocol/messages.ts) |
| **R1.4** | A key binding is a `{path, args}` record compiled once at config load, not a command string parsed at keypress. Recovery is per binding: valid ones load, each bad one is dropped and reported with its position, and only an unimportable file or a top-level schema error keeps the last good config. Founder: "Yeah, I like this, but we gotta make sure that like we err with good error messages" | [`commands/bindings/compile.ts`](../apps/tuval/src/commands/bindings/compile.ts), [`commands/bindings/errors.ts`](../apps/tuval/src/commands/bindings/errors.ts) |
| **R1.5** | Completion uses exact prefix on the names the system defines (spell path segments, program ids, enum literals) and fuzzy ranking on the values a user named (window, process and workspace ids and names), both synchronous against the snapshot the page already holds. Founder: "Oof, I love this UX man" | [`commands/parse/complete.ts`](../apps/tuval/src/commands/parse/complete.ts) |
| **R1.6** | A spell carries a `capabilities` field, declared now and enforced by nothing in this epic. Founder: "yes, next question" | `capabilities` in [`commands/spell.ts`](../apps/tuval/src/commands/spell.ts), mirrored on the wire in [`protocol/registry-description.ts`](../apps/tuval/src/protocol/registry-description.ts) |
| **R2.1** | `help` is a spell, rendered from every spell's own `describe`, and the palette's inline description is the same string. There is no hand-written help table anywhere. Founder: "i fucking love it dude" | [`commands/core/help.ts`](../apps/tuval/src/commands/core/help.ts), pinned by `no-handwritten-help.unit.test.ts` |
| **R2.2** | A spell runs with a typed `Scope` (`{window?, process?, workspace, client}`) the kernel resolves from the call's `window`. The page never names a process. Founder: "yes, next question" | [`commands/scope.ts`](../apps/tuval/src/commands/scope.ts), applied in [`commands/executor.ts`](../apps/tuval/src/commands/executor.ts) |
| **R2.3** | The palette is a floating layer over the desk, `:` opens, Esc closes and restores focus, Enter runs, the last error renders inline under the input. Founder: "awesome" | not built; [#7643](https://github.com/kamp-us/phoenix/issues/7643) owns it, corrected below |
| **R2.4** | The AI agents' generic tools become the spells `process spawn` / `process send` / `process read`, and the SDK tool is a thin bridge over the same registry; `spell list` and `spell describe` let an agent discover it. Founder: "Yeah, next" | [`commands/core/process.ts`](../apps/tuval/src/commands/core/process.ts), [`commands/core/spell.ts`](../apps/tuval/src/commands/core/spell.ts), [`commands/bridge/SpellBridge.ts`](../apps/tuval/src/commands/bridge/SpellBridge.ts) |
| **R3.1** | The page-kernel wire is named **the Tuval protocol**: one module, four versioned Effect Schema messages (`SpellCall`, `SpellReply`, `Snapshot`, `Patch`), one union per direction, with the registry riding in the snapshot so the palette completes offline. Founder: "awesome" | [`protocol/messages.ts`](../apps/tuval/src/protocol/messages.ts), [`protocol/codec.ts`](../apps/tuval/src/protocol/codec.ts) |
| **R4.1** | The command framework epic sequences before the shell's command-line child (#7555) and the agent-tools child (#7620), so both build on the registry rather than their own dispatch. The kernel does not wait. Founder: "yes" | epic #7627 ordering |
| **R4.2** | The first epic's scope is exactly: registry, incremental parser, completion engine, protocol module, palette UI, `help`, `spell list`, `spell describe`. Out: capability enforcement, scripting and macros, and re-cutting the already-planned shell children. Founder: "yes" | see "What is left out" below |

### The palette correction, 2026-09-03

R2.3 said the palette floats over the *focused window*. The founder corrected that in a walk the
same day, recorded on [#7643](https://github.com/kamp-us/phoenix/issues/7643): a window "might just
change or might be really small", and the palette should work "similar to how neovim, tmux, vscode
works". Ruled: **the palette is one desk-level overlay at the top center of the whole app, fixed
width, never anchored to a window's box.** The focused window supplies scope only, so a spell run
from the palette still targets the focused window because scope comes from focus, not from where the
palette sits.

Everything else in R2.3 stands: focus trapped, Esc restores focus, a listbox with
`aria-activedescendant`, prefix on paths and fuzzy on live values, synchronous against the local
snapshot. The palette also waits on `packages/design`
([#7561](https://github.com/kamp-us/phoenix/issues/7561)) rather than shipping on plain components
and migrating later, and a second 2026-09-03 ruling took it off this epic's tail: it lands as its
own PR against main once three things are true, that #7556 and #7561 have closed and that the epic
PR [#7687](https://github.com/kamp-us/phoenix/pull/7687) has merged.

### The palette matching correction, 2026-09-05

R1.5 and the correction above both read as one rule over both surfaces: exact prefix on the paths the
system defines. Built that way, the palette narrowed only on the segment under the caret, so `zoom`
answered "No spell matches what you have typed" while `window zoom` sat in the unfiltered list — a
reader who remembers the verb and not the group could reach nothing
([#8002](https://github.com/kamp-us/phoenix/issues/8002)).

Put to the founder as one question — does the listbox loosen while Tab stays exact-prefix? — and
ruled 2026-09-05, "yes to both"
([the ruling comment](https://github.com/kamp-us/phoenix/issues/8002#issuecomment-5554612396)).

**R1.5's exact-prefix rule is scoped to completion, not to finding.** `candidatesFor` — Tab, the `:`
line — stays exactly as R1.5 says. The palette's listbox ranks in three tiers: exact prefix on the
next segment first, then a substring of the rest of the path, then a substring of the spell's
`describe` sentence. Accepting any of them types the whole remaining path, so the parser reads what
the palette listed. The value half of R1.5 is untouched: a window id or a workspace name still ranks
fuzzily on recency.

The argument behind R1.5's rule 1 survives the scoping. "A system name is something to recall, not
something to search" is about what a *completion* offers to type next, where a loose offer types a
word the reader did not mean. A palette is the surface where recall has already failed.

### The tail review rulings, 2026-09-03

The tail review of the epic PR ([#7687](https://github.com/kamp-us/phoenix/pull/7687)) found two
places where the code had diverged from a ruling, and the founder ruled on both the same day
(recorded on [#7627](https://github.com/kamp-us/phoenix/issues/7627)):

- **R1.5 stands, and the snapshot carries recency.** The ruling breaks fuzzy ties by recency, and
  the protocol had no recency field, so the code was breaking ties by collection order. Ruled "A":
  add the field rather than amend the ruling. Every `Window` and `ProcessRow` carries a
  kernel-minted `Recency`, a monotonic counter (not a clock: the kernel holds no clock, already
  counts a `Revision`, and a counter is deterministic under test) advanced on focus and on spawn
  ([`protocol/recency.ts`](../apps/tuval/src/protocol/recency.ts)). The completion engine breaks a
  fuzzy tie most-recent-first, and its test pins the ruling against fixtures ordered the other way.
- **R3.1 stands, and `SpellReply` is flat.** The builder had nested the outcome as
  `{version, id, outcome: {ok, ...}}` to keep `ok` and `result` from disagreeing. Ruled
  "flatten": `SpellReply` is `Schema.Union([SpellReplyOk, SpellReplyError])`, that is
  `{version, id, ok: true, result}` or `{version, id, ok: false, error}`, and the union itself
  keeps the invariant.

### What the framework is, as built

The shapes are documented as reference in
[`.patterns/tuval-spells.md`](../.patterns/tuval-spells.md). The load-bearing consequences of the
rulings above:

- **One registry, one description, one help text.** `describeSpell` renders a spell's parameters as
  JSON Schema, and that same `SpellDescription` feeds `help`, `spell list`, `spell describe` and the
  parser's index today, and the palette's inline text when the palette is built. A spell's sentence
  is written once, at its `defineSpell` site.
- **The page and the kernel parse identically.** The parser's index is built from the protocol's
  `RegistryDescription`, which is exactly what a `Snapshot` carries, so a page running this parser
  cannot accept a line the kernel would reject.
- **The kernel decides scope.** The wire lets a page name a window and nothing else. A spell that
  legitimately targets another process takes that id as a parameter of its own `params` and is
  answerable for it. That parameter is precisely what a capability check will guard later.
- **A bad key binding costs its own key.** Per-binding recovery, and every error names the module,
  the key, the character offset, what was expected and the nearest thing the author may have meant.
  The module name is layer-relative, never a machine-local absolute path.

## What is left out, and who owns it later

Named here so nobody reads the framework as more than it is.

- **Capability enforcement.** `capabilities` on a spell and `CapabilityRequest` on a program row are
  inert data: stored, described, and checked by nothing. Local program code is fully trusted and
  there is no sandbox (#7484 R1.1, the Neovim model). Until enforcement exists, the only thing
  between a calling program and the registry is the bridge's allowlist. `SpellBridge.layer({allow})`
  takes that list from whoever builds the layer, and no program row supplies it yet: `src/boot.ts`
  allows the whole registry (`everyPath` over the table as it stands at boot) and the bridge's own
  unit test passes its own list. Because the layer captures the list at build, a config reload
  leaves it behind while the registry moves on —
  [#7743](https://github.com/kamp-us/phoenix/issues/7743) is filed on that. Wiring the list to the
  calling program's registry row is the intent recorded in the module's docblock and is a later
  child's work, and enforcement proper is a later epic's. This ADR designs neither.
- **Scripting and macros.** No way to compose spells into a script, bind a sequence, or record one.
  R4.2 puts it out of the first epic and no child was cut for it.
- **Binary channels on the protocol.** JSON text is the whole wire. wormhole needed framing and
  channels because it carries raw terminal bytes; Tuval carries spell calls and desk state, which
  are structured values, and a second framing layer would buy nothing but a second thing to version.
  A program that streams raw bytes is what reopens this, and it will be its own ADR.
- **The palette itself.** #7643, off this epic's tail: it lands after #7556 and #7561 close and
  after epic PR #7687 merges.
- **The shell's `:` line and the agents' SDK tools.** #7555 and #7620 adopt the registry as they are
  built. R4.2 says nothing already planned is re-planned for this framework.

## Consequences

- A new command is a `defineSpell` and a row in a program's `spells`. It is reachable from `help`,
  `spell list`, a compiled key binding and the bridge the moment it is registered, and from the
  palette when the palette is built, with no second catalogue to update.
- The protocol is a versioned contract from its first commit. `PROTOCOL_VERSION` is `1`, every
  message carries it, and a page and kernel from different builds refuse each other by decode rather
  than by behaviour. Changing a message's shape means bumping it.
- The registry is a pure function of config. `:help` is complete before any process runs, and a
  reload swaps every program's spells in one write.
- A spell whose meaning depends on process state takes a process id as an argument rather than
  inventing itself at runtime. That is the cost of R1.2 and it was accepted with it.
- The parser's reading of a JSON-Schema `params` depends on three properties of
  `Schema.toJsonSchemaDocument` at the `catalogs.tuval` pin (effect `4.0.0-rc.112`): `properties`
  key order is `Schema.Struct` declaration order, and a `Schema.Literals` parameter renders as
  `{"type": "string", "enum": [...]}`, and a `Schema.Class` or identifier-annotated struct renders
  its root as a `$ref` into the document's `definitions`, which the parser follows once before
  reading properties. All three are read off that source and pinned by the parser's tests. An
  Effect bump has to re-check them.
