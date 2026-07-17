# pipeline-crew

The **pipeline-crew** plugin is the sole definition of the kamp.us crew: **four
channel-native agent defs on a flat topology** that *conduct* the
[`kampus-pipeline`](../kampus-pipeline/) skills as a standing operation. The defs address
each other over a channel substrate (the in-repo `@kampus/pipeline-crew-mcp`), not a hand-run terminal relay, and the plugin ships the crew **doctrine as its default** — the rules that keep an
agent factory honest are baked in, and only genuinely per-install values ride the
personalization seam.

The roster is governed by the crew roster law
([ADR 0189](../../.decisions/0189-crew-roster-law-bridges-engines.md)): **three bridges + an
engine pool.** A *bridge* owns a unique seam connecting the factory to something outside it,
so it is singleton (cardinality 1); an *engine* owns no seam and is fungible throughput, so
it scales by count (cardinality N). Read that law once — it is why the crew is shaped the way
it is, and it holds every future roster change to the same test.

This README is the **front door for a second operator**: everything below lets you stand up
the same crew *alone*, with your own people and machine, without copying anyone else's
personal config. Every operator-specific value enters through the
[personalization seam](PERSONALIZATION.md); the shipped content carries **zero** operator data.

## What the crew is — four roles, flat topology

```
                              ┌───────────────┐
                              │  the founder  │
                              └───────────────┘
                       fog in  ▲             ▲  awareness out
                               │             │
                    ┌──────────┴───┐   ┌─────┴──────────┐
                    │ cartographer │   │ chief-of-staff │   (bridges,
                    │   (bridge)   │   │    (bridge)    │    cardinality 1)
                    └──────┬───────┘   └───────┬────────┘
             IntakePing    │                   │    IntakePing
                           ▼                   ▼
                    ┌───────────────────────────────┐
                    │          intake-desk          │  (bridge)
                    │  world's observations → work  │
                    └───────────────┬───────────────┘
                                    │
                         the board (status:triaged)
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │     engineering-manager  ×N    │  (engine pool,
                    │   pulls the board, builds it   │   cardinality N)
                    └───────────────────────────────┘
```

The four roles, each owning one accountability:

- **cartographer — the inbound-ideation bridge**
  ([`agents/cartographer.md`](agents/cartographer.md)). Turns the founder's *fog* — a fuzzy,
  not-yet-decided destination — into charted work by running the `wayfinder` skill (the
  `wayfinder:map` / `wayfinder:backlog` label contract). It sits one stage upstream of triage
  and never auto-resolves a founder decision — it surfaces the fork on the map and stops.
- **intake-desk — the intake bridge** ([`agents/intake-desk.md`](agents/intake-desk.md)).
  Turns the world's raw observations into typed, prioritized work *and talks back to whoever
  filed* (the talking-back is what makes it a bridge, not a filter). Runs the report → triage
  loop and owns the planning/canon seam (spawns the `planner` / `canon` / `adr` agents). A
  *desk* is a standing seat staffed by whoever is on shift (renamed from `triage-guy`, which
  named a person, not a seat).
- **engineering-manager — the execution engine**
  ([`agents/engineering-manager.md`](agents/engineering-manager.md)). Pure throughput,
  cardinality N: pulls ready work off the board, claims each resource against the tracker to
  deconflict, and drives coder → reviewer → shipper to a *landed* merge under bounded WIP
  caps. It owns **no** human-facing seam — it banks §CP PRs on the board, never pings a human.
- **chief-of-staff — the outbound-awareness bridge**
  ([`agents/chief-of-staff.md`](agents/chief-of-staff.md)). Turns factory state into the
  founder's understanding and owns human-facing comms to **both** humans (the founder and the
  §CP approver). Its charter is the **live verifier**: verify, never relay — a relayed claim
  is never truth, a self-reported PASS is not truth until the artifact is read, an enqueue is
  never a merge. It is a conversation *peer, not a switchboard*, and *conversing is not
  evidence* (renamed from `exec-assistant`; the router identity is deleted, the verifier
  charter is the value).

