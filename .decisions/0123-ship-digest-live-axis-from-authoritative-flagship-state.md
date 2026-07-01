---
id: 0123
title: The ship-digest sources the live-to-users axis from authoritative Cloudflare Flagship state (read via cf-utils), not repo-declared defaults or a release-queue proxy
status: accepted
date: 2026-07-01
tags: [pipeline, ship-digest, feature-flags, release-engineering, observability]
---

# 0123 — The ship-digest sources the live-to-users axis from authoritative Flagship state

## Context

Epic [#1586](https://github.com/kamp-us/phoenix/issues/1586) (a founder-facing continuous
ship-digest) has to answer more than *"what merged."* It has to answer **"what is LIVE to
users."** Those two are the same only when shipping is not dark. Under the v1 membrane
([#1202](https://github.com/kamp-us/phoenix/issues/1202)) the authorship loop ships **dark**
behind a Cloudflare Flagship flag, so for that work **merged ≠ live** — the code is in `main`
but users cannot see it until a human flips the flag.

That flip is deliberately a human act (ADR [0083](0083-agents-deploy-humans-release.md):
agents own deployment, humans own release) performed **out-of-band in the Cloudflare Flagship
dashboard** ([ADR 0081](0081-feature-flag-substrate-cloudflare-flagship.md): Flagship is the
substrate). The flip therefore leaves **no in-repo record** — nothing in `git`, no PR, no
issue transition marks the moment a feature went live. This is the exact gap #1586 surfaces
and issue [#1596](https://github.com/kamp-us/phoenix/issues/1596) was carved to close:
**HOW does the digest source the live-to-users axis** when the state it needs lives only in
the dashboard?

Three candidate sources were on the table (all three named in #1596), each answering a
subtly different question:

### (a) Repo-declared flag defaults

Parse the flag declarations in-repo (`apps/web/worker/features/flagship/`, the
`.patterns/feature-flags-*.md` grammar) and report each as "declared default-off / dark."

- **For:** Cheap, fully in-repo, zero network or credentials, no coupling to the edge runtime.
- **Against:** It reports **declared intent, not live state.** A default-off declaration
  describes what the flag ships as, not whether a human has since flipped it on in the
  dashboard. The instant the human performs the ADR-0083 release flip out-of-band, the
  repo-declared default **drifts from reality** and the digest reports a live feature as still
  dark. This is precisely the "no in-repo record" gap (ADR 0083) — the repo *cannot* know the
  flip happened, so a repo-only read is structurally blind to the one event the live axis
  exists to catch.

### (b) Authoritative Cloudflare Flagship values

Read the live flag values from the Flagship service (the ADR-0081 substrate) via the
Cloudflare API — the actual served state per environment.

- **For:** **Ground truth for "what is actually live to users."** It reads the same state the
  edge evaluates against, so it captures the out-of-band dashboard flip that (a) and (c) miss.
- **Against:** Requires network + credentials from a pull-first CLI, and needs a read path into
  Flagship. That read path is exactly what [#1602](https://github.com/kamp-us/phoenix/issues/1602)
  (the `cf-utils` CLI) provides — see the Decision.

### (c) Release-queue proxy

Derive live-vs-dark from the `status:awaiting-release` label + the release-queue handoff
`ship-it` surfaces (ADR 0083's release queue; `product-development-cycle.md`): "merged,
awaiting release" vs "released (label cleared)."

- **For:** In-repo, already produced by the pipeline, cheap.
- **Against:** It is an **indirect proxy**, and it only covers **agent-/pipeline-mediated**
  ships. A manual dashboard flip a human performs without touching the label leaves the proxy
  stale — the release queue tracks the *handoff intent*, not the *served state*. Like (a), it
  reports the pipeline's model of release, not the authoritative fact of it.

## Decision

**Source the live-to-users axis from (b): authoritative Cloudflare Flagship state, read via
the new `cf-utils` CLI ([#1602](https://github.com/kamp-us/phoenix/issues/1602)).**

The digest's live/dark determination reads the **actual live flag values** from Flagship (the
ADR-0081 substrate) through `cf-utils`' flag-read capability, rather than inferring live state
from repo-declared defaults (a) or from the release-queue label (c).

### Why authoritative Flagship state, and not the in-repo proxies

- **Only the authoritative read is ground truth.** The live axis exists to answer "what is
  actually live to users." The one event that changes that answer — the human's out-of-band
  dashboard flip (ADR 0083) — leaves **no in-repo trace**. Any in-repo source ((a) declared
  defaults, (c) the release-queue label) is therefore structurally blind to it and drifts from
  reality the instant the flip happens. Reading the Flagship values directly is the *only*
  source that reflects the flip, because it reads the same state the flip writes.
- **`cf-utils` (#1602) provides exactly this read, over transport already in-tree.** #1602 is
  the human-operated CLI for Cloudflare flag read + flip; its flag-read is built on the
  `@distilled.cloud/cloudflare` Effect transport that `packages/d1-rest` already establishes as
  the canonical, typed CF REST client in the repo (`packages/d1-rest/src/index.ts`). So the
  digest does not stand up a second bespoke CF client — it consumes the shared boundary #1602
  builds, and #1602 in turn supersedes the raw-`curl` Flagship reader in
  `packages/orphan-sweep/src/cloudflare.ts` (the duplicated-CF-client bug class #1602 exists to
  kill).

### What this source can and cannot claim (stated honestly, per #1596)

- **Can claim:** for a flag-gated feature, whether the flag is **actually enabled in a given
  environment right now** — i.e. genuinely live to users (or dark) as served at the edge. This
  is the authoritative "live-to-users" answer the digest wants.
- **Cannot claim on its own:** the axis for **non-flag-gated** work. Work that ships without a
  flag (internal / refactor / infra / docs, the ADR-0083 exemptions) is live at merge with no
  flag to read; for that class "merged" *is* "live," and the digest derives the axis from the
  merge, not from Flagship. This ADR fixes the source for the **flag-gated** live/dark
  determination — the hard part #1596 was carved for — and leaves the non-flag-gated case as
  the trivial merge-equals-live default.
- **Freshness / consistency caveat:** Flagship flips "propagate within seconds" and evaluation
  serves the last-propagated config during that window (ADR 0081). A digest read is therefore
  authoritative to within that propagation window, not a strong-consistency snapshot — an
  acceptable bound for a founder-facing readout.

## Consequences

- **[#1597](https://github.com/kamp-us/phoenix/issues/1597) (the ship-digest live axis)
  consumes cf-utils' flag-read** rather than re-opening this fork. The contract is now concrete
  enough that #1597 implements against it: for a flag-gated shipped item, read the authoritative
  Flagship value via `cf-utils` and classify dark / live; for non-flag-gated work, merged-equals-
  live. #1596 closes on this recorded choice.
- **`cf-utils` (#1602) becomes a dependency of #1597.** #1597's live-axis read is the second real
  consumer of #1602 (the first being the founder's own v1 release flip). This sequences the work:
  #1602's flag-read capability lands before #1597 can source the live axis from it.
- **ADR 0083 stays intact — this is a READ, not an agent flip.** The digest *reads* the live
  state; it never writes it. The human remains the sole releaser, and no pipeline step flips a
  flag. Reading authoritative state to *report* what a human already released does not automate
  release; it makes the human's out-of-band act finally observable in-repo, which is the whole
  point of the live axis.
- **Refines the observability side of ADR 0083.** ADR 0083 established that the release flip is a
  human, out-of-band, unrecorded act. This ADR adds the missing **read-back**: the digest
  reconstructs the live-state record ADR 0083 left absent, by reading the authoritative source
  instead of demanding a new in-repo write discipline at flip time.
- **Complements ADR [0069](0069-derived-changelog-from-shipped-work.md).** The derived changelog
  projects *what shipped* (merged, closed-issue metadata) but has **no live-state axis** — it
  reports merges, not releases. This ADR adds exactly that axis for the digest: "merged" (0069's
  domain) plus "live to users" (the Flagship read). The two are complementary projections over
  the same shipped work, one keyed on merge, one keyed on the flag flip.
- **Rejected alternatives are rejected for drift, not cost.** (a) repo-declared defaults and (c)
  the release-queue proxy are both cheaper and fully in-repo, but each reports a *model* of
  release (declared intent / handoff label) that drifts from the served reality the moment the
  human flips out-of-band. The extra cost of the authoritative read (network + credentials via
  #1602) buys the one property the in-repo sources structurally cannot have: correctness against
  the actual live state.
- **Implementation is follow-up work.** This ADR records the sourcing contract only; the build
  lives in #1602 (the `cf-utils` flag-read) and #1597 (the digest's live-axis consumer). This is
  a `.decisions/**` docs PR (review-doc gate), so it auto-ships on a review-doc PASS; the
  implementation children take their own paths.
</content>
