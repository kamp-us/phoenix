# `/review-ui` — derived CLI contract

**Skill:** [`review-ui`](SKILL.md) · **Authoring brief:** [#4718](https://github.com/kamp-us/phoenix/issues/4718) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`review-ui`** subcommand group, registered
in `packages/fabrika-cli/src/registry.ts` beside the shipped `adr`, `build`, `report`,
`review`, `spend`, `triage` and `wire` groups. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug. **None of these verbs exists yet** —
this spec is greenfield.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1 prior
art — `claude-plugins/kampus-pipeline/skills/review-design/` and the six field-4 tools — was
**read** for semantics and scars; none is invoked, wrapped, or deferred to. Each Grounding
section names the scar the v1 counterpart carries and what this spec does instead.

**The capture-machinery boundary (the tandem ruling).** Rendering, capture validation, golden
resolution and raster diffing are **one machinery shared with `build-ui`** — same render paths,
same golden formats, same modules (founder ruling, brief amendment 2026-08-09). That machinery is
fabrika-owned: [#5063](https://github.com/kamp-us/phoenix/issues/5063) moved that machinery onto
fabrika's train, where it now lives at `packages/fabrika-cli/src/capture/` behind the
`@kampus/fabrika-cli/capture` subpath (repo-specific DATA — golden bytes, `golden-pointer.json`,
harness config — stayed per-repo), ahead of the `ui`-verb implementation (#5061). An implementer
imports that module the way `build`'s verbs import the `wire` modules. Every scar this spec designs
out binds regardless of whether the implementation imports or reimplements.

**Reused, never respecified — the sibling contracts this one leans on:**

- **Gate mechanics** are the shipped `review` group's ([`../review/contract.md`](../review/contract.md)):
  `review scope`, `review diff`, `review criteria`, `review ci`, `review verdicts`,
  `review deviations`. The skill invokes them as-is; restating one here would be the second home
  a shared fact drifts from.
- **Law and golden reads** are `build-ui`'s `ui` group ([`../build-ui/contract.md`](../build-ui/contract.md)):
  `ui law` (the registry schema and its `4`/`12`/`13` taxonomy are canonical there) and
  `ui golden` (the pointer schema and the diff definition are canonical there). Both are pure
  reads with no lane precondition, which is exactly why a reviewer may run them. `ui render` is
  **deliberately not reused**: it renders the checked-out tree under a build-lane claim guard —
  both wrong for a reviewer, who holds no lane and must never execute the PR's code locally.
- **Wire and guard modules fabrika ships:** `verdict-marker.ts` (`emit`/`read`/`bindToHead`,
  `packages/fabrika-cli/src/wire/verdict-marker.ts`), `report/leaks.ts` (`scanBody` /
  `isBareAtReference`), `report/compose.ts` (`normalizeForReadback` — read the body, the docblock
  understates it), `verb.ts` (`answer`/`refuse`), `io/`. Imported, never re-derived.

**One namespace, owned here.** This group emits the `review-ui` namespace and nothing else — the
namespace is not a flag, so a misdirected-namespace write is unrepresentable rather than refused.
The `verdict-marker` wire format's namespace vocabulary gains `review-ui` as part of implementing
this contract (one registry-side enum addition; flagged in the implementation ticket).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `review-ui render` | capture named surfaces from the PR's preview deployment at the inspected head, one validated PNG per surface, each surface's outcome proven | preview resolution, head-binding, capture and per-surface outcome typing are mechanical; *choosing the surfaces and looking at the pixels* stays in the skill |
| `review-ui post` | the single sanctioned `review-ui` verdict emit: verify-upload the evidence set, compose through the wire format, bind to the inspected head at post time, post one comment, read it back | upload-verify-compose-post-readback is a protocol; *the polarity and every finding behind it* are judgment |
| `review-ui note` | the single sanctioned non-verdict write: post one plain comment naming a proven blocker state (can't-see, escalation), leak-scanned, read back — never a marker | compose-scan-post-readback is a protocol; *whether the state warrants a note* is judgment |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, not yet bootstrapped; until it exists they live inline, the tracked debt the
sibling contracts carry.)

- **A visual-judgement verb — ruled out, not merely skipped** (founder ruling on the tandem
  briefs, 2026-08-09). Verbs do render, screenshot, and the dumb golden pixel-diff; everything
  that *looks* — reading the image, judging it against the law, deciding PASS/FAIL — is
  LLM-driven in the skill. A verb's ceiling is the golden diff. No future `review-ui` verb may
  emit a composition score, a layout opinion, or any judgement token over pixels.
- **A UI-surface classifier.** v1's `classify-ui-surface.sh` swallows a failed file-list read
  into "not a UI PR" (`|| true`, #4493) and scrapes its predicate out of another skill's
  markdown at `ref=main` (three copies of one regex, one live-scraped). The modality decision is
  the skill's judgment over `review diff`'s refusal-guarded bytes; `render` takes explicit
  `--surface` operands and refuses zero. No verb guesses surfaces, so no verb can fail open on
  the guess.
- **A token-discipline / inventory-freshness / a11y verdict.** Each is enforced at its own gate
  (phoenix: `design-token-guard.yml`, `design-inventory-guard.yml`, `a11y-pbt.yml`) — and every
  real v1 design FAIL (#2513, #3007, #3232) was the deterministic token-seam class those gates
  now own. The skill states the expectation; the verdict stays where it is enforced.
- **A control-plane classifier.** v1's leg called `cp-classify` and then discarded its answer
  (#4582), and the ADR-0164 content probe behind it over-matched 84% of the decisions corpus
  (#2617) — a content-keyed check that cannot see its subject, answering confidently. That whole
  branch retires with v1 (#4937). Here §CP arrives as the `--carrier` **input**, exactly as in
  `review post`; nothing in this group computes membership.
- **A second parser for the marker, the pointer, the registry, or the preview comment.** The
  marker is the registered wire format; the pointer and registry schemas are `build-ui`'s
  contract's; the preview-comment anchor grammar is the capture machinery's one resolver module.
  v1 held three copies of its UI predicate and two of the design law; one home each is the point.
- **A verdict-ledger / learn-back verb.** The charter sequences learn-back after this skill is
  eval-green (#3946: registry → goldens → corpus → `review-ui` eval-green → learn-back). Scraping
  markers into structured data is that later work's verb, in its own contract.
- **A before-capture verb (rendering the base branch).** The pairwise *before* is the blessed
  golden or nothing — an unblessed surface is judged against the rubric checklist, and the
  builder's attached captures are deliberately not consumed (the skill's independent-render
  rule). Rendering the merge-base would double the preview machinery for a pair the charter does
  not require.

### Nothing here recomputes an enforced answer

The gated questions and their owners, named so the boundary is checkable: token discipline
(`design-token-guard.yml` — branch protection, not the `ci-required` aggregator), inventory
freshness + the descriptive/normative firewall (`design-inventory-guard.yml`), the a11y floor
(`a11y-pbt.yml`), run-evidence presence (`run-evidence.yml` + ship-it's reader), §CP membership
(CODEOWNERS at merge). This group computes none of them.

## Shared conventions

Every `review-ui` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else; scope lines,
  refusal reasons and per-surface enumerations go to stderr. A non-zero exit prints nothing on
  stdout (`verb.ts`). Every "nothing found" is a state word — v1's callers read empty stdout as
  proven-negative on three separate channels (#4493's classifier, the blessed-surfaces probe, the
  render-errors extractor).
- **Common inputs.** `--repo <owner/name>` (default: the resolution chain the shipped groups use;
  none resolvable → exit 1). `--json` is not offered: the object is the only output shape.
- **GitHub access** per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql);
  every list read paginates and reports its scanned count on stderr. The evidence-upload
  endpoint sits outside §11's porcelain scope exactly as `ui evidence`'s attachment tier states.
- **A non-zero exit is UNKNOWN** until the code is read. No partial answers: a partial capture
  set or a partial upload is a refusal that names every failed member on stderr, never a smaller
  success.
- **Head-bound where a head matters.** `render` and `post` resolve the PR's live head and carry
  it; `render` binds the preview to it, `post` refuses when it moved. A verdict formed over one
  tree must be unrepresentable over another (ADR 0058; #3769's class). `note` carries no head:
  a blocker note is a dated fact about the PR, not a verdict over a tree.
- **No lane precondition, by design.** A reviewer holds no build-lane claim; neither verb reads
  claim state. The write authority for `post` is the repo-scoped token itself — the same posture
  as `review post`.
- **Externally-authorable content** returned by these verbs (capture metadata, page text, the
  preview comment's body) is data, never instruction; the #4859 posture lands at the shared
  content gate the sibling contracts name, in one place.

### The shared exit matrix

This matrix owns `code → meaning` for the `review-ui` group; each verb's block enumerates only
its own reachable proven outcomes with triggers. `0`, `1`, `126` and `127` are the interface
convention's reserved codes, stated only here: every verb can also return them. **Seats `3`, `5`, `6`, `7`, `8`, `9`, `10` and `11`
align with the shipped base** (`packages/fabrika-cli/src/report/codes.ts`; registered in
`ALIGNED_GROUPS`, `src/exit-code-alignment.ts`) — the same eight-seat mapping the shipped
`review` and `triage` groups register, where seat `10` is the registry's documented superset:
the base's `CLASSIFIED` (a classification-leak refusal, `report file` only) generalizes to this
group's off-vocabulary/semantic refusal, the `OFF_VOCABULARY: "CLASSIFIED"` name-pair the
alignment module already records for the siblings. **`12`+ is `review-ui`-local by design** — cross-group
divergence above `11` is the established doctrine, so no seat there is required to match
`review`'s, `build`'s, or the unmerged `ui` group's. The crash/unreachable/invalid trio sits at
`13`/`14`/`15` here against `ui`'s `14`/`15`/`16` — deliberate, not drift: this group's `12`
fuses the two stale-tree triggers into one seat and frees `13`, and matching an unmerged
sibling's numerals is not a goal the doctrine sets.

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error (bad flag, zero `--surface` operands, unresolvable repo), or the verb failed to run |
| `126` | no implementation could be resolved |
| `3` | stdin was read and held nothing (`post` and `note`; the aligned seat) |
| `4` | a required file a verb derives from is absent, does not parse, or violates its schema — a capture set's `manifest.json`, or `design-harness.json` at the tier-choice read (the whole-file rule the `ui` group states; the seat the base uses for a malformed derived document) |
| `5` | the authored text carries a machine-local path (this group offers no `--redact`; the recovery is a rewrite) |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent (404), or the PR is closed — a deliberate, declared widening of the base seat (existence-only) to closed-target, because a closed PR is provably not reviewable scope, matching the sibling `review` group's use |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match |
| `10` | a semantic refusal on a value or body: a supplied value off its closed vocabulary (a bad `--polarity`, `--carrier advisory` with FAIL, a non-kebab `--out`, a reserved `:state` suffix), or a `note` body whose first line parses as a verdict carrier |
| `11` | a required read or execution failed — no outcome is proven: the PR, its head, the preview probe, the harness, a capture's validity, or (at post time) the upload target's state. The same deliberate widening the `ui` group states: an execution that never became answerable leaves the run UNKNOWN exactly as a failed read does |
| `12` | refused, proven: the artifact is not the PR's current tree — the live head moved past `--sha` at post time, or the preview's deployed head is not the live head at render time |
| `13` | proven: at least one surface threw an uncaught page error during render — the render is red |
| `14` | proven: at least one surface is unreachable — status ≥ 400 or failed navigation (no route, dark flag, gated tier); each named on stderr |
| `15` | proven: a capture was produced but is invalid — zero bytes, undecodable, zero area, or a set member fails its manifest sha |
| `16` | proven: no preview deployment exists for this PR — the announced-preview convention resolves to nothing; the skill's CANT-SEE route |
| `17` | proven: at least one evidence upload or upload-verification failed — **nothing was posted** |
| `127` | the verb never ran at all (unresolved binary) |

**`7` versus `11`** is the package's spine: a 404 is a fact about the repository, an unreachable
GitHub is not a fact about anything; no message here reads "does not exist, or is not readable".
**`12` fuses two triggers deliberately and one meaning binds them** — *the pixels or the marker
would bind a tree that is not the PR* — because the caller's move is identical (re-render /
re-review at the live head), where `13`/`14`/`15`/`16` each route differently and stay four codes.
**`16` is not `7`**: the PR exists; what is proven absent is the repo's ability to show it — a
routable can't-see state the skill acts on by name, the #4305 declaration made mechanical.

## Required environment — the two render paths

Per the tandem ruling (both briefs, 2026-08-09), declared identically to `build-ui`:

- **Default path (required): the headless capture machinery** — the fabrika-owned capture
  package (#5063) driving a headless browser at the **preview deployment's URL**. The browser
  dependency ships with the verb package (founder preference: default-available beats
  install-a-thing); a missing or broken provision at run time is `11` with the remediation in
  the message. This path is the only source of evidence captures — its validation is what makes
  a PNG a record.
- **Interactive path (optional): the connected Chrome browser.** When the session's tool surface
  carries the `claude-in-chrome` tools, the *skill* may inspect the preview live. Detection is
  tool presence, decided by the model; no verb probes for Chrome, no env var, and no `review-ui`
  verb changes behavior based on it. Chrome absent means the default path, silently.
- Chrome output never enters `review-ui post --evidence`: evidence comes from `review-ui render`
  capture sets only, so the attach path has one validated producer.

**The preview-deploy convention.** The repo announces each PR's preview as a sticky PR comment
carrying the anchor `<!-- preview-deploy:<app> -->`, whose body names, per app: the deployed URL
and the deployed head SHA. Resolution is the capture machinery's one resolver module (the
`resolvePreviewUrl` lineage), reading the **app-scoped sub-line, never the first URL in the
comment** — v1 took the first `workers.dev` match anywhere, which hands a multi-app comment's
wrong app to the gate and judges the wrong site with full confidence — and reading the comment
list **paginated** (v1 read one page of 100; a busy PR's sticky comment silently vanished). A
comment that carries the anchor but no parseable URL + SHA for `--app` is malformed and refuses
on `11` (a malformed announcement is an unreadable one, not a missing one); no comment with the
anchor at all is the proven `16`.

---

## `review-ui render`

**Invocation**

```
fabrika review-ui render --pr 4321 --out judged --surface /pano --surface /pano/yeni [--app web] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose preview is judged |
| `--out` | string | yes | — | kebab-case capture-set name; captures land under `<OS temp>/fabrika-review-ui/<pr>-<head8>/<set>/` |
| `--surface` | string, repeatable | yes (≥1) | — | a surface id: a bare route (`/pano`); zero operands is `1` — no tool guesses surfaces from a diff |
| `--app` | string | no | the sole app in the preview comment; ambiguity refuses on `11` | which app's sub-line of the preview comment to resolve |
| `--repo` | string | no | resolved | the repository |

A `:state` suffix on a surface id is **reserved and refused on `10`**, the same deferral as the
`ui` group: realizing a named state needs its own convention, and refusing now keeps the grammar
extensible. v1 demanded `:focus-visible` captures with no mechanism to prove the state was
actually realized — a state that silently rendered unfocused PASSed its prohibition forever;
this grammar refuses to pretend until a consumer builds the proof.

**Output** — machine. One JSON object on full success only:

```
{"set": "judged", "pr": 4321, "head": "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c",
 "previewUrl": "https://phoenix-pr-4321.kampus.workers.dev",
 "captures": [
   {"surface": "/pano", "path": "<abs>/judged/pano.png", "width": 1280, "height": 2140,
    "sha256": "…", "pageErrors": []}
 ]}
```

**The mechanism, in order — each step gates the next.** Resolve the PR and its live head (`7` /
`11`). Resolve the preview comment for `--app` (paginated sweep; anchor absent → `16`, anchor
present but unparseable → `11`). **Bind the preview to the head**: the comment's deployed SHA
must equal the live head — a preview that lags the push is `12`, because pixels of an old tree
bound to a new SHA are the stale-verdict class at the capture seam. For each `--surface`, in the
provisioned headless browser at the machinery's default viewport: navigate to
`<previewUrl><route>`; status ≥ 400 or failed navigation is **unreachable** (`14`); an uncaught
page exception is **crashed** (`13`); otherwise screenshot full-page to `<set>/<route-slug>.png`
and validate (exists, non-zero bytes, decodable, non-zero area — `15` on any failure).
`console.error` output is **recorded per capture in `pageErrors`, never a gate outcome** — the
crash/advisory split is the machinery's page-error module, and an empty list is only ever
written from a successfully-read error channel (v1's extractor returned empty on a parse failure,
fusing "no crashes" with "never looked"). **Write the set manifest** `<set>/manifest.json`,
byte-identical to the stdout JSON — `post` reads the set through it, and a set without its
manifest is not a set.

Exit 0 requires **every** requested surface captured and valid. `12` and `16` are run-level
refusals decided before the per-surface loop and never mix with its outcomes. When per-surface
outcomes mix, the reported code is the smallest applicable of `13`/`14`/`15` and stderr carries
every surface's outcome — the code routes, the stderr enumerates. Dropping a surface is the skill's explicit
re-invocation without it, on the record; never the tool's tolerance.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed |
| `10` | `--out` not kebab-case, or a `--surface` carries the reserved `:state` suffix |
| `11` | the PR/head/comment read failed; the preview comment is present but malformed for `--app`, or `--app` is omitted while the comment names several apps; the browser provision is broken; or a capture's validity could not be determined |
| `12` | proven: the preview comment's deployed SHA is not the PR's live head — stale preview; re-render after the preview catches up |
| `13` | proven: at least one surface threw an uncaught page error |
| `14` | proven: at least one surface is unreachable (status ≥ 400, failed navigation, no route, dark flag, gated tier) |
| `15` | proven: at least one capture is invalid (zero bytes, undecodable, zero area) |
| `16` | proven: no comment carrying the preview anchor exists on the PR — this repo, or this PR, has no preview to judge |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui render: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui render: PR #<n> is closed — nothing to judge.` | 7 | refusal |
| `review-ui render: --surface "<id>" carries a :state suffix — states are a reserved grammar, not yet realized; render the bare route.` | 10 | refusal |
| `review-ui render: --out "<value>" is not a kebab-case set name.` | 10 | refusal |
| `review-ui render: cannot read <what> for #<n>: <reason> — the render is UNKNOWN.` | 11 | refusal |
| `review-ui render: the preview comment names apps <list> — pass --app to pick one.` | 11 | refusal |
| `review-ui render: the preview comment carries the anchor but no parseable URL + SHA for app "<app>" — a malformed announcement is unreadable, not absent.` | 11 | refusal |
| `review-ui render: the preview deploys <deployed-sha7>, the live head is <head7> — stale preview; pixels of an old tree must not bind a new head (#4808's class).` | 12 | refusal |
| `review-ui render: surface "<id>" threw during render: <first page error> — the render is red; a broken page is not composition to judge.` | 13 | refusal |
| `review-ui render: surface "<id>" is unreachable at the preview (<reason>) — judge what renders, and hold the gap against the PR's Deviations (#4305).` | 14 | refusal |
| `review-ui render: surface "<id>" captured invalid bytes (<detail>) — a capture nobody can open is not evidence (#3925's class).` | 15 | refusal |
| `review-ui render: no preview-deploy comment on PR #<n> — nothing to judge without running the PR's code; the run is CANT-SEE.` | 16 | refusal |

**Scope** — exactly the `--surface` operands against one PR's announced preview. Zero operands
is `1`, so "rendered nothing, found nothing wrong" is unrepresentable (ADR 0092). The
per-surface outcome enumeration goes to stderr on every path, success included.

**Examples**

```
$ fabrika review-ui render --pr 4321 --out judged --surface /pano
{"set":"judged","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://phoenix-pr-4321.kampus.workers.dev","captures":[{"surface":"/pano","path":"/tmp/fabrika-review-ui/4321-03135b91/judged/pano.png","width":1280,"height":2140,"sha256":"9c41…","pageErrors":[]}]}
```

```
$ fabrika review-ui render --pr 4321 --out judged --surface /pano --surface /yonetim
review-ui render: surface "/pano" captured: 1280x2140, 0 page errors
review-ui render: surface "/yonetim" is unreachable at the preview (status 404) — judge what renders, and hold the gap against the PR's Deviations (#4305).
$ echo $?
14
```

**Grounding**

- #3925 / v1 S1–S2 — v1's capture invocation carried no status assertion and no capture-count
  check: a crashed helper meant zero surfaces judged, zero violations, PASS. Here full success is
  the only `0`, and every shortfall is a named proven code.
- v1 S22 — the preview resolver took the first `workers.dev` URL anywhere in the comment (wrong
  app on multi-app comments), hardcoded the domain, and read one unpaginated page. The resolver
  module reads the app sub-line, any domain, paginated.
- #4808's class / ADR 0058 — the deployed-SHA-equals-head bind (`12`): v1 never checked that the
  preview it judged was the head it stamped.
- #2594 (via the machinery's page-error module) — an uncaught exception is a red render (`13`),
  never a screenshot judged as composition; `console.error` stays advisory data.
- #4305 — unreachable is a per-surface proven outcome (`14`) the skill must dispose of loudly,
  never a silent skip; the disclosure fork (Deviations-named vs undisclosed) is the skill's.
- v1 S4 — v1's captures lived in an unrecorded `mktemp -d`: a PASS whose evidence upload failed
  was unauditable. The set path here is deterministic from PR + head, and the manifest records it.

---

## `review-ui post`

**Invocation**

```
fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged [--carrier marker|advisory] [--repo <owner/name>]
```

The verdict body arrives on **stdin only** — no `--body`, no `--body-file`, for the sibling
groups' reason: a path flag is how a machine-local path reaches a public surface while the
poster reads success.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--polarity` | enum | yes | — | `PASS` or `FAIL` — a third token is not a polarity |
| `--sha` | string | yes | — | the head the reviewer actually inspected (7–40 lowercase hex) |
| `--clause` | string | yes | — | the human clause; blank is not a clause |
| `--evidence` | string | yes | — | the `review-ui render` capture-set name whose verified upload is this verdict's evidence |
| `--carrier` | enum | no | `marker` | `marker` (first-line SHA-bound marker) or `advisory` (§CP: advisory first line, `Reviewed-head: @ <sha>` body line). `advisory` is a PASS path only |
| `--repo` | string | no | resolved | the repository |
| stdin | markdown | yes | — | the verdict body below the first line: per-row findings with pixel evidence, the coverage table, advisories |

There is no `--namespace`: this verb emits `review-ui` and nothing else. The one-namespace group
is the structural form of "a gate never emits a namespace it did not judge" — the refusal
`review post` makes at runtime is unrepresentable here.

**Output** — machine. One JSON object:
`{"answer":"posted","namespace":"review-ui","polarity":"FAIL","sha":"03135b91","upsert":"created","carrier":"marker","surfaces":1,"commentUrl":"…"}`
— `surfaces` is the count of captures in the `--evidence` set's manifest.

**What the operation does, in order — each step gates the next.**

1. **Resolve the PR and re-resolve the live head.** `--sha` not prefix-matching it is the `12`
   refusal: a verdict formed over a moved-past tree is re-reviewed, never re-bound.
2. **Read the evidence set through its manifest** (`<set>/manifest.json`; a named set with no
   manifest or one that does not parse is `4` — a set without its readable manifest is not a
   set, the `ui evidence` whole-file rule; an evidence-less verdict must not land). **Refuse on `12` when the set's recorded head is not `--sha`**: stale
   captures under a new head are the stale-note class; re-render, then re-post.
3. **Re-validate every capture against its manifest sha** (`15` on mismatch or invalidity).
4. **Upload every capture and verify each upload individually, before anything posts** — the
   two-tier store exactly as `ui evidence` specifies it (store tier when the repo declares one;
   the GitHub user-attachment tier otherwise, each upload probed back). The tier choice reads
   `design-harness.json` at the repo root the delivery layer resolves — the reviewer's own
   checked-out tree, never the PR head, which this skill never checks out. Any failure is `17`,
   aggregated, **nothing posted**. This inverts v1's posture at the seam #3925 named: ADR 0165's
   judge-the-local-bytes stands — the pixels you judged were local — but the *marker* does not
   land over a broken evidence channel. The upload stopped being decoration and became a
   precondition of the verdict's existence.
5. **Compose the comment**: first line through the wire format's `emit` (namespace `review-ui`,
   `--polarity`, `--sha`, `--clause`), or with `--carrier advisory` the fixed advisory line plus
   the `Reviewed-head: @ <sha>` body line; `advisory` with FAIL is a `10` refusal (a §CP FAIL
   posts the ordinary FAIL marker). Below it, the stdin body, then the evidence gallery — per
   surface, the verified hosted URL.
6. **Leak-scan the assembled comment** (`5` / `6` — the imported predicates; a finding that must
   cite a leak cites it by class root or repo-relative form).
7. **Upsert one comment for this namespace under this carrier** (the disjoint marker/advisory
   match keys, exactly as `review post` step 5 specifies them); a second stacked marker is
   un-anchored and fail-closes a passing PR.
8. **Read it back, unconditionally, from live PR state** — the format's `read` (or the advisory
   anchors), then the whole comment through `normalizeForReadback` (`9` on mismatch). A
   read-back that trusts a carried variable re-ships the false-PASS class.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty verdict body would read as ungated |
| `4` | the `--evidence` set's `manifest.json` is absent or does not parse, or `design-harness.json` (the tier-choice read) exists but violates its schema — whole-file rule |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference — the body never arrived |
| `7` | the PR is proven absent (404) or closed |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this marker |
| `10` | a bad `--polarity`; `--carrier advisory` with `--polarity FAIL`; a `--carrier` off its enum |
| `11` | a precondition read failed — the PR, the live head, the evidence set's files, or the upload target's state; nothing was uploaded or posted |
| `12` | refused: the live head moved past `--sha`, or the evidence set was rendered at a different head — the verdict or its pixels would bind a tree that is not the PR |
| `15` | proven: a capture in the evidence set is invalid or fails its manifest sha |
| `17` | proven: at least one evidence upload or its verification failed — nothing was posted |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui post: no body on stdin — an empty verdict reads as ungated; pipe the verdict body in.` | 3 | refusal |
| `review-ui post: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review-ui post: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui post: PR #<n> is closed — a verdict on a closed PR gates nothing.` | 7 | refusal |
| `review-ui post: --polarity must be PASS or FAIL — got "<v>".` | 10 | refusal |
| `review-ui post: --carrier advisory is a PASS path only — post the FAIL marker instead.` | 10 | refusal |
| `review-ui post: cannot read <what> for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: evidence set "<set>" has no readable manifest.json (<absent|parse reason>) — a set without its manifest is not a set; re-run review-ui render.` | 4 | refusal |
| `review-ui post: design-harness.json exists but does not satisfy its schema: <first violation> — the tier choice is unmakeable.` | 4 | refusal |
| `review-ui post: the live head is <live>, not <sha> — the tree you judged is gone; re-review at <live> (ADR 0058).` | 12 | refusal |
| `review-ui post: evidence set "<set>" was rendered at <set-head7>, you are posting at <sha7> — stale pixels; re-render at the live head.` | 12 | refusal |
| `review-ui post: capture "<id>" in set "<set>" is invalid or fails its manifest sha (<detail>).` | 15 | refusal |
| `review-ui post: upload failed for <k> of <m> captures (<first surface>: <reason>) — refusing to post a verdict over a broken evidence channel (#3925).` | 17 | refusal |
| `review-ui post: the assembled comment carries a machine-local path at line <k> (<class>) — cite it repo-relative or by class root.` | 5 | refusal |
| `review-ui post: create/edit failed: <reason> — UNKNOWN whether the verdict landed; run \`fabrika review verdicts <n>\` before retrying.` | 8 | refusal |
| `review-ui post: posted, but the read-back does not yield this marker (<wire reason>) — inspect comment <id>.` | 9 | refusal |

**Scope** — one PR (its live head, its comments), one evidence set (its manifest and every
capture in it), the caller's stdin. Steps 1–4 failing on a read is `11` — nothing written,
outcome known-unwritten.

**Examples**

```
$ fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged < verdict.md
{"answer":"posted","namespace":"review-ui","polarity":"FAIL","sha":"03135b91","upsert":"created","carrier":"marker","surfaces":1,"commentUrl":"https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5154902211"}
```

```
$ fabrika review-ui post 4321 --polarity PASS --sha 03135b91 --clause "ok" --evidence judged < verdict.md
review-ui post: the live head is a1b2c3d4, not 03135b91 — the tree you judged is gone; re-review at a1b2c3d4 (ADR 0058).
$ echo $?
12
```

**Grounding**

- #3925 / v1 S1, S24, and the `never`-typed upload channel
  (`packages/fabrika-cli/src/capture/upload.ts` — every transport failure degraded to
  `{hostedUrl: null, uploadError}` and no consumer ever read `uploadError`): the upload outcome
  was advisory by contract, so a 100%-failed channel decorated months of PASSes. Step 4 makes it
  a precondition; `17` is this contract's reason to exist.
- ADR 0165 stands, inverted at the right seam: the *judged* source stays the local bytes; what
  changed is that the *verdict* cannot exist without its verified public evidence — audit trail
  and gate outcome stop being separable.
- v1 S14 — the comment id was `awk '{print $2}'` over a prose line; here the answer is one JSON
  object and the read-back is the format's own `read`.
- #3173's class — the single sanctioned emit with unconditional live-state read-back; a
  hand-rolled `gh api` marker post is the incident, not an alternative.
- ADR 0151 / ADR 0226 — the advisory carrier's fixed shape and its PASS-only rule, matched with
  `review post` so §CP reads one grammar across the review family; #4582's discarded-answer leg
  is gone because membership is the carrier input, never computed here.
- v1 S23 — the can't-gate plain note invisible to the ship layer: this verb never posts a
  "partial" verdict; the can't-see states live in `render`'s codes and the skill's CANT-SEE
  terminal, where the empty namespace fail-closes shipping by construction.

---

## `review-ui note`

**Invocation**

```
fabrika review-ui note 4321 [--repo <owner/name>]
```

The note body arrives on **stdin only**, for the same reason as `post`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--repo` | string | no | resolved | the repository |
| stdin | markdown | yes | — | the note body: the proven blocker state (can't-see, escalation) and its evidence |

**Output** — machine. One JSON object:
`{"answer":"noted","pr":4321,"commentId":512399,"commentUrl":"…"}`.

**The mechanism, in order.** Resolve the PR (`7`/`11`). Read stdin (`3` on empty). **Refuse a
body whose first non-blank line parses as a verdict marker or an advisory carrier line** (`10`) —
this verb exists so the can't-see state has a sanctioned write that is *structurally not* a
verdict; a marker smuggled through it would be an un-read-back gate emission (v1's plain-note
off-ramps were invisible to the ship layer precisely because nothing typed them, and the cure is
a typed non-verdict, not a second marker path). Leak-scan (`5`/`6`). Post one new comment
(append-only — a blocker note is a dated fact, never edited in place). Read it back through
`normalizeForReadback` (`9` on mismatch; `8` on an unproven write).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `5` | the note carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the PR is proven absent (404) or closed |
| `8` | the post failed — UNKNOWN whether it landed |
| `9` | the comment landed but does not read back as sent |
| `10` | the body's first line parses as a verdict marker or advisory line — a verdict must go through `review-ui post` |
| `11` | a precondition read failed — nothing was posted |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui note: no body on stdin.` | 3 | refusal |
| `review-ui note: the note carries a machine-local path at line <k> (<class>).` | 5 | refusal |
| `review-ui note: the body is a bare "@" path reference — send its bytes on stdin.` | 6 | refusal |
| `review-ui note: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui note: PR #<n> is closed.` | 7 | refusal |
| `review-ui note: the post failed: <reason> — UNKNOWN whether the note landed; re-read the PR before retrying.` | 8 | refusal |
| `review-ui note: the comment landed but does not read back as sent — inspect comment <id>.` | 9 | refusal |
| `review-ui note: the first line parses as a verdict carrier (marker or advisory line) — a verdict goes through review-ui post, never this verb.` | 10 | refusal |
| `review-ui note: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |

**Scope** — one PR, one comment write, the caller's stdin.

**Example**

```
$ fabrika review-ui note 4321 <<'EOF'
review-ui cannot see this PR: no preview-deploy comment exists, so there is nothing to judge
without running the PR's code. The review-ui namespace is deliberately left empty (fail-closed
at ship). Unblock by restoring the preview deployment for this PR.
EOF
{"answer":"noted","pr":4321,"commentId":512399,"commentUrl":"https://github.com/kamp-us/phoenix/pull/4321#issuecomment-512399"}
```

**Grounding**

- v1 S23 — the can't-gate "plain note" had no sanctioned emit path and no read-back; a typed
  non-verdict write is the smallest cure that does not mint a second marker grammar.
- #3173's class — every write this skill makes goes through a verb with a read-back; a bare
  `gh api` comment is the incident, whatever the comment says.
- #4305 — the can't-see declaration this verb carries is the "review-ui can't-gate note"
  mechanism that decision names, supplied as a seam; whether it later becomes a machine-read
  state is that open decision's to rule, and the typed refusal of marker-shaped bodies keeps
  this verb from pre-empting it.

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own the group-local rows; the universal `0/1/126/127`
live once in the shared matrix, which owns every code's single meaning); every error names
message, stream, and code; every verb states scope and zero-scope behavior (`render` refuses
zero surfaces at `1`; `post` refuses an empty body at `3` and an unreadable evidence set at
`4`/`11`; `note` refuses an empty body at `3` and a verdict-shaped body at `10`); and no clause
defers to a v1 script, another skill's prose, or the authoring session —
the `review` and `build-ui` references are to sibling fabrika contracts, the sanctioned
cross-contract shape, with the `build-ui` reference flagged as pre-merge in the authoring PR.
The three hand-checks: every reachable outcome walked per verb (mixed render outcomes route by
smallest code with full stderr enumeration; the post protocol's eight steps each name their
refusal); every example value derives from stated rules (the set path from the deterministic
`<OS temp>/fabrika-review-ui/<pr>-<head8>/` rule, `previewUrl` from the comment's app sub-line);
sibling verbs guard shared preconditions identically (`render` and `post` resolve PR + live head
on the same `7`/`11` and treat capture invalidity as `15`; `render` binds preview-to-head and
`post` binds set-to-`--sha` on the same `12`; `note` shares the `7`/`11` PR resolve and the
`3`/`5`/`6`/`8`/`9` posting seats with `post`).
