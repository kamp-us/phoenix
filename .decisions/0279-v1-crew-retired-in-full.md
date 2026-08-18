---
id: 0279
title: The v1 crew is retired in full, kampus-pipeline survives
status: amended-in-part by [0291](0291-retire-kampus-pipeline-plugin.md)
date: 2026-08-14
tags: [pipeline, pipeline-crew, crew-mcp, fabrika, retirement]
---

# 0279 — The v1 crew is retired in full, kampus-pipeline survives

**What this decides:** The standing multi-session crew and everything built to run it are being removed from the repo, not frozen for later. That covers the messaging package, the two crew plugins and their two marketplace entries. The rest of the v1 pipeline suite — `claude-plugins/kampus-pipeline/` — stays, because someone outside this repository installs from it.

## Context

The crew was a standing multi-session operating shape: four roles addressing each other over an in-repo channel substrate (`packages/pipeline-crew-mcp/`), distributed as a plugin (`claude-plugins/pipeline-crew/`) with a second plugin declaring the substrate as a channel server (`claude-plugins/pipeline-crew-mcp/`). Twelve accepted ADRs — [0187](0187-crew-mcp-is-not-control-plane.md), [0189](0189-crew-roster-law-bridges-engines.md), [0191](0191-crew-claim-lifecycle.md), [0192](0192-standup-launcher-crew-mcp-subcommand.md), [0195](0195-crew-agent-def-name-collision-free-convention.md), [0196](0196-read-only-crew-fanout.md), [0197](0197-canonical-per-repo-crew-rendezvous.md), [0201](0201-pipeline-tenant-phoenix-first.md), [0204](0204-advisory-engine-nudge-edge-amends-0189.md), [0211](0211-crew-message-times-are-stamped-not-composed.md), [0212](0212-marketplace-manifest-is-control-plane.md), [0217](0217-lane-claim-authority.md) — govern parts of it. Ten of those twelve were on #5541's fact list; 0196 and 0211 were not, and the Records section below says how they were found.

fabrika replaced the v1 pipeline without ever calling it (ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md), which deliberately kept v1 deletable and already put `packages/pipeline-cli/` outside this question). The wider v1 retirement is already under way and this entry does not re-decide its mechanics: ADR [0255](0255-skill-namespaces-keep-v1-and-fabrika-apart.md) makes the `.claude/skills` symlink the retirement lever, and ADR [0277](0277-v1-retirement-keeps-the-plugin-suppression.md) settles what happens to the symlinks and the plugin suppression at that moment. Those are adjacent, not the same decision: they govern how the v1 *skill roster* leaves, this one governs whether the *crew* exists at all.

Milestone 45 phase 5 then parked the crew question on purpose, offering three shapes — full stop, rebuild on fabrika shells, or wait — and declining to pick one until phases 1–4 reported.

