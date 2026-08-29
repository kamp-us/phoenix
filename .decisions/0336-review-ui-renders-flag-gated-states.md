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

## Amendment — 2026-08-29: §1 shipped, so §2 and §3 retire

[#7218](https://github.com/kamp-us/phoenix/issues/7218) landed §1, so the two interim clauses this
ADR wrote against that absence are spent. Recorded here rather than by rewriting the body: what the
gate did while it could not see is part of the record.

**What replaced §2's interim rider.** `review-ui render` takes `--flag <key>=<on|off>`, repeatable.
It rides the worker's existing `phoenix_flag_overrides` cookie into the capture context, so no route
was added and `flagship/override-authz.ts` was not touched — its verdict still derives only from the
environment and the actor's stored platform-admin relation, and an attacker-supplied cookie still
cannot self-authorize. A flag-off state is therefore now a state the gate renders. What still owes
disclosure is narrower and unchanged in kind: a state nothing here can put on screen — seeded data
absent, credentials not handed over, a state with no mechanism.

**What that gate costs, stated plainly.** On a deployed stage the override cookie is honored only
for a request whose actor holds platform `Admin`, and `preview-seed test-account` provisions
moderation authority, not admin. So a forced run is an authenticated admin's capture: every
`--surface` must name `:auth` (a bare route beside `--flag` is refused on `10`), and the operator
grants platform admin to the test account on that throwaway preview D1 through the offline
`admin-grant` path ADR [0107](0107-capability-authz-framework.md) already sanctions. Two consequences worth
naming: the admin grant is opt-in, so an ordinary `:auth` capture stays a plain yazar+moderator's
view; and a forced capture shows admin-only affordances, which is the trade the operand buys and the
reason it is not the default.

**Why the override proves itself.** An override the preview dropped renders the flag-off page
cleanly, which is a valid PNG under the flag-on name — the same class as the `:auth` cookie that did
not authenticate ([#7051](https://github.com/kamp-us/phoenix/issues/7051)). So the shot asks the
preview's own `/api/flags/evaluate` from the same context, with each forced key's default set to the
opposite value, and refuses on `11` when a key came back at its default. The alternative was
trusting the seeding, which is exactly the assumption §2 existed to stop.

**§3's disclosure fork retires with it.** `claude-plugins/fabrika/skills/review-ui/SKILL.md` no
longer forks on a flag-off capture; it directs the reviewer to render that state. The fork on an
*unreachable* surface — the older #4305 rule — is untouched.
