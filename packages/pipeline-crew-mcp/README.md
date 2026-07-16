# @kampus/pipeline-crew-mcp

The crew's channels-backed messaging substrate — the peer-to-peer transport the pipeline
crew (EM, triage, coder, reviewer, shipper) talk over, exposed to each agent as MCP
channels (epic #3045).

## What it is

A small, layered substrate split into a **generic core** and one **crew-coupled** module:

- **`src/protocol/`** — the wire format: message envelopes and the codec every peer shares.
- **`src/tracker/`** — the rendezvous registry where peers announce and discover each other.
- **`src/peer/`** — a p2p participant: dials, holds connections, relays messages over the protocol.
- **`src/edge/`** — the MCP channel edge: exposes the substrate to an MCP client as channels.
- **`src/crew/`** — the only crew-coupled module: the Role catalog and the wiring that binds
  the generic substrate to concrete crew roles.

**The load-bearing boundary:** `protocol/`, `tracker/`, `peer/`, and `edge/` are the reusable
channels substrate and never import `crew/`; `crew/` depends inward on the generic core, never
the reverse. That one-way dependency is what keeps the substrate reusable beyond the crew — it
is the reason the modules are split into directories rather than a flat file.

## Why it exists

The crew is a set of independent agent sessions that today coordinate through out-of-band
surfaces (filed issues, tmux relays). This package gives them a first-class, in-process
messaging substrate — a generic p2p tracker + peers underneath, an MCP channel edge on top —
so an agent joins a channel and sends/receives crew messages through its MCP client rather than
a bespoke relay. It is internal pipeline tooling, on no kamp.us user surface.

## Status

Scaffold only (issue #3052): the package shape, the module skeleton, and a thin Effect bin.
No seam behavior is wired yet — each module is filled by its own child of epic #3045.

## Usage

Built on Effect + `effect/unstable/cli`, run from source with Node's TypeScript loader (the
pipeline-tooling idiom, mirroring `@kampus/pipeline-cli`):

```bash
pnpm --filter @kampus/pipeline-crew-mcp cli        # run the (scaffold-only) root command
pnpm --filter @kampus/pipeline-crew-mcp typecheck  # tsgo typecheck
pnpm --filter @kampus/pipeline-crew-mcp test       # @effect/vitest suite
```