The question came due on [#5541](https://github.com/kamp-us/phoenix/issues/5541), which observed that a 19k-line package cannot have an unstated fate. The recommendation put to the founder there was **freeze** the package pending phase 5, on the reasoning that retiring early would pre-empt the pause he had set deliberately. **He overrode that recommendation.** Verbatim, 2026-08-14:

> no i am pretty happy with the current fabrika state, i really dont want anything from v1, especially not crew. let's kill it and remove them

Two follow-up rulings the same day complete the decision, both recorded on #5541.

**The stand-down shape.** The literal reading of "I really don't want anything from v1" is the crew stand-down that [#5537](https://github.com/kamp-us/phoenix/issues/5537) is hard-gated on. #5537's gate is a founder gate, so it was asked as its own question naming the three shapes rather than discharged by inference. Verbatim:

> full stop

**The scope fence.** The ruling's wording reaches past the crew to "v1" generally. It was fenced. Verbatim:

> we should remove pipeline crew but not the kampus-pipeline because it's being used by cansirin atm to build [another repo outside phoenix]

## Decision

**The v1 crew is retired in full — `packages/pipeline-crew-mcp/`, `claude-plugins/pipeline-crew/`, `claude-plugins/pipeline-crew-mcp/` and their two `.claude-plugin/marketplace.json` entries are removed; `claude-plugins/kampus-pipeline/` survives.**

Retired, not frozen. A frozen package still asks to be maintained, still appears in every sweep, and still reads to a cold agent as a thing that might come back. Nothing is coming back: fabrika is the pipeline, and the crew is not being rebuilt on fabrika shells.

`claude-plugins/kampus-pipeline/` survives on a live-consumer fact, not on sentiment — a consumer outside this repository installs the suite from it. That is the whole reason the fence exists, and it is what makes "retire v1" mean the crew rather than the suite. `packages/pipeline-cli/` was already outside this question under ADR 0238.

**Binding constraints.**

- The removal is carried by [#5592](https://github.com/kamp-us/phoenix/issues/5592). This decision deletes nothing itself.
- Both marketplace entries go with their plugins. Editing `.claude-plugin/marketplace.json` is a control-plane edit under ADR [0212](0212-marketplace-manifest-is-control-plane.md), so the removal is human-merged.
- The twelve crew ADRs stay unedited. They are history, and a decision record is not rewritten to erase something later retired.

**Banned.**

- Removing, renaming or otherwise touching `claude-plugins/kampus-pipeline/` or its marketplace entry as part of this retirement.
- Rebuilding the crew's claim / lease / role-cardinality layer on any substrate, absent a new founder ruling.
- Reading any of the twelve crew ADRs as a live instruction after removal lands.

## Consequences

- **Nothing outside the package imports it, so removal breaks no runtime path.** Verified on `main` at authoring time: no file outside `packages/pipeline-crew-mcp/` imports `@kampus/pipeline-crew-mcp`, and no application or CLI code consumes it. What is left is text, not runtime: workspace config (`pnpm-workspace.yaml`'s catalog comment, `pnpm-lock.yaml`, `.gitignore`), decision records, `.glossary/TERMS.md`, `.patterns/` (four pattern docs plus two rows in `.patterns/index.md`), the crew plugins' own docs, `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`, `.github/workflows/skill-gh-lint.yml`, and `packages/pipeline-cli/` (`leak-guard/path-matcher.ts`, plus the `control-plane-paths`, `leak-guard` and `publish-isolation-guard` unit tests). [#5592](https://github.com/kamp-us/phoenix/issues/5592) carries the removal and owns the complete enumeration — read it, not this bullet, for the full set.
- **One of those references runs the wrong way, from the survivor into the deleted tree.** `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` cites `packages/pipeline-crew-mcp/src/tracker/registry-core.ts` as a live worked example. The suite this decision keeps alive therefore points at code this decision deletes, so #5592 has to re-ground that example rather than delete around it.
- **Three reference surfaces that #5541's own fact list did not name.** Two CI jobs exist only to guard crew paths — `.github/workflows/crew-fanout-guard.yml` and `.github/workflows/crew-leak-guard.yml` — backed by `packages/pipeline-cli/src/tools/crew-fanout-guard/` and `packages/pipeline-cli/src/tools/leak-guard/crew-leak.ts`; and `packages/pipeline-cli/src/tools/publish-isolation-guard/`'s unit tests use the package as a fixture. These are guards *over* crew paths, not consumers of crew code, so they do not block removal — but they are pipeline-cli surfaces that go stale with it, and #5592 should carry them.
- **The coordination half of the crew has no replacement and is not getting one.** Native channels plausibly covers the messaging edge. The claim / lease / role-cardinality layer of ADRs [0189](0189-crew-roster-law-bridges-engines.md) and [0191](0191-crew-claim-lifecycle.md) has no proven native counterpart. Retirement dissolves that question rather than answering it, because the only consumer is being stood down with it. Anyone who later wants a standing crew inherits an unsolved coordination problem, not a shelved solution.
- **Lane exclusion is unaffected, and gets simpler.** ADR [0217](0217-lane-claim-authority.md) already made the GitHub comment claim authoritative and the tracker claim advisory for that purpose. Removing the tracker deletes the advisory half; the authoritative half is untouched, as is ADR [0272](0272-lane-owns-the-claim.md)'s rule about when a claim is released.
- **Six open defects inside the package were already gone before the ruling landed.** [#5203](https://github.com/kamp-us/phoenix/issues/5203), [#4869](https://github.com/kamp-us/phoenix/issues/4869), [#4760](https://github.com/kamp-us/phoenix/issues/4760), [#5283](https://github.com/kamp-us/phoenix/issues/5283), [#4862](https://github.com/kamp-us/phoenix/issues/4862) and [#5330](https://github.com/kamp-us/phoenix/issues/5330) were all closed `NOT_PLANNED` on 2026-08-14, between 06:55 and 06:56 — before the ruling. So the ongoing-cost argument #5541 rested on had resolved itself independently; the ruling did not need it.
- **Milestone 45 phase 5's crew question is answered.** Of the three shapes it parked, the founder picked full stop. That also discharges the gate on [#5537](https://github.com/kamp-us/phoenix/issues/5537), which was waiting on exactly this.
- **`.patterns/` and `.glossary/` go wrong the moment the code is gone.** Four pattern docs reference the package — `effect-rpc.md` worst, with its worked examples all inside `packages/pipeline-crew-mcp/src/protocol/` — and `.patterns/index.md` carries two rows whose links point into it. Those docs describe current code shape, so after removal they mislead rather than fall silent. Their per-doc fate is #5592's, not this decision's.
- **One live fabrika-era decision record loses a document it cites as normative, which `.decisions/` was not expected to do.** ADR [0250](0250-fabrika-hook-cannot-run-fails-open.md) (accepted, governing how a fabrika hook fails) cites `claude-plugins/pipeline-crew/PROBES.md` twice as the written source of the three-outcome probe rule it applies. 0250 is not a v1 record losing its subject; it is live law under fabrika whose grounding text this removal deletes, and the two links go dead for the internal-links job at removal time. The rule needs a surviving home, or 0250 needs to carry it inline. Routed to #5592, which must not delete `PROBES.md` without doing one of the two.

## Records

- Records the founder ruling on [#5541](https://github.com/kamp-us/phoenix/issues/5541) (2026-08-14) and its two same-day follow-ups: the stand-down shape (*"full stop"*) and the scope fence keeping `kampus-pipeline` alive.
- The removal work is [#5592](https://github.com/kamp-us/phoenix/issues/5592). Discharges the gate on [#5537](https://github.com/kamp-us/phoenix/issues/5537).
- **Two crew ADRs the #5541 fact list did not name: [0196](0196-read-only-crew-fanout.md) and [0211](0211-crew-message-times-are-stamped-not-composed.md).** 0196 rules that a bridge or engine may fan an expensive read to a write-tool-free subagent, and it lands that subagent as an agent def under `claude-plugins/pipeline-crew/agents/` — the `crew-investigator` def #5592 already lists for deletion. 0211 rules that every instant on the crew message substrate is stamped by the transport, receiver or tracker rather than composed by the sender; its whole subject is that substrate, and it is `accepted` today. Neither writes the string `packages/pipeline-crew-mcp`, which is why a package-name search missed both. Both are retired on the same terms as the other ten: subject removed, text unedited, status untouched. Found by the authoring-time contradiction sweep, not by the reference list — 0196 at authoring time, 0211 when this record was reviewed.
- **Relationship to the twelve crew ADRs — no supersede, no amendment, no status edit.** Each was checked. None of them is contradicted: this decision reverses no rule any of them states, it removes the thing they rule about. 0187 (crew-mcp is not §CP), 0189 (the roster law), 0191 (the claim lifecycle), 0192 (the launcher's home), 0195 (the `crew-<role>` naming), 0196 (read-only fanout), 0197 (the per-repo rendezvous), 0204 (the `EngineNudge` edge) and 0211 (substrate-stamped message times) all lose their subject and bind nothing after removal. 0201 (pipeline-as-product tenant, phoenix-first) is unchanged as a rule — its artifact list simply loses two members, and the surviving external consumer is that tenant model working as designed. 0212 (the marketplace manifest is §CP) is unchanged and actively governs this removal. 0217 (lane claim authority) is unchanged; its advisory half becomes moot. This entry is the single write #5592 asked for in place of twelve lineage edits.
- **Vocabulary impact: no term coined or redefined; nine existing rows are retired and routed to #5592.** `.glossary/TERMS.md`'s `## pipeline-crew` section carries nine crew-substrate rows — `pipeline-crew`, `crew`, `personalization seam`, `bridge (crew-role kind)`, `engine (crew-role kind)`, `per-instance engine address`, `stand-up launcher`, `read-only fanout (context-hygiene primitive)` and `advisory nudge edge` — every one defining something this decision removes. (`orphan red PR` and `heal-item` sit in that section but are not crew-substrate terms and survive.) The glossary edit belongs with the deletion, not ahead of it, so it is routed to [#5592](https://github.com/kamp-us/phoenix/issues/5592), which already lists `.glossary/TERMS.md` among the surfaces it owns.

## Amendment (2026-08-15, [#5592](https://github.com/kamp-us/phoenix/issues/5592)) — two carve-outs the removal turned out to need

The removal PR hit two edges this record fenced tighter than the tree allowed. Both are carved out here, so the diff runs on an authorizing record rather than on its own say-so.

1. **A dead link inside one of the twelve may be demoted to inline code.** "The twelve crew ADRs stay unedited" (above) was written against rewriting — restating, softening or erasing a retired rule. It is not a bar on delinking a path the same change deletes. `doc-links.yml` runs repo-wide over every tracked `.md`, so [0192](0192-standup-launcher-crew-mcp-subcommand.md)'s `PERSONALIZATION.md` link and [0197](0197-canonical-per-repo-crew-rendezvous.md)'s `tracker/server.ts` link red the moment their targets go, and the alternative — a `doc-links` exclusion — would weaken that gate for every file in the repo. Demoting a dead link to inline code is permitted in any of the twelve, on the condition that no word, no claim and no status changes; the path stays readable, and the record still says exactly what it said. Any edit beyond that remains banned.

2. **The `pnpm-workspace.yaml` surface is the crew catalog entries, and nothing else in that file.** The Consequences above name "`pnpm-workspace.yaml`'s catalog comment" as the surface, which read as a licence to rewrite the file. It is not. The file also carries ADR [0038](0038-dependency-patches-local-only.md)'s patch-policy block and four catalog-pin invariant notes, none of which is crew text, and 0038's own Consequences rest on that block existing ("anyone can see exactly what was changed **and why**"). The authorized edit is: drop the crew-only catalog entries, and re-ground the one paragraph naming a crew consumer. Every other comment in the file stays. `cleanupUnusedCatalogs: true` means `pnpm install` rewrites this file through pnpm's YAML writer, which does not round-trip comments — so any change touching the catalog must diff this file by hand before committing.
