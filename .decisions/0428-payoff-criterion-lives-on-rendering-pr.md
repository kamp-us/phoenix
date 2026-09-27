---
id: 0428
title: A criterion that needs a render lives on the ticket whose diff renders it, never on the tooling ticket
status: accepted
date: 2026-09-27
tags: [process, triage, review, pipeline]
---

# 0428 — A criterion that needs a render lives on the ticket whose diff renders it, never on the tooling ticket

**What this decides:** When a ticket builds tooling or data and the reason for it is something a
user will see, the "prove it renders" criterion goes on the ticket whose PR renders that thing. It
does not go on the tooling ticket.

## Context

Founder ruling, 2026-09-10, recorded on #7735:
<https://github.com/kamp-us/phoenix/issues/7735#issuecomment-5625306670>. The question was: should a
"prove it renders" criterion move to the PR that actually renders it, instead of sitting on the
tooling PR? The answer was yes. This record writes that ruling down and adds nothing to it.

#7708 asked `preview-seed` to seed a çaylak account with karma and a kefil. Its tenth criterion
asked for a `review-ui` capture of the vouched and unvouched topbar. The PR, #7717, changed only
`packages/preview-seed/**`. Three facts on `origin/main` meant no seat could answer that row:

1. **No `review-ui` row is raised.** `isUiSurface` in
   `packages/fabrika-cli/src/review/classes.ts` is a path test: the path starts with a configured
   `uiSurfaces` prefix (`apps/web/src/` in this repo) and is not a test file. `partitionWithUi` adds
   the `ui` class only when a changed path passes it, and `routedNamespacesOf` derives the
   `routed review-ui` row from that same partition. The linked issue's criteria are never read. A
   diff under `packages/preview-seed/**` raises no `ui` row of any kind.
2. **The text reviewer must FAIL the row.** `claude-plugins/fabrika/skills/review/rubrics/code.md`
   (line 21 today; line 20 when #7735 was filed) says, with no exception: "A criterion the diff
   cannot evidence either way is `[FAIL]` with the ambiguity named".
3. **No seat can take the shot.** `packages/preview-seed/src/bin.ts` builds its REST layer from
   `CredentialsFromEnv` and reads `CLOUDFLARE_ACCOUNT_ID` through `Config`, with no wrangler
   fallback. Those values live only as repository Actions secrets, so neither the build seat nor the
   review seat holds them.

So `review-code` had to FAIL, the FAIL sent the lane to repair, and the repair had nothing to change.
The shape is not specific to #7708. Any ticket whose deliverable is tooling or backend data, and
whose payoff is a render, carries it.

## Decision

**A criterion whose proof is a render belongs on the ticket whose diff renders it, never on the
tooling ticket that makes the render possible.**

The ticket that renders the surface changes files under a `uiSurfaces` prefix. So its PR raises the
`routed review-ui` row by the path rule that already exists, and the render is judged by the gate
built for pixels. The tooling ticket's criteria stop at what its own diff can prove: the seed
operand, the rows it writes, its tests.

When triage mints a tooling ticket whose payoff is a render, it puts the render criterion on the
consuming ticket. If no consuming ticket exists yet, triage files one, and wires the tooling ticket
as its `blocked_by`. The payoff criterion is moved, never dropped.

**The three routes #7735 named.**

- **Route 1, move the criterion to the consuming PR: chosen.** It is what the founder ruled. It needs
  no new machinery: the consuming PR's own paths already route `review-ui`. Its known risk is that
  the payoff is never judged. That risk is closed by the rule above: the criterion must land on a
  real ticket, and triage files one when none exists.
- **Route 2, derive `routed review-ui` from the criteria as well as the paths: rejected.** It would
  put a capture seat on PRs that render nothing, and the capture would still need route 3's
  credentials to run. It also cuts against ADR
  [0396](0396-head-diff-decides-a-review-rounds-classes.md), which rules that the head's diff decides
  the classes a review round owes. A criteria-derived class would be a second source for that set.
- **Route 3, give a lane seat the preview credentials: rejected.** It widens what every lane seat
  holds to a Cloudflare account token, which is a large blast radius for a render check. It also does
  not fix the routing: with credentials in hand, a tooling PR still raises no `review-ui` row, so the
  text reviewer still has to FAIL the row. #7708 showed this. A seat was later given the credentials
  by hand, and the lane parked again on a different wall (the throwaway-database fence #7740 fixed).

**What stops a reviewer from calling the row out of scope.** Nothing new is added, and nothing new
is needed. The rubric already forbids it: `rubrics/code.md` makes an unprovable row a `[FAIL]`, and
`[N/A]` is allowed only on positively established non-obligation, never as "could not tell". A
reviewer who meets a render criterion on a tooling PR still FAILs it. Only a control-plane human
can take a written criterion off a ticket, through `fabrika decision rule <n> --supersedes <k>`,
which leaves the row visible as superseded rather than deleting it. This ruling moves the pressure
upstream to triage, where the criterion is placed, so a reviewer should rarely meet the case at all.

**Binding constraints.**

- A criterion whose proof is a rendered capture sits on a ticket whose diff touches a `uiSurfaces`
  prefix.
- A tooling ticket's payoff render criterion moves to the consuming ticket. It is never deleted.
- If no consuming ticket exists, triage files one and wires the tooling ticket as its blocker.
- A reviewer never reclassifies an unprovable criterion as out of scope. Only a control-plane
  human moves it, through `decision rule --supersedes`.
- Review classes stay derived from the head's diff alone (ADR 0396). Criteria text never raises a
  class.

## Consequences

- **No code is required.** Route 1 uses the path rule and the supersede verb that already exist.
  The owed work is prose: the triage skill's criteria guidance must gain this rule. That edit is
  filed as #10016.
- **How #7708's tenth criterion is discharged.** Under this ruling the row was on the wrong ticket.
  Its owner is the consuming ticket, #7045, whose PR #7388 changes the topbar karma chip under
  `apps/web/src/` and so routes `review-ui`. On #7708 itself the founder waived the row before merge
  (<https://github.com/kamp-us/phoenix/issues/7708#issuecomment-5536648858>). This ruling makes that
  waiver the correct outcome rather than an exception, and #7708 is not reopened. The capture
  evidence recorded in that same comment stands as a record, not as a grade.
- **Tooling tickets get narrower criteria.** A reviewer grades them on what the diff proves. A PR
  that only builds seeding or data tooling no longer parks on a render it cannot produce.

## Records

no vocabulary impact
