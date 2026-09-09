---
id: 0366
title: Tuval hosts Pi on its own hand-written server on 0.85.x, never `@earendil-works/pi-server`
status: accepted
date: 2026-09-08
tags: [tuval, pi, dependencies, architecture]
---

# 0366 — Tuval hosts Pi on its own hand-written server on 0.85.x, never `@earendil-works/pi-server`

**What this decides:** Tuval moves its pinned `@earendil-works/pi-*` packages from 0.84.3 to 0.85.x
and keeps writing the Pi host itself, instead of adopting the `pi-server` package that release
publishes.

## Context

Tuval's desk talks to a Pi coding agent over a loopback socket whose two ends Tuval both owns. The
host side is hand-written in `apps/tuval/src/pi/server` against
`@earendil-works/pi-protocol@0.84.3`: its own envelope framing, its own version-1 handshake, its own
command dispatch table, and a projection that writes a whole session snapshot every time the session
handle signals a change.

That pin costs the desk operator three things. His desk pins a CPU core for the length of a
streaming turn, because 0.84.3 validates each snapshot on both ends of a socket that lives inside
one process — ADR [0364](0364-pi-protocol-compiled-validators-patch.md) measures that cost and
carries the local patch that bought it back. His Pi rows cannot spawn subagents, because
`pi-subagents` mismatches the 0.84.x `pi-ai` API. And the desk speaks protocol version 1 while the
Pi tooling he runs in his own terminal has moved to version 8.

The founder ruled the upgrade on 2026-09-07 (Pacific), verbatim: **"yes, upgrade the pi server and
keep our server."** The ruling is recorded at
https://github.com/kamp-us/phoenix/issues/8551#issuecomment-5578115848, and
https://github.com/kamp-us/phoenix/issues/8518 is the epic that carries the upgrade.

The second half of that ruling needed evidence rather than preference, because 0.85.1 publishes
`@earendil-works/pi-server` and 0.84.3 did not — so "keep our server" is now a choice against
something that exists. A spike recorded on that epic on 2026-09-07 stood up a real two-process rig:
a host process running `createUnixServer` from `@earendil-works/pi-server/unix` over a real
`pi-coding-agent` `AgentSession`, and a separate client process dialling it with `pi-client`'s
`Client.connect`. It walked twelve requirement rows against that rig on the faux provider with
model network access off, so it spent no model tokens, and its findings are what the decision below
rests on.

## Decision

**Tuval upgrades the Pi family to 0.85.x and keeps its own hand-written host; `pi-server` is not
adopted.**

### Why `pi-server` is not adopted

`pi-server@0.85.1` is a socket router, not a host. It ships transport, framing, handshake,
attachment routing and route fencing, and nothing else; every payload it carries is opaque to it and
it decodes no business call. Four findings decide it:

- **The host slot is the application's.** `pi-server`'s `ServerHost` contract is three
  application-owned members — `serverServices`, `resolveSession`, `openSession` — so the session
  vocabulary, the transcript projection and every service contract stay Tuval's to write either way.
  Ten of the spike's twelve requirement rows came back `adapter`, meaning code Tuval writes whether
  or not it adopts the package.
- **There is no permission service.** No permission symbol exists anywhere in the 0.85.x family —
  not in `pi-server`, `pi-client`, `pi-protocol`, `chord` or `pi-agent-core`. The nearest kin are
  `before_tool` hooks and a project trust store. This is the same hole 0.84.3 has, so adopting the
  package closes none of it.
- **`ClientHello` carries no credential.** In protocol 8 the client's opening message is
  `{type, version}`. There is no credential field, so Tuval's per-launch loopback token has no place
  in the handshake, and `pi-server` ships a unix-socket listener only, with no TCP or loopback
  listener at all.
- **The coding agent never opens that socket.** `pi-coding-agent@0.85.1` lists `pi-server`,
  `pi-client` and `pi-protocol` as devDependencies only, and its sole non-TUI mode is `--mode rpc`,
  which is line-delimited JSON over stdio — a different protocol. There is therefore no
  already-running Pi server to dial, and adopting `pi-server` would mean standing up a process
  Tuval hosts anyway.

### What the upgrade does subtract

Keeping the host is not keeping the code. The 0.84.3 envelope framing, the version-1 handshake, the
command dispatch table and the full-snapshot projection all go: protocol 8 replaces the framing and
the handshake, and `@earendil-works/chord`'s replicated state replaces the snapshot projection with
incremental operations. What survives the port is the domain layer — the session directory and
session listing, the transcript projection, prompt and interrupt, model and thinking level, the
ownership table, and every refusal.