The topology is **flat**: the substrate makes peers dial each other directly, so no role
routes for another. The old three-session hub-and-spoke — where the human seam routed
execution work to the engineering-manager — is **dead** (ADR 0189): a planned child becomes
pickable on the board and an engine pulls it; the engine banks a §CP PR on the board and the
chief-of-staff carries it out.

### The comms graph is sparse — the silence is the design

Every channel edge is a **latency optimization over the board**, never a work order: the
board is the durable source of truth, and a channel message just wakes a peer sooner. So the
graph is deliberately sparse — most coordination is *silent by design*, carried by the board.
Addressing is the one idiom **`channel_send {targetRole, kind, body}`** (below); the live
edges are:

| From | To | Kind | Why |
|---|---|---|---|
| cartographer | intake-desk | `IntakePing` | charted work reached the board; nudge a triage pass |
| engineering-manager | intake-desk | `IntakePing` | a follow-up/blocker was filed; nudge a triage pass |
| chief-of-staff | intake-desk | `IntakePing` | the needs-triage queue is worth a pass |
| engineering-manager | chief-of-staff | `DrainProgress` (`inFlight`) | how many lanes are in flight — the one crew fact the board structurally cannot express |

Everything else is **silent by design** — and the silences are load-bearing, not omissions:

- **cartographer → engine** and **chief-of-staff → engine** — the deleted hub-and-spoke
  spine. A direct edge would route *around* triage and hand an engine untriaged work; charted
  and human work enters through the board.
- **engine → engine** — engines claim from the board, never hand off to each other.
- **cartographer ↔ chief-of-staff**, **intake-desk → chief-of-staff**, **engine →
  cartographer** — no role routes its output through another; the board carries it.

**Offline behavior is log and continue.** A `channel_send` to a down peer returns a
`PeerUnreachableError` — you **log it and move on**. No retry, no escalation, no ack-required
kinds: because every edge is an optimization over the board, a failed send costs latency,
never correctness, and a genuinely-down peer surfaces on the **board** (the needs-triage count
climbing, a PR state not moving), not through a transport error anyone chases.

### The addressing idiom — `channel_send {targetRole, kind, body}`

Roles address each other by **role**, through one MCP tool — you never discover or name another session;
the substrate resolves the target role's inbox for you:

- **`channel_send {targetRole, kind, body}`** — discovery is implicit inside the send (the
  library resolves the role's inbox; there is no separate discover/claim tool). Success returns
  an `InboxAck`; an unreachable peer returns a `PeerUnreachableError {target, reason}`.
- **Inbound arrives as a wake tag** — `<channel from="inbox://<role>" kind="…">…JSON…</channel>`.
- **An ack means delivered-to-inbox + wake enqueued — never seen-by-model.** The peer reads it
  when it wakes; the ack is not a read receipt and never an answer. (This is the load-bearing
  corollary the chief-of-staff carries: *conversing is not evidence* — coordinate over the
  channel, read the board for truth.)

## Relationship to kampus-pipeline and pipeline-crew-mcp

- **pipeline-crew consumes [`kampus-pipeline`](../kampus-pipeline/), never the reverse.** The
  defs conduct the pipeline's shipped **skills** and spawn its ephemeral **agents** (`coder`,
  `reviewer`, `shipper`, `reporter`, `triager`, `planner`, `canon`, `adr`) **by their shipped
  names** — they never re-implement, fork, or edit any file under
  [`../kampus-pipeline/`](../kampus-pipeline/). The dependency is one-way: you can run the
  pipeline skills by hand with no crew; the crew is the proven way to run them continuously.
- **The channel substrate is [`@kampus/pipeline-crew-mcp`](../../packages/pipeline-crew-mcp/),
  a runtime prerequisite** — the tracker + the `channel_send` toolkit the defs address each
  other through. It is referenced, not bundled (an npm publish is a future unlock); the crew
  expects it available on `main` HEAD.

### The crew is deliberately outside the §CP boundary

