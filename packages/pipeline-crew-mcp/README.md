# @kampus/pipeline-crew-mcp

The crew's channels-backed messaging substrate — the peer-to-peer transport the pipeline
crew talk over, exposed to each agent as MCP channels (epic #3045). The crew is a flat
topology of five standing roles: `ea-chief-of-staff`, `engineering-manager`, `triage-guy`,
`junior-engineer`, `cartographer` (the canonical agent-type slugs).

## What it is

A small, layered substrate split into a **generic core** and one **crew-coupled** module:

- **`src/protocol/`** — the wire format: message envelopes and the codec every peer shares.
- **`src/tracker/`** — the rendezvous registry where peers announce and discover each other.
- **`src/peer/`** — a p2p participant: dials, holds connections, relays messages over the protocol.
- **`src/edge/`** — the MCP channel edge: exposes the substrate to an MCP client as channels.
- **`src/crew/`** — the only crew-coupled module and the composition root: the Role enum
  (the five-role flat topology, a single swap-in roster seam), the seam catalog (each role's
  crew interactions mapped over `protocol/` — claim/collision-check, role-uniqueness lease,
  epic handoff, drain tally, intake ping, discovery/presence), and the wiring that composes
  tracker + peer + edge into a per-role channel server (enforcing the role-uniqueness lease
  the generic peer does not).

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

The generic substrate (`protocol`/`tracker`/`peer`/`edge`) and the `crew/` composition root
(Role enum + catalog + wiring) are landed. The runnable stdio entry that binds a live crew
session's MCP server to the composition — and the retirement of the tmux relay convention —
is the cutover (#3062), sequenced after this. The `bin` remains scaffold-only until then.

## Usage

Built on Effect + `effect/unstable/cli`, run from source with Node's TypeScript loader (the
pipeline-tooling idiom, mirroring `@kampus/pipeline-cli`):

```bash
pnpm --filter @kampus/pipeline-crew-mcp cli        # run the (scaffold-only) root command
pnpm --filter @kampus/pipeline-crew-mcp typecheck  # tsgo typecheck
pnpm --filter @kampus/pipeline-crew-mcp test       # @effect/vitest suite
```