The payoff is measured, not assumed. The spike round-tripped a 300-item snapshot (150 tool calls,
about 175 KiB on the wire) through the 0.85.1 codec in **5.71 ms**, against the **5218 ms** the
0.84.3 schema costs for the same message — about **914x**. The cause is that every 0.85.1 payload is
`Type.Unsafe(Type.Unknown())`, so the validator never walks a transcript; its cost is flat at about
6.9 µs regardless of message size. That is why ADR
[0364](0364-pi-protocol-compiled-validators-patch.md)'s compiled-validator patch retires with this
upgrade rather than being re-cut against 0.85.x: on this wire it would buy roughly 0.1 ms.

### The pin rule

**The `@earendil-works` Pi family is nine entries, and all nine move in one commit.** ADR 0364
counts eight; 0.85.1's `pi-protocol` and `pi-client` both take `@earendil-works/chord` as a runtime
dependency that 0.84.3 does not carry, which is the ninth.

- Four sit in the workspace `catalog:` block: `pi-ai`, `pi-client`, `pi-coding-agent`,
  `pi-protocol`.
- Four sit in `overrides:` as parent-scoped entries: `pi-agent-core`, `pi-ai`, `pi-telemetry`,
  `pi-tui`.
- `@earendil-works/chord` joins them.

**`overrides:` is re-keyed with the catalog, never left behind.** The cataloged packages ask for
their siblings by caret, and a caret picks the highest published patch, so leaving a `0.84.3`-keyed
override in place while the catalog moves does not fail — it puts a second copy of the same package
in the tree beside the pinned one and builds green. That already happened once on this family:
`0.84.4` landed a second `@earendil-works/pi-ai`, the faux provider registered itself into one copy
and the agent loop read the other. A duplicate reached by a caret is a correctness hazard rather
than weight, and the only thing that prevents it is moving both blocks together.

### The security question this leaves open

**The per-launch loopback token cannot ride protocol 8, and this ADR does not say what replaces
it.** The two candidates are rebuilding the token behind a custom `ServerListener`, or dropping it
in favour of a short-path unix socket at mode `0600`. They are not equivalent: the spike found that
`pi-server`'s own socket discovery locates a live socket by scanning the directory, and that an
unrelated process of the same user connected to it carrying no secret, so `0600` does not separate
two processes belonging to one user. Choosing between them is a security judgement, not a port, and
it is tracked at https://github.com/kamp-us/phoenix/issues/8562. The protocol-8 host must not land
before that question is answered.

**Binding constraints.**

- Never adopt `@earendil-works/pi-server` as Tuval's host without a new founder ruling that
  supersedes this one.
- Move all nine Pi pin entries in one commit, `catalog:` and `overrides:` together, on every future
  bump of this family.
- Delete ADR 0364's patch, its `patchedDependencies` entry and its `@patch-pin` behavior test as
  part of the 0.85.x upgrade, and never re-cut that patch against 0.85.x.
- Answer https://github.com/kamp-us/phoenix/issues/8562 before the protocol-8 host ships; do not
  let the loopback token lapse silently as a side effect of the handshake changing.

## Consequences

Tuval keeps owning both ends of its socket, which is what makes the vocabulary problem tractable:
`pi-protocol@0.85.1` no longer exports the session, transcript, model and command types that 38
import sites under `apps/tuval/src` are written against, and because Tuval writes the client too,
those types can move into the app and travel as an opaque payload inside a protocol-8 envelope.
The host's contract with its client stays Tuval's to define, at the cost of Tuval maintaining it.

The `apps/tuval` wire layer is rewritten rather than adjusted, which is the real price of this
decision. Adopting `pi-server` would have deleted the framing and the handshake for us; keeping our
own host means porting them. The spike's answer is that the ten adapter rows dominate that saving.

The permission gap does not close. Tuval's auth policy stays Tuval's, on 0.85.x exactly as on
0.84.3, because the dependency family ships nothing to hand it to.

This ADR supersedes ADR [0364](0364-pi-protocol-compiled-validators-patch.md), whose own binding
constraints already say its patch retires with this upgrade. It does not touch ADR
[0345](0345-tuval-lives-under-apps.md), which places Tuval as a local app under `apps/`, or ADR
[0348](0348-tuval-command-framework-spell-registry-versioned-protocol.md), which governs Tuval's
command framework rather than its Pi transport.

## Records

No vocabulary impact. The Pi wire vocabulary that moves into `apps/tuval` with this upgrade is a
relocation of names `@earendil-works/pi-protocol` already carried, not a coinage, and those names
are technical English inside one app rather than product nouns, so `.glossary/LANGUAGE.md` is
unchanged.
