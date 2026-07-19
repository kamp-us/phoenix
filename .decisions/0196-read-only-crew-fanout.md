---
id: 0196
title: Bridges + the engine may fan an expensive read-only task to a write-tool-free ephemeral subagent (context-hygiene primitive, not an execution edge)
status: accepted
date: 2026-07-18
tags: [pipeline, pipeline-crew, crew-mcp, topology, roster]
---

# 0196 — Read-only subagent fanout for bridges + the engine

**What this decides:** the crew bridges (chief-of-staff, cartographer, intake-desk) and the engineering-manager engine may dispatch an expensive read-only task (grep / diff / sweep / verify) to a throwaway subagent that returns only its distilled finding — and this stays a context-hygiene tool, never a "bridge runs the pipeline" execution edge, because the fanned agent is granted no write tools at all.

## Context

A bridge is singleton and long-lived (ADR [0189](0189-crew-roster-law-bridges-engines.md)): it owns a unique seam and, unlike an ephemeral pipeline subagent that is born-and-dies per task, it does **not** `/clear` between tasks. So context hygiene is load-bearing for the bridge seat in a way it is not for a fungible engine lane. Yet the bridge's charter is *verified reads carried to humans* — the reads are the job, but their byproducts should never persist in the seat that must stay coherent across a whole session.

Concrete evidence from one live chief-of-staff session (#3543): a codebase grep returned ~1.3MB of `node_modules` type-def noise into context; an all-envs flag read spewed 89 lines of inaccessible-app WARN spam; a 30-flag prod-serving sweep and an alchemy version/patch diff each needed many tool calls whose intermediate output is pure waste once distilled. Every verified read runs inline today, so the bridge's own context fills with tool artifacts that have no lasting value.

This is invariant-adjacent — it sits on the same roster-law boundary as #3534 (the chief-of-staff→engine nudge edge): *what capability may a bridge hold without collapsing ADR 0189?* So it earns the adversarial threat-model, not a convenience yes. Grounded in ADR [0189](0189-crew-roster-law-bridges-engines.md) (roster law) and ADR [0192](0192-standup-launcher-crew-mcp-subcommand.md) (the substrate launcher that binds each crew session).

## Decision

**Adopt a read-only subagent-fanout capability for the three crew bridges AND the engineering-manager engine: each may dispatch an expensive read-only task (grep / diff / sweep / verify) to an ephemeral subagent that returns only its distilled finding, and the fanned agent is granted no write tools — so it is a context-hygiene primitive, not an execution edge.**

**Scope: bridges + engine, both** (founder ruling, operator umut, 2026-07-19). The engine benefits from the same distillation even though it is fungible; the capability is uniform across the roster.

**The threat-model — the ADR 0189 boundary (the crux).** Does a read-only fanout drift into a de-facto *execution* edge — a subagent that "investigates" by mutating — reintroducing the "bridge runs the pipeline" edge ADR 0189 deleted? The answer is **NO, if and only if the read-only invariant is enforced.** A read-only investigator is not a coder/reviewer/shipper: it grep/diff/sweep/verifies and returns a result. It never builds, reviews, merges, or mutates the board. It is a context-hygiene primitive, not an execution capability — exactly aligned with the bridge's verify-and-carry charter, minus the artifact pollution. The EA→EM routing edge stays deleted; this grants no new execution path.

**Enforcement mechanism (load-bearing) — a grant-list fact, not a behavioral hope.** The fanned agent's tool grant contains **no write tools**: no Edit/Write, no merge, no board-mutation. This is verifiable from the agent-def's `tools:` frontmatter, not a hope about how the subagent behaves. The absence of write tools is what holds the fanout on the read-only side of the roster law — a read-only investigator *cannot* mutate because it was never granted the means to.

**The `Bash` surface is charter-level read-only, by deliberate design (#3614).** The grant-list-fact enforcement above is fully structural for Edit/Write/Task — those are simply absent. `Bash`, however, *is* granted: the investigator needs it to read the board (`gh api`) and the filesystem. That leaves one surface where a mutating command (`gh api -X POST|…`, `git push|commit|…`, `gh pr merge`) is technically reachable, so on the `Bash` surface the read-only guarantee is **charter-level, not grant-level** — the agent is trusted not to mutate, not adversarially walled off, and that is an accepted, deliberate choice (founder ruling, #3614). Command-prefix denylisting was **rejected**: the investigator is a trusted internal team member, not an adversarial surface, and a `Bash` prefix-deny is porous anyway (`--method POST`, var-indirection, subshells all evade it) — it would read as a structural wall while leaking, which is worse than none. The real mutation surfaces stay removed structurally (Edit/Write/Task absent from the grant) and enforced by the #3606 fanout allowlist guard; the trusted-not-walled `Bash` residue is the accepted charter-level remainder.

**Shared principle with #3534 (reconciliation).** #3543 and #3534 are the same roster-law boundary — what capability a bridge may hold without collapsing ADR 0189. The governing principle both must obey: **a bridge may hold read-only / no-write capabilities without becoming a bridge-runs-pipeline edge; the line is the write-tool grant, not the mere holding of a tool.** #3534 (the chief-of-staff→engine nudge edge) is to be decided consistently with this — the two crew-topology decisions must not contradict on the bridge-capability boundary.

**Implementation shape — a deliberate §CP fork.** The investigator is implemented as a read-only agent def under **`claude-plugins/pipeline-crew/agents/`**, which is **outside `CONTROL_PLANE_RE`** → **NON-§CP** (auto-ships on green, per ADR 0192's verified control-plane boundary). It is explicitly **NOT** a `claude-plugins/kampus-pipeline/agents/` agent — that path **is** §CP and would bank the tool grant for human merge. Landing it under `pipeline-crew/agents/` is a deliberate shape choice: the crew's own read-only tooling belongs in the crew plugin, not the gate-critical suite.

## Consequences

- The three bridges and the engine gain a clean way to run expensive verified reads: the distilled finding lands, the ~1.3MB of noise / 89 WARN lines / many-call intermediate output never enters the standing seat's context.
- The read-only invariant is enforced structurally (write-tool-free grant), so the capability cannot silently become an execution edge — a future reader "fixing" the grant by adding a write tool would be reintroducing the deleted bridge-runs-pipeline edge, and that is the line to defend.
- The implementation is tracked in follow-up issue [#3597](https://github.com/kamp-us/phoenix/issues/3597) (the `pipeline-crew/agents/` read-only investigator + the per-bridge/engine grant). It auto-ships on green (NON-§CP); a `kampus-pipeline/agents/` shape would have banked for §CP human merge.
- #3534 inherits the shared bridge-capability principle above and must resolve consistently with it.

## Records

Fixes #3543 (the read-only-fanout crew-topology decision). Follow-up implementation tracked in #3597. Reconciled with #3534 (shared roster-law boundary; decided coherently). Amended per #3614 (Option B) to record the `Bash`-surface read-only guarantee as charter-level by design.

Vocabulary impact: coins **read-only fanout (context-hygiene primitive)** — a write-tool-free ephemeral subagent a crew bridge or engine dispatches an expensive read to, receiving only the distilled finding, keeping the singleton seat's context clean. Routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md) (pipeline-crew section) in this PR.
