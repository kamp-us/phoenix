# kamp.us — Roadmap

> The living roadmap of kamp.us: the founder-voice source of direction. GitHub milestones are its operational projection. Agents ground in this file the way they ground in an ADR — it says *what we build next, and why*, in order. Conversation-authored (ADR-0075 idiom); revised at arc boundaries or when the founder calls it. Not a pipeline surface — this is product direction (ADR 0078).

## What kamp.us is

kamp.us, reborn. A small, earnest community built around three products — **sözlük** (the community of definitions), **pano** (the shared board of links and posts), and **mecmua** (long-form publishing) — bound by **künye**, earned-authorship identity: you arrive a çaylak and become a yazar by vouch (kefil), not by signup. Quality over growth; the founders are the first users; nothing seeded. An autonomous software factory builds it.

## How this roadmap works

Direction flows top-down: **vision → arcs → milestones → epics → features.** An **arc** is a themed chapter of work, projected onto a GitHub milestone. **Exactly one arc is active** at a time — it defines "now," and priority is relative to it (`p1` = current arc). The intake pipeline stays deliberately direction-blind; this roadmap is the layer that gives it direction. When an arc flips active, stale priorities re-price against the new active arc.

## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Four Pillars | #17 | active |
| Geçit | #24 | queued |
| Mecmua v2 | #25 | queued |
| Atölye | #26 | done |

**Four Pillars** — *active.* Frontend polish and the encoded design system: the four pillars — Performance, Cohesiveness, Usability, Accessibility — made real and enforced (ADR 0162, the design-system manifest). The surface of kamp.us becomes excellent and self-consistent. The nav-IA discipline is mid-flight here.

**Geçit** — *the passage.* The membrane of the community: onboarding, künye (the reputation DO), and moderation. How a stranger becomes a çaylak, a çaylak becomes a yazar by vouch, and how the community governs itself. The çaylak→yazar journey — undefined today — gets designed here. (The earlier künye milestone folded in.)

**Mecmua v2** — The next chapter of long-form publishing: the Thinking-Machines 3-zone reading layout, and the reading/authoring experience maturing past v1.

**Atölye** — *the workshop.* The in-product museum of craft: curated exhibits, live and playable, where kamp.us shows how it is made.

## Campaigns

Campaigns are bounded, milestone-backed pushes that run *concurrently* with the active product arc, drained through the platform lane (ADR 0072 semantics; ADR 0078 engineering-led).

| Campaign | Milestone | State |
|----------|-----------|-------|
| Mentor Audit | #27 | active |
| Crew-MCP Finish — replace the tmux relay with crew-mcp | #28 | done |
| Deterministic Crew Mechanics | #29 | active |
| Diátaxis docs — pipeline-crew & -mcp | #31 | done |
| Merge-Gate Reliability | #36 | active |
| Worktree-Isolation Integrity | #37 | active |
| §CP Verdict Integrity | #38 | active |
| Flag Graduation | #39 | active |
| pipeline-cli Glue Consolidation | #40 | active |
| pipeline-cli @effect/platform migration | #32 | active |
| Agentic design-system coverage | #33 | done |
| Flag Retirement (ADR 0136) | #34 | active |
| Writing-Craft Import | #30 | active |

**The table is a parsed contract.** It is the single source the campaign skill (which appends a row and flips its state) and the lifecycle guard (which reads it) both bind to, so the grammar is pinned here rather than re-derived at either end:

- **Columns** are `Campaign | Milestone | State`, in that order. `Campaign` is the founder-voice name; `Milestone` pins the campaign to its GitHub milestone **by number** (`#N`) — the same row→milestone-by-number binding the roadmap-guard already enforces on `## Arcs`, and that number is the one link to the operational projection. `State` is the lifecycle cell.
- **`State ∈ {active, done}`** — the symmetric two-state lifecycle. A campaign is `active` while its milestone is draining, and flips to `done` once that milestone is fully drained (its GitHub milestone closed). There is no `queued` state: unlike an arc, a campaign is not sequenced ahead — it opens `active` when the founder starts it and ends `done`, running concurrently with whichever arc is active.

**Mentor Audit** — a security & architecture audit wave (the staff-mentor findings: the karma double-bump race, per-actor rate limiting, ops runbooks, `SECURITY.md`, …). To be solved ASAP; drains via the platform lane alongside Four Pillars.

## Standing lanes

Not everything is an arc. **Pipeline & reliability hardening** is continuous, milestone-less work carried on the `axis:pipeline-hardening` label — the factory maintaining itself. It runs always, in the platform lane, and is never a product arc.

