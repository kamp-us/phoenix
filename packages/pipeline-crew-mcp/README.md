# @kampus/pipeline-crew-mcp

The crew's channels-backed messaging substrate — the peer-to-peer transport the pipeline
crew talk over, exposed to each agent as MCP channels (epic #3045). The crew is a flat
topology of four standing roles (`chief-of-staff`, `cartographer`, `intake-desk`,
`engineering-manager`), coordinating over a generic p2p tracker + peers with an
MCP channel edge on top, so an agent joins a channel and sends/receives crew messages through
its MCP client instead of an out-of-band tmux relay. Internal pipeline tooling, on no kamp.us
user surface.

This README is the **front door**: what the package is, why it exists, and an index into the
[`docs/`](./docs/) tree. For anything deeper, follow the index — the docs are the source of
truth for how to learn, operate, look up, and reason about the substrate.

## Documentation

The package docs are structured by [Diátaxis](https://diataxis.fr/) — one comprehension mode
per file:

| Doc | Mode | For |
|---|---|---|
| [Tutorial](./docs/tutorial.md) | learning | Bring up two peers, send a message, claim a resource — the end-to-end round-trip. |
| [How-to](./docs/how-to.md) | tasks | Add a message kind, wire a tracker semantic, debug an offline peer, run stand-up under CI. |
| [Reference](./docs/reference.md) | information | The message-kind catalog, tracker claim/lease semantics, the CLI surface, error types. |
| [Explanation](./docs/explanation.md) | understanding | The coordination model — stigmergic claim map, pull-not-push, two-keyspace design (→ ADR 0191). |

> **Surface separation (load-bearing).** This is the **package** substrate's docs home; its
> index links **only** into this package's own `docs/` tree. The `pipeline-crew` **plugin** —
> the crew itself (roles, roster law, §CP flow, personalization) — is a separate surface with
> its own docs beside its agent defs. The two never cross-link: a reader asking "how do I add a
> role" (plugin) must never land in "how does the claim map work" (package), and vice-versa.

## What it is

A small, layered substrate split into a **generic core** and one **crew-coupled** module:

- **`src/protocol/`** — the wire format: message envelopes and the codec every peer shares.
- **`src/tracker/`** — the rendezvous registry where peers announce and discover each other,
  and the two-keyspace claim/lease store (presence leases keyed by peer, resource claims keyed
  by resource — ADR 0191).
- **`src/peer/`** — a p2p participant: dials, holds connections, relays messages over the protocol.
- **`src/edge/`** — the MCP channel edge: exposes the substrate to an MCP client as channels.
- **`src/crew/`** — the only crew-coupled module and the composition root: the Role enum (the
  four-role flat topology), the seam catalog (each role's crew interactions mapped over
  `protocol/`), the wiring that composes tracker + peer + edge into a per-role channel server
  (enforcing the role-uniqueness lease the generic peer does not, ADR 0189), and the runnable
  stdio session entry (`crew/session.ts`).
- **`src/standup/`** — the launch-time orchestration that stands the whole crew up from the
  operator config, and the single-member `spawn-role` / `retire-role` ops.

**The load-bearing boundary:** `protocol/`, `tracker/`, `peer/`, and `edge/` are the reusable
channels substrate and never import `crew/`; `crew/` depends inward on the generic core, never
the reverse. That one-way dependency is what keeps the substrate reusable beyond the crew.

## Why it exists

The crew is a set of independent agent sessions that previously coordinated through out-of-band
surfaces — filed issues plus a tmux relay convention. This package gives them a first-class,
in-process messaging substrate so an agent joins a channel and sends/receives crew messages
through its MCP client rather than a bespoke relay. tmux is retained only as session host /
stand-up topology; the seams no longer ride it. The design rationale — stigmergic coordination
through the shared claim map, claim-liveness riding presence, the two-keyspace split — is in the
[Explanation](./docs/explanation.md), which points to ADR 0191.

## Usage

Built on Effect + `effect/unstable/cli`, run from source with Node's TypeScript loader (the
pipeline-tooling idiom, mirroring `@kampus/pipeline-cli`):

```bash
# run one live crew session (stdio MCP server + channel peer) for a standing role
pnpm --filter @kampus/pipeline-crew-mcp cli session --role engineering-manager
pnpm --filter @kampus/pipeline-crew-mcp typecheck  # tsgo typecheck
pnpm --filter @kampus/pipeline-crew-mcp test       # @effect/vitest suite
```

The `--role` is one of the four standing `CREW_ROLES` (`chief-of-staff`, `cartographer`,
`intake-desk`, `engineering-manager`); the session joins the per-project tracker under
`--project-root` (default: cwd) and runs until interrupted. See the [Tutorial](./docs/tutorial.md)
for the first-run walkthrough and the [Reference](./docs/reference.md) for the full CLI surface.