kampus-pipeline carries a **control-plane (§CP)** boundary: PRs that touch the agent control
plane bank for a human merge behind a hard GitHub gate (ADR
[0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)).
**pipeline-crew's `agents/` is deliberately *not* part of that boundary** — the crew is an
optional layer whose PRs **auto-ship on green** by design (a founder ruling in the crew's resolved design questions),
with no extension of the §CP path set to this directory. Edits to the crew defs here merge
automatically once their review gate passes; PRs that touch kampus-pipeline's own §CP surfaces
still bank for a human merge.

## Install by name from the kampus marketplace

```
/plugin marketplace add kamp-us/phoenix
/plugin install pipeline-crew@kampus
```

The plugin carries **no `version`** — it is content-addressed by commit SHA (continuous-ship,
ADR [0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md)), so def edits
reach installed operators on the normal update path. Install kampus-pipeline the same way
(`/plugin install kampus-pipeline@kampus`) — the crew conducts its skills, so you want both.

## Personalize, then stand up

The shipped plugin carries **zero** operator data: the four defs, this README, and the config
template hold only `<placeholders>`. Everything operator-specific enters through the
**[personalization seam](PERSONALIZATION.md)** — at stand-up you copy the placeholder-only
template to an operator-owned config and fill it once; each def resolves that file at spawn and
addresses *your* people and machine.

```bash
# 1. Copy the placeholder-only template to your operator-owned config (default path).
cp "${CLAUDE_PLUGIN_ROOT}/crew.config.template.jsonc" .claude/crew.config.jsonc
#    (or keep it anywhere and point $CREW_CONFIG at it).
# 2. Fill EVERY <placeholder>. Leave no <...> behind.
# 3. Git-ignore your copy — it holds your operator data and must never be committed.
echo ".claude/crew.config.jsonc" >> .gitignore
```

Resolution mirrors kampus-pipeline's repo-as-config seam (ADR
[0062](../../.decisions/0062-repo-as-config-plugin.md)): **`$CREW_CONFIG`** if set, else the
working repo's **`.claude/crew.config.jsonc`**. A def that can't resolve a filled config
**stops and asks you to run stand-up** — there is no baked-in default human. The full dimension
table, and how the crew boots from that one config (the tracker + the three bridges + the N
engines the config declares), are the [personalization seam](PERSONALIZATION.md)'s scope; read
it there rather than duplicating the key list here.

## Layout

```
pipeline-crew/
├── .claude-plugin/plugin.json    # manifest (no version — continuous-ship, ADR 0110)
├── agents/
│   ├── cartographer.md           # inbound-ideation bridge (wayfinder)
│   ├── intake-desk.md            # intake bridge (report → triage → plan)
│   ├── engineering-manager.md    # execution engine (coder → reviewer → shipper), ×N
│   └── chief-of-staff.md         # outbound-awareness bridge (live verifier, human comms)
├── PERSONALIZATION.md            # the personalization seam — the config contract + dimensions
├── PROBES.md                     # probe discipline — fail-open liveness/health probes (#3411)
├── crew.config.template.jsonc    # placeholder-only per-install config template
└── README.md                     # this file
```

## See also

- [`PERSONALIZATION.md`](PERSONALIZATION.md) — the seam mechanism, the dimension table, and the
  stand-up contract the four defs write against.
- [`PROBES.md`](PROBES.md) — probe discipline: liveness/health probes fail OPEN (an unrunnable
  probe is "unknown", never "down") + the no-bare-`timeout` convention. The conductor defs cite it.
- [`../kampus-pipeline/`](../kampus-pipeline/) — the pipeline this crew conducts (the skills +
  ephemeral agents).
- [`../../packages/pipeline-crew-mcp/`](../../packages/pipeline-crew-mcp/) — the channel
  substrate (the tracker + `channel_send`) the defs address each other through.
- ADR [0189](../../.decisions/0189-crew-roster-law-bridges-engines.md) — the crew roster law
  (bridges vs engines, cardinality-from-kind) that governs this roster.
- ADR [0062](../../.decisions/0062-repo-as-config-plugin.md) — the repo-as-config seam this
  crew's personalization mirrors.
- ADR [0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md) — why neither
  plugin carries a `version`.
- ADR [0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
  — the §CP hard gate the crew is deliberately outside of.
