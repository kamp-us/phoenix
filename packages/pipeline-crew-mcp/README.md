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
  epic handoff, drain tally, intake ping, discovery/presence), the wiring that composes
  tracker + peer + edge into a per-role channel server (enforcing the role-uniqueness lease
  the generic peer does not), and — the cutover (#3062) — the **runnable stdio session entry**
  (`crew/session.ts`): one live session's stdio `McpServer` + `ChannelSend`-from-peer, driving
  both channel edges (outbound `channel_send` tool, inbound inbox→channel wake) off one server.

**The load-bearing boundary:** `protocol/`, `tracker/`, `peer/`, and `edge/` are the reusable
channels substrate and never import `crew/`; `crew/` depends inward on the generic core, never
the reverse. That one-way dependency is what keeps the substrate reusable beyond the crew — it
is the reason the modules are split into directories rather than a flat file.

## Why it exists

The crew is a set of independent agent sessions that previously coordinated through out-of-band
surfaces — filed issues plus a tmux relay convention (buffer-paste + staggered-submit, pane-title
discovery, capture-pane identity verification). This package gives them a first-class, in-process
messaging substrate — a generic p2p tracker + peers underneath, an MCP channel edge on top — so an
agent joins a channel and sends/receives crew messages through its MCP client rather than a bespoke
relay. It is internal pipeline tooling, on no kamp.us user surface. tmux is retained only as session
host / stand-up topology; the seams no longer ride it.

## Status

The generic substrate (`protocol`/`tracker`/`peer`/`edge`), the `crew/` composition root (Role enum
+ catalog + wiring), and the **cutover** (#3062) are landed: `crew/session.ts` binds the runnable
stdio session entry, and the root barrel (`src/index.ts`) exposes the whole substrate onto the
`crew/` composition. Every inter-session seam (claim/collision-check, planned-epic handoff, drain
tally, intake pings, role discovery/presence, the role-uniqueness lease) routes over the channels
protocol. Out of v1: the EA→operator human-notification channel (deferred) and removing tmux as
session host.

## Usage

Built on Effect + `effect/unstable/cli`, run from source with Node's TypeScript loader (the
pipeline-tooling idiom, mirroring `@kampus/pipeline-cli`):

```bash
# run one live crew session (stdio MCP server + channel peer) for a standing role
pnpm --filter @kampus/pipeline-crew-mcp cli session --role engineering-manager
pnpm --filter @kampus/pipeline-crew-mcp typecheck  # tsgo typecheck
pnpm --filter @kampus/pipeline-crew-mcp test       # @effect/vitest suite
```

The `--role` is one of the five standing `CREW_ROLES` (`ea-chief-of-staff`, `engineering-manager`,
`triage-guy`, `junior-engineer`, `cartographer`); the session joins the per-project tracker under
`--project-root` (default: cwd) and runs until interrupted.
