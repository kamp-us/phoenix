---
id: 0460
title: A real-browser walk of the lab exhibit registry owns the horizontal-overflow check, never the jsdom a11y suite or the capture harness
status: accepted
date: 2026-10-04
tags: [design, ci, testing, layout, pipeline]
---

# 0460 — A real-browser walk of the lab exhibit registry owns the horizontal-overflow check, never the jsdom a11y suite or the capture harness

**What this decides:** The check that a rendered surface does not push its page sideways lives in
one browser test that visits every lab exhibit at two widths. It is not a new gate, and it is not
added to the a11y suite or to the capture harness.

## Context

[#8125](https://github.com/kamp-us/phoenix/issues/8125) reported that no CI gate measures a page's
width. The incident was [PR #8022](https://github.com/kamp-us/phoenix/pull/8022): the markdown block
rendered 446px wide at a 390px viewport, and every design gate stayed green. The `review-ui` gate
caught it because it renders pixels, and the repair took two review rounds for one CSS line.

The gates that ran could not have seen it:

- `design-token-guard` reads declared values.
- `design-inventory-guard` compares JSDoc to a generated doc.
- `a11y-pbt` runs [`a11y-pbt.test.tsx`](../packages/design/src/a11y/a11y-pbt.test.tsx) in jsdom,
  which lays nothing out. [`check.ts`](../packages/design/src/a11y/check.ts) says its geometry and
  paint rules never assert per render.

[`Markdown.css`](../packages/design/src/Markdown.css) carries the repair for that one component.
The coverage gap stayed open.

The issue named three homes for a real-layout check:

1. A CI walk of the lab exhibits.
2. A browser tier of the a11y suite.
3. An assertion inside the capture harness, on every capture.

Two rulings stand on the issue. The first, at
[#8125, comment 5625050560](https://github.com/kamp-us/phoenix/issues/8125#issuecomment-5625050560),
dated 2026-09-10, was written by a driver session on the founder's behalf. It says where a check
lives inside CI is engineering's call under
[ADR 0078](0078-product-driven-decisions-by-default.md), and it names no home.

The second, at
[#8125, comment 5977857587](https://github.com/kamp-us/phoenix/issues/8125#issuecomment-5977857587),
dated 2026-10-04, quotes the founder answering "yes" to the driver picking the home itself. The pick
under that answer is the driver's wording, an agent's choice made under the two rulings. It is not
the founder's wording.

This ADR transcribes that second ruling
([ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md)).

## Decision

**One real-browser test walks the lab exhibit registry and fails when a page's document is wider
than its viewport.**

### Owner

The walk runs in the browser test tier the repo already has. It is not a new gate or a new
workflow. It is not a tier of the jsdom a11y suite, and it is not an assertion inside the capture
harness. The ruling gives the reason for the pick: it is the option the issue calls roughly one file
of code. It states no reason against the other two.

### Real geometry

The test loads each exhibit at its real address in a browser, so CSS applies and the page is laid
out. The assertion is `document.documentElement.scrollWidth <= clientWidth`, read from that page.
jsdom cannot answer it, because jsdom computes no layout.

### Surfaces and viewports

Every exhibit in the lab registry
([`registry.ts`](../apps/web/src/lab/atolye/registry.ts)), at 390 and 1280 wide.

A surface with no renderable address is out of this check's reach and out of scope here. The ruling
names Tuval-only surfaces as that case.

### Evidence on failure

A failing exhibit keeps:

- a full-page screenshot,
- the measured `scrollWidth` and `clientWidth`,
- the widest overflowing element.

These upload as a CI artifact. The issue reported that `review-ui` refuses an overflowing capture,
so the surface with the defect was the one surface that left no picture. Here the page that fails is
the page that leaves one.

**Binding constraints.**

- The overflow check adds no gate and no workflow.
- It covers every registered exhibit at both widths, with no per-exhibit opt-out ruled here.
- A failure uploads the screenshot and the three measurements.
- This record builds nothing and approves no campaign.

## Consequences

A sideways overflow in a registered exhibit becomes a red check, not a finding in a review round.

A surface that is not a lab exhibit is not covered. That includes app pages such as the `/pano`
overflow tracked at [#7730](https://github.com/kamp-us/phoenix/issues/7730), and every Tuval-only
surface.

The ruling says "the browser test tier the repo already has" and names no suite, project or job.
Which one the walk joins is the build's to spell. A build that finds no existing tier able to reach
the lab exhibits stops and takes that back for a ruling. It does not add a workflow on this record's
authority.

The follow-up is one bounded implementation ticket for the test itself:
[#10456](https://github.com/kamp-us/phoenix/issues/10456).

[#7941](https://github.com/kamp-us/phoenix/issues/7941) keeps scroll-region posture and consumer
guidance. This check detects overflow and does not replace that work.

## Records

no vocabulary impact
