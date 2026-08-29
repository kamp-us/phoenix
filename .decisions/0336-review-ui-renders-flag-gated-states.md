---
id: 0336
title: review-ui Renders a Flag-Gated Feature's Real States — Override at Capture
status: accepted
date: 2026-08-29
tags: [pipeline, review-ui, feature-flags]
---

# 0336 — review-ui Renders a Flag-Gated Feature's Real States — Override at Capture

**What this decides:** `fabrika review-ui render` gains a flag-override plus seeded-session path so a dark-shipped feature's real states paint under the gate, and until that path ships a `review-ui` verdict must name the states that did not render.

## Context

ADR [0083](0083-agents-deploy-humans-release.md) makes default-off dark-ship the norm: a user-facing change lands behind a flag nobody has flipped. `fabrika review-ui render` captures the PR's preview deployment as an anonymous visitor with every flag at its default, and its options carry no auth and no flag seam (`packages/fabrika-cli/src/review-ui/render-verb.ts` takes `--pr`, `--out`, `--surface`, `--app`, `--repo`). Flags resolve server-side (`apps/web/src/flags/useFlag.ts`, ADR [0179](0179-edge-resolved-shell-state-boot-contract.md)), so no client-side override exists either.

The two norms compose into a hole: the gate that exists to judge pixels sees only the off-path, and it says so in a verdict shaped like a judgment.

The instance is PR #6434 (head `74ecd143`, epic #4306). Six surfaces captured cleanly; four compositions the PR adds never painted — `/caylak-gorunurlugu` self-404'd behind its own gate, `/profile` served the auth wall, and `/pano` and `/sozluk` correctly showed no çaylak marker, because an anonymous viewer with the flag off is exactly who never sees one. The only judgeable new paint was `CaylakBadge`, and only because the builder happened to add an atölye exhibit that renders outside the flag. Nothing required that exhibit.

The `review-ui` skill's disclosure fork keyed on the verb reporting a surface *unreachable*. A flag-off capture is not unreachable — it renders, and it renders the wrong state cleanly — so the fork had no case for it and the run read as clean coverage.

The gap was reported as #6541; the founder ruled on it at [this comment](https://github.com/kamp-us/phoenix/issues/6541#issuecomment-5363127455).

## Decision

**`review-ui render` gets a flag-override plus seeded-session path, so a dark-shipped feature's real states paint under the gate.**

1. **Override at capture.** The verb grows a preview-scoped flag override and a seeded session, so gated and behind-auth states become reachable during a gate run. The implementation lands on its own build ticket, [#7218](https://github.com/kamp-us/phoenix/issues/7218), not under the decision issue.

2. **The interim rider.** Until that path ships, a `review-ui` verdict must name the states that did not render. This is not optional politeness — an unnamed hole in the evidence is indistinguishable from a clean read, which is exactly how #6434 passed.

3. **The disclosure fork covers the clean-but-wrong state.** `claude-plugins/fabrika/skills/review-ui/SKILL.md` forked only on the verb's `unreachable` outcome. A surface that renders its flag-off or logged-out state is not a judged surface either, and the verdict owes the same naming.

### Considered and not chosen

Two other directions were on the table. Neither was taken, and neither should be re-litigated without a new ruling.

- **Require a renderable escape hatch** — make an atölye exhibit a required deliverable for any flag-gated UI slice, so the paint is always renderable outside the flag. Rejected as the primary close: it taxes every builder to work around a gate limitation, and an exhibit renders a component in isolation, not the composition a user meets.
- **Record a deferred-until-flip obligation** — have the gate emit an explicit obligation the founder's flag flip must discharge. Rejected as the primary close: it moves "look at the pixels" to the flip, which is the moment when looking is most expensive and least reversible.

The interim rider in §2 is the deferred direction's honest half — disclosure, not deferral — and it retires when §1 ships.

## Consequences

- The gate can judge what a user will actually meet, instead of judging the off-path and reporting a PASS.
- `render-verb.ts` grows an auth and flag seam it does not have today, which is real surface area on a verb that is otherwise read-only against a preview.
- Until that lands, `review-ui` verdicts get longer: every unpainted state is named. That is the point.
- The accidental coverage an atölye exhibit provides stays useful and stays optional.
