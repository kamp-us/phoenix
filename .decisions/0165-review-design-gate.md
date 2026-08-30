---
id: 0165
title: "The review-design gate — a 4th reviewer skill that drives an agent vision-gate over the PR preview deploy against the four-pillars design law"
status: accepted
date: 2026-07-06
tags: [design, pipeline, review, accessibility, control-plane]
---

## Context

ADR [0162](0162-four-pillars-design-law.md) made the four design pillars —
performance · cohesiveness · usability · accessibility — standing law, and its Consequences
already named a **review-design gate** ([#1966](https://github.com/kamp-us/phoenix/issues/1966)) as
the surface that checks every UI PR against that law "the way review-code checks acceptance
criteria." But a law with no gate is prose: nothing in the pipeline actually *looked* at the rendered
UI a PR produced. The existing reviewer skills read code, docs, and skill text — none of them opens
the running screen and judges what a user would see. The pillar prohibitions (faint-token-for-meaning,
missing focus ring, off-grid spacing, a void empty state, a sub-36px tap target, color-as-sole-signal)
are visual facts about a rendered surface; a text-diff review cannot reliably catch them.

This ADR **records** the founder-crystallized design of that gate. The design is founder-ruled — this
is a conversation-authored ADR (ADR [0075](0075-issueless-doc-pr-merge-seam.md), issueless) that
transcribes the ruling, not a proposal that decides it. The loop it describes was **proven this
session**: the manual product-design-advisor pass that judged the audit-wave UI was exactly this
gate run by hand — a reviewer drove the preview, captured the changed surfaces, and Claude judged them
against the ADR-0162 pillars. This ADR promotes that manual proof to a standing pipeline gate.

## Decision

`review-design` is a **4th reviewer skill**, a sibling of
[review-code](0058-sha-bound-verdict-contract.md) / review-doc / review-skill, run by the **reviewer
agent** — **not a CI job**. It posts a SHA-bound marker `review-design: PASS|FAIL @ <sha>` on the PR,
under the ADR [0058](0058-sha-bound-verdict-contract.md) marker contract, so the verdict binds to the
exact head it judged.

### The mechanism — an agent vision-gate

The reviewer agent drives **Playwright over the PR's preview deploy** (the per-PR preview is already
produced by the pipeline), navigates to the changed UI surfaces, and **captures** them as
screenshots. **Claude itself — multimodal — is the vision model**: it looks at the captured images and
judges them against the ADR-0162 four-pillars design law and the machine-consumable transcription in
[`design-system-manifest.md`](../design-system-manifest.md). There is no exotic vision model and no
external judging service; the reviewer agent that already runs the other gates simply *sees*.

**Fork ruled — agent vision-gate, not human-eyeball.** Two options were on the table: (a) capture
screenshots and post them for a human to eyeball, or (b) an agent vision-gate where Claude judges and
emits a machine verdict. This fork was **explicitly resolved to (b)**. The human is not in the capture
loop; the agent judges. (Screenshots are still hosted so a human *can* look — see evidence hosting
below — but the human look is not the gate; the agent verdict is.)

### Blocking scope — calibrated, fail-conservative

The gate is **blocking**, but its hard-FAIL surface is deliberately narrow. It FAILs **only on the
enumerable, objective ADR-0162 prohibitions** — the "never" rules that are visual facts a reviewer can
point at without taste entering the judgment:

- a faint token (below the 4.5:1 floor) carrying meaning,
- a missing focus ring on an interactive control,
- off-grid spacing (off the 4px lattice, outside the sanctioned 1px/2px exceptions),
- a void / empty state with no designed empty view,
- a sub-36px tap-target hit area,
- color as the sole signal for state or meaning.

Everything **holistic or taste-based** — "this feels cramped", "the hierarchy is muddy" — rides as
**advisory, non-blocking notes in the same marker comment**, never as a FAIL. The reviewer is
**calibrated to fail conservatively**: only a clear, objective violation trips a FAIL; anything
borderline is downgraded to an advisory note. A FAIL feeds the **existing repair loop** — write-code
in repair mode consumes the latest `review-design` FAIL exactly as it consumes a review-code FAIL — so
the gate needs no new remediation machinery.

### Evidence hosting — GitHub user-attachments, depo dropped

The captured screenshots are embedded in the marker comment so a human can **see** the evidence behind
the verdict. They are hosted via **GitHub's user-attachments upload**, **not** depo — ADR
[0144](0144-depo-internal-asset-cdn.md) is **not a dependency** of this gate. The mechanism: POST the
PNG bytes to `uploads.github.com/user-attachments/assets` authenticated with the gh user token and the
target `repository_id`; GitHub returns a GitHub-hosted asset URL, which is embedded in the marker
comment.

The upload is **display-only and out of the decision path**: the verdict judges the **locally captured
bytes**, and the upload merely *shows* that evidence to a human reading the PR. If the upload failed,
the verdict would still stand.

**Known trade-off (recorded explicitly):** `uploads.github.com/user-attachments/assets` is an
**undocumented** endpoint — GitHub's web-composer internal API. It works with a user token today but
carries a small **durability risk**: it could change or break without notice. This is accepted because
the upload is display-only — a break degrades the human-visible evidence, never the gate's verdict, and
the fallback (link or inline note) is trivial. The technique originates from a public gist
(<https://gist.github.com/MrDHat/b9c008dbe8d387832c0321fac697bcf2>); it is described self-containedly
above so this ADR does not depend on that gist surviving.

### Enforcement seam — ship-it requires the PASS

A verdict nobody consults is not a gate. **[ship-it](0053-control-plane-boundary.md)'s gate-routing
changes to require a `review-design` PASS for UI-touching PRs**, the same way it already requires a
review-code PASS for code and a review-doc PASS for docs. That requirement — no `review-design` PASS at
the current head, no enqueue — is what makes "blocking" real.

### Self-consistency

`review-design` is itself a **gate-critical skill** → it is §CP (control-plane). It is therefore
**governed by the guard-relaxing-ADR §CP gate** (ADR 0164 / [#2191](https://github.com/kamp-us/phoenix/issues/2191)):
a change that would relax this gate is itself subject to the control-plane approval discipline. The gate
that guards the design law is guarded by the same control-plane rule it embodies.

## Consequences

- **Implementation is epic [#1966](https://github.com/kamp-us/phoenix/issues/1966).** It decomposes
  into: the `review-design` skill; the reviewer-agent routing that runs it for UI PRs; the
  Playwright-capture + GitHub-attachment-upload helper; and the ship-it gate-routing change that
  demands the PASS. This ADR is the design record; #1966 is the build.
- **[#2174](https://github.com/kamp-us/phoenix/issues/2174) folds into this.** The earlier framing —
  adding a "design dimension" to review-code / review-doc — is **subsumed** by `review-design` as a
  first-class 4th reviewer skill. Design review is its own gate with its own SHA-bound marker, not a
  rider on the code/doc gates. #2174 is recorded here as folded in.
- Every UI-touching PR now passes through an agent that **renders and looks at** the change before it
  can merge, closing the gap that a text-diff review left open for the pillar prohibitions.

## Relationship to prior decisions

- **ADR [0162](0162-four-pillars-design-law.md)** — the four-pillars design law; this gate is the
  review surface 0162's Consequences named, now specified.
- **ADR [0058](0058-sha-bound-verdict-contract.md)** — the SHA-bound review-marker contract;
  `review-design` posts `review-design: PASS|FAIL @ <sha>` under it.
- **ADR [0053](0053-control-plane-boundary.md)** — the control-plane boundary; ship-it's gate-routing
  is the enforcement point, and it grows a required `review-design` PASS for UI PRs.
- **ADR [0075](0075-issueless-doc-pr-merge-seam.md)** — the conversation-authored, issueless ADR
  exception under which this record is filed.
- **ADR 0164 ([#2191](https://github.com/kamp-us/phoenix/issues/2191))** — the guard-relaxing-ADR §CP
  gate that governs this skill, since `review-design` is itself gate-critical.
- **ADR [0144](0144-depo-internal-asset-cdn.md)** — depo, explicitly **not** a dependency: evidence
  hosting uses GitHub user-attachments, not depo.

## Amendment — governed localhost-only CI evidence (2026-08-29, #7306)

The shipped skill and marker are named `review-ui`. That vocabulary supersedes the historical
`review-design` name in the original decision above; those passages remain as the record of the
ruling's earlier name, not a second live namespace.

The preview producer remains the default, but it is not the only lawful producer. A rendered product
whose containment contract intentionally permits loopback only may use an exact-head CI producer
when, and only when, the harness is declared under the repository's governed `.github` authority.
The declaration fixes the workflow, check, event, artifact, commands, and surfaces; neither PR text
nor a caller can nominate them.

GitHub documents that `pull_request_target` runs in the context of the pull request's base and warns
that running untrusted code directly in that trigger can compromise the repository
([GitHub Actions event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)).
The trusted workflow therefore checks out the PR's full live head only as input to the base-owned
Dockerfile. Image construction pins pnpm 10.27.0 and performs `pnpm fetch --ignore-scripts
--ignore-pnpmfile` as the unprivileged `node` user. At that exact tag, the
[`fetch` implementation](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/plugin-commands-installation/src/fetch.ts#L47-L76)
uses an empty package manifest and sets `ignorePackageManifest`; the
[config loader](https://github.com/pnpm/pnpm/blob/v10.27.0/cli/cli-utils/src/getConfig.ts#L39-L62)
loads pnpmfile hooks only when `ignorePnpmfile` is false; and the
[install core](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1342-L1376)
gates dependency builds on `ignoreScripts` while its
[root lifecycle runner](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1521-L1531)
is under the inverse condition. Those version-matched paths establish that this fetch executes
neither package lifecycle scripts nor the PR's pnpmfile hooks.

The subsequent offline `pnpm install`—including every PR-controlled lifecycle script—and the
governed test run share a container with a read-only root filesystem, all Linux capabilities
dropped, `no-new-privileges`, no network, and one disposable test workspace. That workspace is
never served. A separate server workspace is freshly copied from the image's immutable exact-head
`/subject-source` and receives an offline install with both execution-disabling flags; only that
workspace is mounted read-only into the server under the same root/capability/network restrictions,
including `--network none`; the server publishes no host port and receives only the read-only
fixture. Docker documents that the `none` driver leaves only loopback
([none driver](https://docs.docker.com/engine/network/drivers/none/)). A base-owned capture sidecar
uses `--network container:<server>` to share that isolated network stack
([container networks](https://docs.docker.com/engine/network/#container-networks)), so its browser
reaches loopback without external network. The PR server receives no Actions credentials, authority
checkout, Docker socket, or artifact-output mount. The trusted sidecar receives the authority
checkout read-only and the prepared output only; the host validates the captures and writes the
manifest. Docker documents the remaining read-only root, capability, security, and mount controls
([Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/),
[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)). Browser-error evidence is
bounded by truncating each row to
1,024 UTF-16 code units and ordering uncaught page errors before console errors so the bounded
overflow cannot hide the hard-fail kind. A successful journey whose later browser capture records an
uncaught page error still publishes its manifest so the consumer can materialize the pixels, then
`review-ui fetch` returns the proven red-render `13`; the error can never become a clean PASS. A
governed journey command that itself exits nonzero stops before server start, capture, manifest, and
artifact upload. The versioned manifest binds repository, PR, exact head, declaration digest,
harness, workflow, check, run, artifact name, every surface, dimensions, and SHA-256.

The reviewer consumes the artifact only through GitHub. The consumer independently proves the
workflow/event/repository/PR/head association, successful completed run and check, unique unexpired
artifact, positive manifest schema, complete members, hashes, dimensions, readable error evidence,
and an unchanged head. GitHub's authoritative REST OpenAPI `Artifact` schema requires the boolean
`expired` field and defines it as whether the artifact has expired
([property](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141550-L141553),
[required list](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141602-L141612)).
The consumer then places the validated set in reviewer-owned scratch. No local
path, builder capture, or caller-selected workflow/run/artifact is an input.

`review-ui post` revalidates those bytes and the live head, re-resolves the governed workflow and the
exact run/check/artifact ids against GitHub, refuses PASS when the manifest records an uncaught page
error, verified-uploads the captures, records complete workflow/check/artifact provenance and
browser-error coverage, and emits the ordinary SHA-bound
`review-ui` marker. `ship` therefore
keeps one verdict grammar and one fail-closed namespace: missing, pending, stale, invalid, or
untrusted CI evidence produces no marker and no bypass.

This amendment also supersedes this record's earlier statement that evidence upload is display-only
and may fail without affecting the verdict. The shipped post contract makes verified upload a
precondition of marker creation (#3925), for preview and CI evidence alike.
