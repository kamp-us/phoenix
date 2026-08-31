# `/review-ui` — derived CLI contract

**Skill:** [`review-ui`](SKILL.md) · **Authoring brief:** [#4718](https://github.com/kamp-us/phoenix/issues/4718) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`review-ui`** subcommand group, registered
in `packages/fabrika-cli/src/registry.ts` beside the shipped `adr`, `build`, `report`,
`review`, `spend`, `triage` and `wire` groups. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug. The governed localhost CI
evidence extension is recorded by [#7306](https://github.com/kamp-us/phoenix/issues/7306).

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
- **The named-gate read** is `heal-ci`'s ([`../heal-ci/contract.md`](../heal-ci/contract.md)):
  `heal-ci surface`. §5 names three design gates and needs each one's live state *by name* — the
  check-run name, the job's `name:` inside each workflow file, never its filename;
  `review ci` collapsed its check rows to a status tally under ADR
  [0308](../../../../.decisions/0308-bounded-evidence-output-shape.md), and even uncollapsed it could
  never tell a required gate that never ran from a gate the repo does not declare at all — both are
  simply no row. `surface` prints every declared required context as `producing` or `absent` and
  every undeclared gating run as `extra`, which between them is the answer §5 was always asking for.
  It changes nothing, so a reviewer may run it.
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
| `review-ui fetch` | resolve and validate the exact-head artifact for a governed localhost-only harness, then materialize it in reviewer-owned scratch | producer/run/check/artifact/manifest/integrity validation is mechanical; *looking at the fetched pixels and judging them* stays in the skill |
| `review-ui ci-produce` | trusted-workflow-only leg that runs the governed journey and creates the versioned artifact | capture and browser-error collection are mechanical; the workflow, never a reviewer or builder, supplies this leg |
| `review-ui post` | the single sanctioned `review-ui` verdict emit: verify-upload the evidence set, compose through the wire format, bind to the inspected head at post time, post one comment, read it back | upload-verify-compose-post-readback is a protocol; *the polarity and every finding behind it* are judgment |
| `review-ui note` | the single sanctioned non-verdict write: post one plain comment naming a proven blocker state (can't-see, escalation), leak-scanned, read back — never a marker | compose-scan-post-readback is a protocol; *whether the state warrants a note* is judgment |
| `review-ui route` | the single sanctioned way to resolve this namespace with no verdict: post one head-bound `routed-elsewhere` record stating that the PR renders nothing, leak-scanned, upserted, read back | binding, upsert and read-back are a protocol; *whether the diff renders anything* is judgment, and no verb may take it |

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

Every reviewer-facing `review-ui` verb obeys these; stated once. The base-owned workflow-only
`ci-produce` leg is explicitly internal, and its required identity operands are documented in its own
section.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else; scope lines,
  refusal reasons and per-surface enumerations go to stderr. A non-zero exit prints nothing on
  stdout (`verb.ts`). Every "nothing found" is a state word — v1's callers read empty stdout as
  proven-negative on three separate channels (#4493's classifier, the blessed-surfaces probe, the
  render-errors extractor).
- **Common reviewer input.** `--repo <owner/name>` (default: the resolution chain the shipped groups
  use; none resolvable → exit 1). Internal `ci-produce` does not resolve ambient repository state: its
  trusted workflow must pass required `--repository <owner/name>`, which is bound into the manifest.
  `--json` is not offered: the object is the only output shape.
- **GitHub access** per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql);
  every list read paginates and reports its scanned count on stderr. The evidence-upload
  endpoint sits outside §11's porcelain scope exactly as `ui evidence`'s attachment tier states.
- **A non-zero exit produced no answer; read its code before routing.** Proven refusals occupy
  `12`–`18`; UNKNOWN/read failures never expose a partial answer. `fetch` returns every complete
  materialized set on `0` and types it as `render: "clean" | "red"`, so a proven red set cannot be
  confused with a failed invocation. A partial capture set or upload is never a smaller success.
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
| `1` | usage/caller error when stderr is the verb's own refusal; otherwise the process failed at runtime and the result is UNKNOWN |
| `126` | no implementation could be resolved |
| `3` | stdin was read and held nothing (`post` and `note`; the aligned seat) |
| `4` | a required governed declaration, manifest, provenance receipt, artifact membership set, or other derived document is absent, malformed, or violates its schema |
| `5` | the authored text carries a machine-local path (this group offers no `--redact`; the recovery is a rewrite) |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent (404), or the PR is closed — a deliberate, declared widening of the base seat (existence-only) to closed-target, because a closed PR is provably not reviewable scope, matching the sibling `review` group's use |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match |
| `10` | a semantic refusal on an operand or body: a supplied value is off its closed vocabulary, a CI identity/root/output operand is invalid, or a `note` body starts with a verdict carrier |
| `11` | a required read or execution failed — no outcome is proven: PR/head/preview, default-branch authority, GitHub transport or token, artifact download, scratch, unzip, producer workspace/build/server/readiness/sidecar, materialization, capture validity, provenance write, or upload-target state |
| `12` | refused, proven: pixels or a marker would bind the wrong tree — a live head moved, a preview is stale, or a producer checkout does not match its named subject/authority revision |
| `13` | proven red render or invalid PASS attempt: `render` records an uncaught page error, and `post` refuses PASS over red evidence; `fetch` instead returns a complete typed `render: "red"` answer on `0` |
| `14` | proven: at least one surface is unreachable — missing HTTP response, status ≥ 400, or failed navigation; each named on stderr |
| `15` | proven: produced or fetched capture bytes are invalid — incomplete PNG structure/CRC/IEND/inflate/raster, zero area, hash/dimension mismatch, or bad set membership |
| `16` | proven: no preview deployment exists for this PR — the announced-preview convention resolves to nothing; the skill's CANT-SEE route |
| `17` | proven: at least one evidence upload or upload-verification failed — **nothing was posted** |
| `18` | proven: the governed localhost producer has no usable exact-head run, check, or artifact; the evidence is unavailable, not UNKNOWN |
| `127` | the verb never ran at all (unresolved binary) |

**`7` versus `11`** is the package's spine: a 404 is a fact about the repository, an unreachable
GitHub is not a fact about anything; no message here reads "does not exist, or is not readable".
**`12` fuses two triggers deliberately and one meaning binds them** — *the pixels or the marker
would bind a tree that is not the PR* — because the caller's move is identical (re-render /
re-review at the live head), where `13`/`14`/`15`/`16` each route differently and stay four codes.
**`16` is not `7`**: the PR exists; what is proven absent is the repo's ability to show it — a
routable can't-see state the skill acts on by name, the #4305 declaration made mechanical.

## Required environment — the three render paths

Per the tandem ruling (both briefs, 2026-08-09), declared identically to `build-ui`:

- **Default path (required): the headless capture machinery** — the fabrika-owned capture
  package (#5063) driving a headless browser at the **preview deployment's URL**. The browser
  dependency ships with the verb package (founder preference: default-available beats
  install-a-thing); a missing or broken provision at run time is `11` with the remediation in
  the message. This is the ordinary preview evidence producer. The governed localhost exception
  below is the other sanctioned capture producer.
- **Interactive path (optional): the connected Chrome browser.** When the session's tool surface
  carries the `claude-in-chrome` tools, the *skill* may inspect the preview live. Detection is
  tool presence, decided by the model; no verb probes for Chrome, no env var, and no `review-ui`
  verb changes behavior based on it. Chrome absent means the default path, silently.
- Chrome output never enters `review-ui post --evidence`: evidence comes from `review-ui render`
  capture sets or `review-ui fetch` sets, so neither interactive output nor a local import can enter.
- **Governed localhost path (exception): trusted CI.** A harness declared by the repository default
  branch may be rendered by the fixed `pull_request_target` workflow/check at the PR's exact head.
  The reviewer downloads with `review-ui fetch`; the reviewer session never runs the PR code.
- **`:auth` surfaces need two environment values**, both unset by default: `PREVIEW_TEST_SESSION_TOKEN`
  (the session token `preview-seed test-account` wrote onto the preview D1) and `BETTER_AUTH_SECRET`
  (the preview worker's, so the cookie signature verifies). With neither or one set, an `:auth`
  request refuses `11` rather than substituting the anonymous render; with no `:auth` surface asked
  for, every surface renders anonymously as before. Setting both is necessary and not sufficient —
  whether the cookie authenticated is the per-shot session proof's answer, also an `11`.
- **`--flag` needs those same two values plus one grant on the preview D1.** The override cookie is
  honored only for a platform admin (`flagship/override-authz.ts`, unchanged by #7218), and
  `preview-seed test-account` provisions moderation authority, not admin. So a forced run is
  preceded by `node packages/admin-grant/src/bin.ts grant --user-id preview-test-moderator
  --database-id <preview-d1>` — offline and direct-D1, on a throwaway preview only, never against a
  database holding real accounts. The grant is what makes the forced capture an admin's view as well
  as a moderator's, which is the trade the operand asks for and the reason it is not the default.

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

## `review-ui fetch`

**Invocation**

```
fabrika review-ui fetch <pr> --harness <declared-id> --out <kebab-set> [--repo <owner/name>]
```

**Inputs**

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `<pr>` | positive integer | yes | — | the pull-request number this verb acts on |
| `--harness` | governed kebab-case id | yes | — | a localhost-only harness declared by the repository's governed authority |
| `--out` | kebab-case string | yes | — | kebab-case reviewer-owned capture-set name |
| `--repo` | `owner/name` | no | resolved | the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote) |

There are no workflow, check, run, artifact, manifest, receipt, or local-path operands. Preview is the
default path; this verb selects only a declared localhost exception.

**Output** — machine channel. One newline-terminated JSON object on complete success:

```
{"answer":"fetched","render":"clean","set":"judged","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","run":42,"artifact":51,"check":61,"surfaces":2,"captures":[{"surface":"tuval-cockpit-desktop","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pageErrors":{"rows":[],"more":0}},{"surface":"tuval-cockpit-mobile","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-mobile.png","width":390,"height":844,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0}}]}
```

Paths are outputs, never inputs. Their directory is derived as
`<os.tmpdir()>/fabrika-review-ui/<pr>-<first-8-head-characters>/<set>/`; each capture appends its
manifest member path. The byte-exact examples in this section fix `os.tmpdir()` to `/tmp`, so PR
`7190`, head `03135b91…`, set `judged`, and member
`captures/tuval-cockpit-desktop.png` derive
`/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-desktop.png` without an
unresolved placeholder. The operation resolves the repository default branch to one exact commit,
reads the declaration from that commit, and admits only a successful completed
`pull_request_target` run whose Actions `head_sha` is the full PR head. The base authority is a
separate identity: it comes from the producer's checked-out `${{ github.sha }}` and must equal the
current default-branch revision in the downloaded manifest. The workflow's base-owned `run-name`
binds the PR number, full subject head, and `${{ github.sha }}` authority because
`pull_request_target` run listings may carry an empty `pull_requests` array; the exact title,
Actions `head_sha`, and current authority must agree. It then resolves exactly one successful named check
and one artifact whose `expired` field is present, boolean, and false. GitHub's authoritative REST OpenAPI
`Artifact` schema makes `expired` required,
types it as boolean, and defines it as whether the artifact has expired
([property](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141550-L141553),
[required list](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141602-L141612)).
The consumer rejects unsafe or duplicate zip members, then requires the complete member set to equal
`manifest.json` plus every manifest-declared PNG. It validates every declared surface, route, and
state exactly once *before* any set comparison can collapse duplicates. Unreadable error coverage,
bad dimensions, and hash mismatches all refuse.

After re-reading the live head, `fetch` copies the captures and the artifact's original manifest
bytes into reviewer-owned scratch. It writes a receipt carrying the observed run, check, artifact,
and manifest hash. The artifact allowlist excludes that receipt, but the receipt is not authority by
itself: `post` re-downloads the selected artifact and byte-compares the members.

There is no empty successful answer. Every accepted artifact prints one typed JSON answer with
`render` equal to `clean` or `red`. An uncaught page error therefore remains proven red evidence on
exit `0`; it cannot be confused with a refusal that produced no answer. Every capture path and its
bounded error evidence are present in that answer for inspection before posting FAIL.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the validated set and receipt were materialized and the JSON answer was printed with `render` equal to `"clean"` or `"red"` |
| `1` | invocation/flag parsing failed, or `<pr>` is not a positive pull-request number |
| `4` | default-branch declaration, artifact manifest, producer binding, members, surface cardinality, or receipt materialization schema is malformed |
| `7` | PR is proven absent or closed — zero scope |
| `10` | `--harness` or `--out` is off vocabulary |
| `11` | repository, GitHub transport/token, default-branch authority, declaration read, download, scratch, unzip, response-shape, or runtime state is UNKNOWN |
| `12` | live head moved before materialization |
| `15` | capture bytes fail complete PNG decoding (chunk structure/CRC/IEND/inflate/raster), hash, or dimension validation |
| `18` | proven: no unique successful exact-head run, named check, or non-expired artifact is currently usable |

Caller routing is code-only: `10` corrects the operand and refetches; `12` reads the moved live head
and refetches; `4`, `15`, and `18` are proven evidence-unavailable CANT-SEE paths; `7` is proven
zero-scope CANT-SEE; `11`, `1`, `126`, `127`, and unlisted codes are UNKNOWN with no evidence
answer, marker, or note and route to the supervisor. Stderr is diagnostic data, never a routing key.

**Errors**

| Message class (stderr) | Code | Kind |
|---|---|---|
| `review-ui fetch: <n> is not a pull-request number.` | `1` | usage error |
| `review-ui fetch: --out "<value>" is not a kebab-case set name.` | `10` | refusal |
| `review-ui fetch: "<id>" is not a governed localhost-only harness.` | `10` | refusal |
| `review-ui fetch: PR #<n> not found...` / `is closed...` | `7` | refusal |
| `review-ui fetch: cannot read PR #<n>: <reason>.` | `11` | refusal |
| `review-ui fetch: .github/review-ui-localhost-harnesses.json is absent at authority revision <sha>.` | `4` | refusal |
| `review-ui fetch: the governed localhost declaration is malformed (<reason>).` | `4` | refusal |
| `review-ui fetch: the artifact has unsafe, duplicate, extra, incomplete, or malformed members.` | `4` | refusal |
| `review-ui fetch: trusted CI evidence is proven unavailable (<reason>).` | `18` | refusal |
| `review-ui fetch: <TransportUnknown\|TokenUnknown\|AuthorityReadUnknown\|ScratchUnknown\|UnzipUnknown\|RuntimeUnknown> (<reason>) — the evidence state is UNKNOWN.` | `11` | refusal |
| `review-ui fetch: the CI capture manifest is malformed (<reason>).` | `4` | refusal |
| `review-ui fetch: the artifact manifest does not bind the governed producer, exact authority revision, declaration, repository, PR, and exact live head.` | `4` | refusal |
| `review-ui fetch: the artifact contains a surface more than once.` | `4` | refusal |
| `review-ui fetch: the artifact does not contain every declared <harness> surface, route, and state exactly once.` | `4` | refusal |
| `review-ui fetch: capture <surface> fails its hash or dimensions.` | `15` | refusal |
| `review-ui fetch: PR #<n> moved from <old> to <new> before the evidence set was accepted.` | `12` | refusal |

**Scope** — one open PR, one default-branch declaration, one declared harness, one
exact-head run/check/artifact tuple, and one output set. A missing or closed PR is `7`; no harnesses,
no matching run, no matching check, or no matching artifact is never success and never an empty set.

**Examples**

With the committed Tuval declaration, a live head `03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c`, run `42`, check `61`, artifact `51`, desktop hash of 64 `a` characters, and mobile hash of 64 `b` characters:

```
$ fabrika review-ui fetch 7190 --harness tuval --out judged
{"answer":"fetched","render":"clean","set":"judged","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","run":42,"artifact":51,"check":61,"surfaces":2,"captures":[{"surface":"tuval-cockpit-desktop","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pageErrors":{"rows":[],"more":0}},{"surface":"tuval-cockpit-mobile","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-mobile.png","width":390,"height":844,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0}}]}
```

With the same validated tuple and one recorded uncaught page error, the answer keeps the same
shape but prints `"render":"red"` and the page-error row in its capture. This accepted red set exits
with status `0`; the reviewer inspects it and posts FAIL.

**Grounding**

- ADR 0165 amendment — the default-branch declaration and exact-head GitHub tuple are the only CI evidence authority.
- #7306 — local paths, builder manifests, caller-selected producers, stale heads, and unreadable evidence fail closed; uncaught page errors stay red renders.
- ADR 0058 — a moved head invalidates the fetched set instead of rebinding it.

---

## `review-ui ci-produce`

**Invocation**

```
fabrika review-ui ci-produce <pr> --head <40-hex> --authority-head <40-hex> --harness <id> --run-id <positive-int> --repository <owner/name> --subject-root <exact-head-checkout> --authority-root <trusted-base-checkout> --output-dir <trusted-host-output>
```

**Inputs**

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `<pr>` | positive integer | yes | — | the pull-request number this verb acts on |
| `--head` | lowercase 40-hex string | yes | — | the exact lowercase 40-character PR head checked out as the subject |
| `--authority-head` | lowercase 40-hex string | yes | — | the exact default-branch authority revision checked out as trusted code |
| `--harness` | governed kebab-case id | yes | — | the localhost harness id from the trusted declaration |
| `--run-id` | positive integer | yes | — | the positive GitHub Actions run id bound into the manifest |
| `--repository` | `owner/name` string | yes | — | the owner/name repository identity bound into the manifest |
| `--subject-root` | absolute path string | yes | — | the exact-head subject input to the trusted image recipe |
| `--authority-root` | absolute path string | yes | — | the trusted base checkout containing the declaration and producer |
| `--output-dir` | absolute path string | yes | — | the trusted host directory where captures and manifest are written |

This is an internal workflow interface, not a reviewer import. Its required `--repository` is a
workflow-supplied identity and intentionally does not implement the reviewer-facing optional `--repo`
resolution contract. Before image construction, the producer rejects any root `.dockerignore` in
the exact-head subject checkout, so PR-controlled context rules cannot omit changed source while the
manifest still names the full head. Image construction pins pnpm 10.27.0 and performs `pnpm fetch
--ignore-scripts --ignore-pnpmfile` as the unprivileged `node` user. The
version-matched behavior is grounded in pnpm's
[`fetch` implementation](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/plugin-commands-installation/src/fetch.ts#L47-L76),
[config loader](https://github.com/pnpm/pnpm/blob/v10.27.0/cli/cli-utils/src/getConfig.ts#L39-L62),
[dependency-build gate](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1342-L1376),
and [root lifecycle gate](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1521-L1531).
The offline PR-controlled install and governed test run under a read-only root filesystem,
`--cap-drop ALL`, `no-new-privileges`, `--network none`, two CPUs, 4 GiB memory with no swap
headroom, 256 PIDs, a 4 GiB tmpfs-backed disposable test workspace, and a 64 MiB unprivileged
tmpfs for pnpm's project-state symlink under its otherwise read-only home. The 4 GiB memory and
workspace ceilings and a 1 GiB browser temporary-filesystem ceiling are the measured bounds needed
by Tuval's existing `test:browser` journey; the prior 2 GiB memory/workspace and 64 MiB browser
filesystem bounds produced Docker OOM, no-space, and Chromium crash results for that exact command. The
journey's own dynamic-port servers
exit with their Playwright cases before the later fixed capture server starts, so the producer never
runs two conflicting Tuval servers concurrently. Capture output uses a
separate 256 MiB tmpfs volume and a fixed base-owned extraction container, so the artifact-directory
copy cannot exceed that bound. Every foreground container has a deterministic run-scoped name.
Cleanup is attempted sequentially for every named container, bounded volume, image, and the trusted
fixture root after success, refusal, or client timeout; exact Docker kind/name absence is the only
ignored nonzero response. A cleanup failure cannot turn an otherwise successful operation into
success: it returns UNKNOWN on `11`. When the operation was already nonzero, its original code and
diagnostics remain and the cleanup diagnostic is appended. Fixture cleanup ownership begins when
its temporary root is created, so partial directory, file, or permission setup receives the same
attempted removal and reports both setup and cleanup failures when both occur. That workspace is
never served. A
separate server workspace is freshly copied from the image's immutable
exact-head source, installed offline with both install-time execution-disabling flags, and then run
through the declaration's fixed `serverBuildCommand` under the same no-network isolation. The
resulting built workspace is mounted read-only into the server, which also has no network beyond
loopback and publishes no host port. A
base-owned capture sidecar runs with `--network container:<server>`, sharing only that isolated
network namespace so its browser reaches the server's loopback without gaining external network.
Both browser-bearing containers receive the same bounded 1 GiB `/tmp` plus a 64 MiB unprivileged
font/browser-cache tmpfs; the server, preparation, extraction, and keeper containers keep the 64 MiB
`/tmp` default.
Docker documents that the `none` driver leaves only loopback
([none driver](https://docs.docker.com/engine/network/drivers/none/)) and that container networking
shares another container's networking stack
([container networks](https://docs.docker.com/engine/network/#container-networks)). The PR server
receives no Actions credentials, authority checkout, Docker socket, or output mount. The trusted
sidecar receives the authority checkout read-only and the prepared capture output only; the host
validates those captures and alone writes the manifest.

**Output** — machine channel. On complete success, one newline-terminated version-1 CI manifest.
There is no empty successful answer. The producer first proves both the subject and authority
checkouts against their full supplied heads. The object binds the declaration and producer identity,
including that authority revision, then one capture row per declared surface with its route and
state. Before writing that manifest, every capture must prove a successful HTTP navigation response
in the 2xx or 3xx range and pass the delegated PNG decoder: the complete chunk stream, every CRC,
terminal IEND, compressed pixel stream, raster dimensions, and absence of truncation/trailing bytes
must decode. An absent response, 4xx, or 5xx refuses as unreachable on `14`. The three-row error
bound
truncates every row to 1,024 UTF-16 code
units and orders all uncaught `pageerror` rows before `console.error` rows, so console noise cannot
hide the hard-fail kind in `more`. A successful journey whose later browser capture records an
uncaught page error is still a successful transport output, so the workflow uploads it; `review-ui
fetch` materializes that evidence and returns a typed `render: "red"` answer on exit `0`. A governed journey command that
itself fails stops before server start, capture, manifest creation, and artifact upload:

```
{"schemaVersion":1,"source":"github-actions","repository":"kamp-us/phoenix","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","declarationSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","producer":{"workflow":".github/workflows/review-ui-localhost-evidence.yml","check":"review-ui localhost evidence / tuval","event":"pull_request_target","runId":42,"artifact":"review-ui-localhost-tuval","authorityHead":"cccccccccccccccccccccccccccccccccccccccc"},"captures":[{"surface":"tuval-cockpit-desktop","route":"/","state":"desktop","path":"captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0},"errorCoverage":{"pageerror":"readable","consoleError":"readable"}}]}
```

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the complete manifest was written to the trusted output and printed |
| `1` | invocation/flag parsing failed, including a missing required input or invalid PR operand |
| `4` | the governed declaration is malformed |
| `10` | subject head, authority head, run id, repository, harness, non-absolute root operand, output placement, or a subject root `.dockerignore` is off vocabulary |
| `11` | declaration, fixture, output, image, workspace, governed journey command, server, sidecar, capture, manifest write, or otherwise-successful cleanup is unreadable/UNKNOWN |
| `12` | the subject or authority checkout is not its named full head |
| `14` | capture navigation returned no HTTP response, 4xx, or 5xx |
| `15` | captured bytes do not completely decode as PNG or do not match the declared capture |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui ci-produce: <n> is not a pull-request number.` | `1` | usage error |
| `review-ui ci-produce: --head must be one full lowercase 40-character SHA.` | `10` | refusal |
| `review-ui ci-produce: --authority-head must be one full lowercase 40-character SHA.` | `10` | refusal |
| `review-ui ci-produce: --run-id must be a positive Actions run id.` | `10` | refusal |
| `review-ui ci-produce: --repository must be one owner/name.` | `10` | refusal |
| `review-ui ci-produce: --subject-root, --authority-root, and --output-dir must be absolute paths.` | `10` | refusal |
| `review-ui ci-produce: cannot read the governed declaration: <reason>.` | `11` | refusal |
| `review-ui ci-produce: the governed declaration is malformed (<reason>).` | `4` | refusal |
| `review-ui ci-produce: "<id>" is not a governed localhost harness.` | `10` | refusal |
| `review-ui ci-produce: the subject checkout is <read>, not <expected>.` | `12` | refusal |
| `review-ui ci-produce: the authority checkout is <read>, not <expected>.` | `12` | refusal |
| `review-ui ci-produce: the exact-head subject must not contain a root .dockerignore.` | `10` | refusal |
| `review-ui ci-produce: cannot prove the exact-head subject has no root .dockerignore.` | `11` | refusal |
| `review-ui ci-produce: --output-dir must be outside both the subject and authority checkouts.` | `10` | refusal |
| `review-ui ci-produce: cannot create the trusted fixture (<setup reason>[; fixture cleanup failed (<cleanup reason>)]).` | `11` | refusal |
| `review-ui ci-produce: the trusted output cannot be cleared.` | `11` | refusal |
| `review-ui ci-produce: the isolated subject image could not be built (<reason>).` | `11` | refusal |
| `review-ui ci-produce: the isolated subject workspace could not be created.` | `11` | refusal |
| `review-ui ci-produce: the governed browser journey failed (<reason>).` | `11` | refusal |
| `review-ui ci-produce: the fresh exact-head server workspace could not be prepared.` | `11` | refusal |
| `review-ui ci-produce: the isolated subject server could not start.` | `11` | refusal |
| `review-ui ci-produce: Docker returned no subject container id.` | `11` | refusal |
| `review-ui ci-produce: the isolated subject server did not reach readiness (<terminal state>; <requested and observed identity>; <inspect state and exit code>; <bounded log/command stdout and stderr bytes>).` | `11` | refusal |
| `review-ui ci-produce: the trusted capture output could not be prepared (<reason>).` | `11` | refusal |
| `review-ui ci-produce: the bounded capture workspace could not be created.` | `11` | refusal |
| `review-ui ci-produce: the bounded capture workspace could not be kept alive.` | `11` | refusal |
| `review-ui ci-produce: the trusted isolated capture sidecar failed (<reason>).` | `11` | refusal |
| `review-ui ci-produce: the bounded capture output could not be materialized.` | `11` | refusal |
| `review-ui ci-produce: the trusted localhost capture failed (<reason>).` | `11` | refusal |
| `review-ui ci-produce: the trusted capture set does not contain every declared <harness> surface exactly once.` | `15` | refusal |
| `review-ui ci-produce: capture <surface> does not match its declared route, state, and member.` | `15` | refusal |
| `review-ui ci-produce: capture <surface> navigation returned no HTTP response.` | `14` | refusal |
| `review-ui ci-produce: capture <surface> navigation returned HTTP <status>, not a successful response.` | `14` | refusal |
| `review-ui ci-produce: <surface> is not a valid capture (<reason>).` | `15` | refusal |
| `review-ui ci-produce: cannot write the capture manifest (<reason>).` | `11` | refusal |
| `review-ui ci-produce: cleanup failed (<resource diagnostic>[; ...]).` | `11` after an otherwise successful operation; appended diagnostic with the original code after an already-nonzero operation | refusal |

**Scope** — exactly one PR identity, one exact authority revision, one governed harness, and every
surface in that harness declaration. Zero scope is impossible: an unknown harness refuses on `10`, and a positive
harness with zero surfaces makes the declaration malformed on `4`. The trusted output must be
outside both checkouts. A subject root `.dockerignore` is refused before Docker receives the context.

**Examples**

Given a fixed authority declaration whose digest is 64 `a` characters and one fixed 1280×800 capture
whose digest is 64 `b` characters, the literal workflow call and stdout are:

```
$ fabrika review-ui ci-produce 7190 --head 03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c --authority-head cccccccccccccccccccccccccccccccccccccccc --harness tuval --run-id 42 --repository kamp-us/phoenix --subject-root /github/workspace/subject --authority-root /github/workspace/authority --output-dir /github/workspace/review-ui-localhost-tuval
{"schemaVersion":1,"source":"github-actions","repository":"kamp-us/phoenix","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","declarationSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","producer":{"workflow":".github/workflows/review-ui-localhost-evidence.yml","check":"review-ui localhost evidence / tuval","event":"pull_request_target","runId":42,"artifact":"review-ui-localhost-tuval","authorityHead":"cccccccccccccccccccccccccccccccccccccccc"},"captures":[{"surface":"tuval-cockpit-desktop","route":"/","state":"desktop","path":"captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0},"errorCoverage":{"pageerror":"readable","consoleError":"readable"}}]}
```

**Grounding**

- ADR 0165 amendment — base-owned producer authority and runtime isolation for PR-controlled execution.
- GitHub `pull_request_target` event reference plus [recorded run 33286961054](https://github.com/kamp-us/phoenix/actions/runs/33286961054) — the event executes base-owned workflow code while Actions reports the PR head as the run's `head_sha`; the producer manifest separately binds `${{ github.sha }}` as authority.
- #7306 — the exact head, positive manifest, bounded browser errors, and no reviewer-local execution are acceptance constraints.

See [the localhost evidence runbook](../../../../ops/runbook-review-ui-localhost-evidence.md) for the
sole workflow caller's operating sequence.

---

## `review-ui render`

**Invocation**

```
fabrika review-ui render --pr 4321 --out judged --surface /pano --surface /pano/yeni [--flag <key>=<on|off>] [--app web] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose preview is judged |
| `--out` | string | yes | — | kebab-case capture-set name; captures land under `<OS temp>/fabrika-review-ui/<pr>-<head8>/<set>/` |
| `--surface` | string, repeatable | yes (≥1) | — | a surface id: a route (`/pano`), or a route plus a realized state (`/pano:auth`); zero operands is `1` — no tool guesses surfaces from a diff |
| `--flag` | string, repeatable | no | every flag at its default | force one flag for this run: `<key>=on` or `<key>=off`; anything else, or a key forced twice, is `10` |
| `--app` | string | no | the sole app in the preview comment; ambiguity refuses on `11` | which app's sub-line of the preview comment to resolve |
| `--repo` | string | no | resolved | the repository |

A `:state` suffix is admitted **only for a state something here actually puts on screen**, and
refused on `10` otherwise. The realized set is `auth` and nothing else (#7051): an `:auth` surface
renders with the moderator-tier test account's better-auth session cookie seeded into the capture
context. The account is provisioned direct-D1 by `preview-seed test-account`, never by a worker
route.

Seeding a cookie is not the same as being signed in, so the shot proves it rather than assuming it.
From the same browser context, before the shot is classified, the verb reads the preview's own
`/api/auth/get-session` and requires a user back; anything else — a bare `null`, a non-200, an
unreadable body — refuses the surface on `11` and records no capture. This is what makes the pixels a
signed-in yazar+moderator's: a cookie that did not authenticate renders the visitor's page, and that
page is a perfectly valid PNG no byte check can tell from the real one.

**`--flag` forces a dark-shipped flag on, so the state the PR adds paints** (ADR 0336, #7218). It
rides the worker's existing `phoenix_flag_overrides` cookie — no route is added and
`flagship/override-authz.ts` is untouched — and that gate is why the operand carries a fence of its
own: on a deployed stage the cookie is honored only for a request whose actor holds platform
`Admin`, so an anonymous surface would drop it and render the default state cleanly under the
forced name. Every `--surface` in a forced run must therefore name `:auth`, and a bare route beside
a `--flag` is `10`. The preview test account holds moderation authority, not admin, so a forced run
also needs `admin-grant grant --user-id preview-test-moderator --database-id <preview-d1>` against
that throwaway preview D1 — offline, direct-D1, the same sanctioned path ADR 0107 already names.

Seeding an override is not the same as the override taking, so — like the session — the shot proves
it. From the same context, before the shot is classified, the verb POSTs the preview's own
`/api/flags/evaluate` asking each forced key with the **opposite** value as its default: a dropped
cookie answers `!forced` for every key, which is `11` naming the inert keys. A key the probe leaves
unevaluated, or a probe that cannot be read, is `11` too and is never folded into "the override was
dropped" — that would be a fact about the override read off a probe nobody could read.

The refusal on every other token is the same fence v1 stated, kept for the same reason: v1 demanded
`:focus-visible` captures with no mechanism to prove the state was realized, and a state that
silently rendered unfocused PASSed its prohibition forever. Parsing a state is not rendering one —
a token with no mechanism shoots the default pixels under a variant's name, which is coverage
claimed and not held. The sibling `ui` group renders in-tree with no preview and no session, so it
still refuses every `:state`.

**Output** — machine. One JSON object on full success only:

```
{"schemaVersion": 2, "source": "review-ui-render", "repository": "kamp-us/phoenix",
 "set": "judged", "pr": 4321, "head": "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c",
 "app": "web", "previewUrl": "https://phoenix-pr-4321.kampus.workers.dev", "flags": [],
 "captures": [
   {"surface": "/pano", "path": "<abs>/judged/pano.png", "width": 1280, "height": 2140,
    "sha256": "…", "pageErrors": {"rows": [], "more": 0}}
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
fusing "no crashes" with "never looked"). Because nothing reads a row by name, it is an
evidence-array and prints collapsed (ADR 0308): `{"rows": [<first 3>], "more": <the rest>}`, with
`more` always present so a list capped at exactly its length reads as whole. The stderr
per-surface line counts the **whole** tally, not the kept rows. **Write the set manifest** `<set>/manifest.json`,
byte-identical to the stdout JSON — `post` reads the set through it, and a set without its
manifest is not a set. Schema 2 records the fixed source, repository, app, preview URL, and exact
flag operands needed to reproduce the request. The manifest is an index, not authority: every local
file belongs to the caller. Before posting, `post` resolves the live preview announcement and
independently re-renders every recorded surface with the recorded state and flags, requiring the
fresh dimensions and bytes to match. A local key or receipt therefore authenticates nothing. Exit
`0` requires the manifest write; stdout remains the same manifest. If the write fails, partial
captures may remain but are not an accepted set and `post` rejects them.

Exit 0 requires **every** requested surface captured and valid. `12` and `16` are run-level
refusals decided before the per-surface loop and never mix with its outcomes. When per-surface
outcomes mix, the reported code is the smallest applicable of `13`/`14`/`15` and stderr carries
every surface's outcome — the code routes, the stderr enumerates. Dropping a surface is the skill's explicit
re-invocation without it, on the record; never the tool's tolerance.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed |
| `10` | `--out` not kebab-case; a `--surface` names a `:state` outside the realized set (`auth`); a `--flag` operand is not a `<key>=<on\|off>` pair, or forces one key twice; or `--flag` was passed beside an anonymous surface |
| `11` | the PR/head/comment read failed; the preview comment is malformed or ambiguous; browser provision, capture validity, auth/flag proof, or manifest write is UNKNOWN |
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
| `review-ui render: --surface "<id>" names a :state nothing renders — the realized states are auth; render the bare route.` | 10 | refusal |
| `review-ui render: an :auth surface was requested but its credentials are incomplete (unset: <names>) — the authenticated render is UNKNOWN, never the anonymous one.` | 11 | refusal |
| `review-ui render: surface "<id>" did not render signed in (<reason>) — the authenticated render is UNKNOWN, never the anonymous one.` | 11 | refusal |
| `review-ui render: --flag "<token>" is not a <key>=<on\|off> pair (<reason>) — an operand nothing can force would shoot the default state under the forced name.` | 10 | refusal |
| `review-ui render: --flag was passed with the anonymous surface "<id>" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name every surface :auth.` | 10 | refusal |
| `review-ui render: surface "<id>" did not render with its forced flags (<reason>) — the forced render is UNKNOWN, never the default one.` | 11 | refusal |
| `review-ui render: --out "<value>" is not a kebab-case set name.` | 10 | refusal |
| `review-ui render: cannot read <what> for #<n>: <reason> — the render is UNKNOWN.` | 11 | refusal |
| `review-ui render: the preview comment names apps <list> — pass --app to pick one.` | 11 | refusal |
| `review-ui render: the preview comment carries the anchor but no parseable URL + SHA for app "<app>" — a malformed announcement is unreadable, not absent.` | 11 | refusal |
| `review-ui render: the preview deploys <deployed-sha7>, the live head is <head7> — stale preview; pixels of an old tree must not bind a new head (#4808's class).` | 12 | refusal |
| `review-ui render: surface "<id>" threw during render: <first page error> — the render is red; a broken page is not composition to judge.` | 13 | refusal |
| `review-ui render: surface "<id>" is unreachable at the preview (<reason>) — judge what renders, and hold the gap against the PR's Deviations (#4305).` | 14 | refusal |
| `review-ui render: surface "<id>" captured invalid bytes (<detail>) — a capture nobody can open is not evidence (#3925's class).` | 15 | refusal |
| `review-ui render: cannot write the set manifest for #<n>: <reason> — the captures exist but the set does not.` | 11 | refusal |
| `review-ui render: no preview-deploy comment on PR #<n> — nothing to judge without running the PR's code; the run is CANT-SEE.` | 16 | refusal |

**Scope** — exactly the `--surface` operands against one PR's announced preview. Zero operands
is `1`, so "rendered nothing, found nothing wrong" is unrepresentable (ADR 0092). The
per-surface outcome enumeration goes to stderr on every path, success included.

**Examples**

```
$ fabrika review-ui render --pr 4321 --out judged --surface /pano
{"schemaVersion":2,"source":"review-ui-render","repository":"kamp-us/phoenix","set":"judged","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","app":"web","previewUrl":"https://phoenix-pr-4321.kampus.workers.dev","flags":[],"captures":[{"surface":"/pano","path":"/tmp/fabrika-review-ui/4321-03135b91/judged/pano.png","width":1280,"height":2140,"sha256":"9c41000000000000000000000000000000000000000000000000000000000000","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out judged --surface /pano --surface /yonetim
review-ui render: surface "/pano" captured: 1280x2140, 0 page errors
review-ui render: surface "/yonetim" is unreachable at the preview (status 404) — judge what renders, and hold the gap against the PR's Deviations (#4305).
$ echo $?
14
```

```
$ fabrika review-ui render --pr 4321 --out forced --surface /hosgeldin:auth --flag phoenix-welcome=on
review-ui render: surface "/hosgeldin:auth" captured: 1280x1640, 0 page errors
{"schemaVersion":2,"source":"review-ui-render","repository":"kamp-us/phoenix","set":"forced","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","app":"web","previewUrl":"https://phoenix-pr-4321.kampus.workers.dev","flags":["phoenix-welcome=on"],"captures":[{"surface":"/hosgeldin:auth","path":"/tmp/fabrika-review-ui/4321-03135b91/forced/hosgeldin-auth.png","width":1280,"height":1640,"sha256":"1f7b000000000000000000000000000000000000000000000000000000000000","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out forced --surface /hosgeldin --flag phoenix-welcome=on
review-ui render: --flag was passed with the anonymous surface "/hosgeldin" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name every surface :auth.
$ echo $?
10
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
- #6541 / ADR 0336 — the verb captured every flag at its default, so under the dark-ship norm the
  gate judged the off-path and said PASS. `--flag` is that ruling's implementation (#7218), and its
  own proof exists because an override the preview dropped is the same clean-but-wrong capture.

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
| `--evidence` | string | yes | — | the kebab-case name of a `review-ui render` route-surface set or provenance-validated `review-ui fetch` set whose verified upload is this verdict's evidence |
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
   manifest or one that does not parse is `4`). Preview evidence uses schema 2, must bind the
   repository, PR, head, app, preview URL, exact flag operands, and route-shaped surface ids
   (`/...`), and must keep every capture inside its deterministic set directory. Local files are
   never producer authority: `post` resolves the live preview announcement, independently
   re-renders every recorded surface with its state and flags, and requires the fresh dimensions and
   bytes to match before accepting the reviewed set. A caller writing a manifest, receipt, and key
   therefore cannot import arbitrary local captures. An unresolved recapture is `11`; a mismatch is
   `4`. Any CI source must
   parse as the positive CI manifest and carry the consumer receipt whose repository, PR, live full
   head, harness, run, check, artifact, and manifest hash agree. Post then rereads the default-branch
   declaration and re-downloads the exact artifact selected by the successful live-head
   workflow/run/check/artifact tuple. The local manifest and every capture must byte-match the
   re-downloaded members. Copied public ids plus attacker-chosen local bytes therefore refuse before
   upload. A CI manifest carrying any uncaught
   `pageerror` cannot be posted with PASS (`13`); the materialized set is FAIL ground. **Refuse on
   `12` when the set's recorded head is not `--sha`**:
   stale captures under a new head are re-rendered or re-fetched, never rebound.
3. **Re-validate every capture against its manifest SHA-256 and dimensions** (`15` on a hash,
   dimension, or PNG-validity mismatch).
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
   posts the ordinary FAIL marker). Below it, the stdin body, then for CI evidence the repository,
   workflow/event, linked run id, linked check name/id, artifact name/id, harness and browser-error
   coverage, then the evidence gallery — per surface, the verified hosted URL.
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
| `4` | the `--evidence` set's manifest is absent or malformed; preview bytes differ from the independent live-preview recapture; CI evidence is declaration-mismatched, differs from the exact re-downloaded artifact, or its receipt ids differ from the trusted GitHub tuple; or `design-harness.json` violates its schema |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference — the body never arrived |
| `7` | the PR is proven absent (404) or closed |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this marker |
| `10` | a bad `--polarity`; `--carrier advisory` with `--polarity FAIL`; a `--carrier` off its enum; or an `--evidence` name outside kebab-case set vocabulary |
| `11` | a precondition read failed — the PR, live head, independent preview recapture, default-branch declaration, trusted GitHub artifact re-download, evidence files, or upload target; nothing was posted |
| `12` | refused: the live head moved past `--sha`, or the evidence set was rendered at a different head — the verdict or its pixels would bind a tree that is not the PR |
| `13` | proven: CI evidence records an uncaught page error and the caller requested PASS — the materialized set must post FAIL |
| `15` | proven: a capture is invalid or fails its manifest SHA-256 or dimensions |
| `17` | proven: at least one evidence upload or its verification failed — nothing was posted |
| `18` | proven: the exact-head governed CI run, check, or artifact required to revalidate this set is unavailable |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui post: <n> is not a pull-request number.` | 1 | usage error |
| `review-ui post: --evidence "<value>" is not a kebab-case set name.` | 10 | refusal |
| `review-ui post: no body on stdin — an empty verdict reads as ungated; pipe the verdict body in.` | 3 | refusal |
| `review-ui post: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review-ui post: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui post: PR #<n> is closed — a verdict on a closed PR gates nothing.` | 7 | refusal |
| `review-ui post: cannot read the PR for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: --polarity must be PASS or FAIL — got "<v>".` | 10 | refusal |
| `review-ui post: --carrier must be marker or advisory — got "<v>".` | 10 | refusal |
| `review-ui post: --carrier advisory is a PASS path only — post the FAIL marker instead.` | 10 | refusal |
| `review-ui post: --sha "<value>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review-ui post: --clause is blank — a verdict with no clause says nothing to a human.` | 10 | refusal |
| `review-ui post: the live head is <live>, not <sha> — the tree you judged is gone; re-review at <live> (ADR 0058).` | 12 | refusal |
| `review-ui post: evidence set "<set>" has no readable manifest.json (<reason>) — a set without its manifest is not a set; re-run the sanctioned producer (review-ui render or review-ui fetch).` | 4 | refusal |
| `review-ui post: evidence set "<set>" has no readable manifest.json.` | 4 | refusal |
| `review-ui post: preview evidence set "<set>" does not match its render request.` | 4 | refusal |
| `review-ui post: preview evidence set "<set>" was not authenticated by an independent live-preview recapture (<reason>).` | 4 / 11 | refusal |
| `review-ui post: CI evidence set "<set>" has no consumer-validated provenance receipt — a builder-authored manifest is not evidence.` | 4 | refusal |
| `review-ui post: CI evidence set "<set>" does not match its consumer-validated provenance receipt.` | 4 | refusal |
| `review-ui post: cannot revalidate CI provenance because the default branch is unreadable (<reason>).` | 11 | refusal |
| `review-ui post: cannot revalidate CI provenance because the exact default-branch authority revision is unreadable (<reason>).` | 11 | refusal |
| `review-ui post: cannot revalidate CI provenance because the governed declaration is absent.` | 4 | refusal |
| `review-ui post: cannot revalidate CI provenance because the governed declaration is unreadable (<reason>).` | 11 | refusal |
| `review-ui post: cannot revalidate CI provenance because the governed declaration is malformed (<reason>).` | 4 | refusal |
| `review-ui post: CI evidence set "<set>" no longer matches the governed producer declaration.` | 4 | refusal |
| `review-ui post: the re-downloaded CI artifact has unsafe, duplicate, extra, incomplete, or malformed members.` | 4 | refusal |
| `review-ui post: trusted CI artifact is proven unavailable (<reason>).` | 18 | refusal |
| `review-ui post: trusted CI artifact re-download is UNKNOWN (<tag>: <reason>).` | 11 | refusal |
| `review-ui post: CI evidence set "<set>" receipt does not match the trusted run, check, and artifact identities.` | 4 | refusal |
| `review-ui post: CI evidence set "<set>" manifest does not byte-match the exact re-downloaded GitHub artifact.` | 4 | refusal |
| `review-ui post: CI evidence set "<set>" capture "<surface>" does not byte-match the exact re-downloaded GitHub artifact.` | 4 | refusal |
| `review-ui post: CI evidence records an uncaught page error — the materialized render is FAIL ground and cannot carry PASS.` | 13 | refusal |
| `review-ui post: evidence set "<set>" was rendered at <set-head7>, you are posting at <sha7> — stale pixels; re-render at the live head.` | 12 | refusal |
| `review-ui post: preview capture "<surface>" resolves outside its review-ui render set.` | 4 | refusal |
| `review-ui post: cannot read capture "<surface>" in set "<set>" for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: cannot read capture "<surface>" while byte-comparing the exact CI artifact for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: capture "<id>" in set "<set>" is invalid or fails its manifest hash/dimensions (recorded <hash12>, read <hash12>).` | 15 | refusal |
| `review-ui post: design-harness.json exists but does not satisfy its schema: <first violation> — the tier choice is unmakeable.` | 4 | refusal |
| `review-ui post: cannot read design-harness.json for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: design-harness.json declares the "<kind>" evidence store, and this delivery layer wires no store leg for it — the upload target's state is UNKNOWN; nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: upload failed for <k> of <m> captures (<first surface>: <reason>) — refusing to post a verdict over a broken evidence channel (#3925).` | 17 | refusal |
| `review-ui post: cannot re-read the PR for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `review-ui post: the live head moved from <old> to <new> before posting — the tree you judged is gone.` | 12 | refusal |
| `review-ui post: the assembled comment carries a machine-local path at line <k> (<class>) — cite it repo-relative or by class root.` | 5 | refusal |
| `review-ui post: cannot read the authenticated user for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: cannot read the comments for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: preview evidence set "<set>" no longer matches the live preview announcement.` | 12 | refusal |
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
`normalizeForReadback` (`9` on mismatch; `8` on an unproven write). When a caller reached `note`
after an exact-head fetch refusal, exit `7` is the closed-subject race: the PR closed after fetch and
before this precondition read. The review-ui skill routes that attempted write to **ESCALATED
(closed-subject)** with no marker and no CANT-SEE claim; only a fetch that itself returns `7` may end
CANT-SEE without a note attempt.

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

**Examples**

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

## `review-ui route`

**Invocation**

```
fabrika review-ui route 6326 --sha <head> --clause "<why>" [--repo <owner/name>]
```

The reasoning arrives on **stdin only**, for the same reason as `post` and `note`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head whose diff was read, 7–40 lowercase hex |
| `--clause` | string | yes | — | the one-line why, carried on the record's first line; blank is refused |
| `--repo` | string | no | resolved | the repository |
| stdin | markdown | yes | — | which files changed and why none of them renders anything |

**Output** — machine. One JSON object:
`{"answer":"routed","namespace":"review-ui","sha":"6c6fe226…","uiFiles":2,"upsert":"created","commentUrl":"…"}`.

**Why it exists.** `ship scope` raises the `ui` class from a path test that cannot see whether
pixels moved, so a PR whose only `apps/web/src/**` change is prose requires this namespace — and
`render` refuses zero surfaces while `post` refuses without captures, so nothing legal could fill
it and `ship gate` blocked forever (#6376). This verb records the answer that was missing. It is
**not** a second verdict path: the `routed-elsewhere` wire format carries no polarity, so
`verdict-marker` reads it as `Absent` and it can never be counted as a PASS; `ship gate` resolves
it as its own `routed` state and admits it for `review-ui` alone; and the record is head-bound, so
any push voids it. ADR
[0316](../../../../.decisions/0316-a-gate-records-that-it-owes-no-verdict.md) is the ruling.

**The mechanism, in order.** Validate `--sha` and `--clause` (`10`). Read stdin (`3` on empty) —
an unexplained route is an assertion nobody can check. Resolve the PR, open and non-empty
(`7`/`11`). Refuse if the live head has moved past `--sha` (`12`): the record binds the tree whose
diff was read, and is re-read rather than re-bound. Read the changed-file list; a truncated read is
`11`, never a derivation, because truncation can only shrink the `ui` count and would refuse a PR
the gate is meanwhile blocking. Refuse a diff that raises no `ui` class (`7`) — nothing required
this namespace, so there is nothing to route; the predicate is `review/classes.ts`'s own
`isUiSurface`, never a second copy. Compose the record's first line through the `routed-elsewhere`
wire format, leak-scan the assembled comment (`5`/`6`), upsert one record for this namespace on the
emitter's own comment, and read it back from live state (`9` on mismatch, `8` on an unproven
write).

**What this verb does not decide.** Whether the diff renders anything. That is the skill's judgment
over `review diff`'s refusal-guarded bytes, and it is the branch #6376's candidate 2 proposed and
the founder rejected: no path test can decide whether pixels moved, so a verb that tried would just
relocate the defect. This verb takes the judgment as `--clause` plus a body and records it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the PR is proven absent (404), closed, has zero changed files, or its diff raises no `ui` class |
| `8` | the create/edit failed — UNKNOWN whether the record landed |
| `9` | the record landed but does not read back as sent |
| `10` | `--sha` is not a head SHA, or `--clause` is blank |
| `11` | a precondition read failed, or the changed-file list came back truncated — nothing was posted |
| `12` | the live head moved past `--sha` — the diff you read is gone |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui route: no body on stdin — a route with no reasoning is an assertion nobody can check; pipe the reasoning in.` | 3 | refusal |
| `review-ui route: the assembled comment carries a machine-local path at line <k> (<class>).` | 5 | refusal |
| `review-ui route: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review-ui route: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui route: PR #<n> is closed — a route on a closed PR resolves nothing.` | 7 | refusal |
| `review-ui route: #<n>'s diff raises no ui class, so ship gate requires no review-ui namespace — there is nothing to route.` | 7 | refusal |
| `review-ui route: create/edit failed: <reason> — UNKNOWN whether the route landed; re-read the PR before retrying.` | 8 | refusal |
| `review-ui route: posted, but the read-back does not yield this record (<why>) — inspect comment <id>.` | 9 | refusal |
| `review-ui route: --sha "<value>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review-ui route: --clause is blank — a route with no stated reason records nothing a reader can check.` | 10 | refusal |
| `review-ui route: received <m> of <n> changed files — refusing to derive the ui class from a truncated read.` | 11 | refusal |
| `review-ui route: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `review-ui route: the live head is <live>, not <sha> — the diff you read is gone; re-read at <live> (ADR 0058).` | 12 | refusal |

**Scope** — one PR, one comment write, the caller's stdin.

**Examples**

```
$ fabrika review-ui route 6326 --sha 6c6fe226 \
    --clause "no rendered delta; both apps/web/src files are prose only" <<'EOF'
`shell-keys.ts` rewrites one JSDoc paragraph to drop a `pipeline-cli` reference — no statement,
export or type changed. `design-token-lint.config.json` rewrites two note strings; the guard's
data fields are byte-identical. No component, route, token or style is touched.
EOF
{"answer":"routed","namespace":"review-ui","sha":"6c6fe226","uiFiles":2,"upsert":"created","commentUrl":"https://github.com/kamp-us/phoenix/pull/6326#issuecomment-512399"}
```

**Grounding**

- #6376 — the two rules that could not both hold, and the founder ruling that picked this shape
  over narrowing the `ui` class.
- ADR 0092 — the zero-scope refusals this verb inherits rather than loosens: `render` still
  refuses zero surfaces, `post` still refuses without captures, and this verb refuses a diff that
  raises no `ui` class.
- ADR 0055 — the record is authored, so the write+ ACL binds it at `ship gate` exactly as it binds
  a verdict marker.
- ADR 0058 — the head binding, and why a moved head is re-read rather than re-bound.

---

## Completeness self-test

Per the [contract-spec format](../../docs/contract-spec-format.md#completeness-test): every flag
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own the group-local rows; the universal `0/1/126/127`
live once in the shared matrix, which owns every code's single meaning); every error names
message, stream, and code; every verb states scope and zero-scope behavior (`render` refuses
zero surfaces at `1`; `fetch` refuses an absent/closed PR at `7` and every proven zero producer
scope at `18`, while UNKNOWN reads and execution refuse at `11`; `ci-produce` requires one PR and
harness and refuses an unknown harness at `10`; `post`
refuses an empty body at `3` and an unreadable evidence set at `4`/`11`; `note` refuses an empty
body at `3` and a verdict-shaped body at `10`; `route` refuses an empty body at `3` and a diff
raising no `ui` class at `7`); and no clause
defers to a v1 script, another skill's prose, or the authoring session —
the `review` and `build-ui` references are to sibling fabrika contracts, the sanctioned
cross-contract shape, with the `build-ui` reference flagged as pre-merge in the authoring PR.
The three hand-checks: every reachable outcome walked per verb (mixed render outcomes route by
smallest code with full stderr enumeration; fetch and ci-produce enumerate their provenance,
isolation, schema and zero-scope refusals; the post protocol's eight steps each name their refusal); every example value derives from stated rules (the set path from the deterministic
`<OS temp>/fabrika-review-ui/<pr>-<head8>/` rule, `previewUrl` from the comment's app sub-line);
sibling verbs guard shared preconditions identically (`render` and `post` resolve PR + live head
on the same `7`/`11` and treat capture invalidity as `15`; `render` binds preview-to-head and
`post` binds set-to-`--sha` on the same `12`; `note` shares the `7`/`11` PR resolve and the
`3`/`5`/`6`/`8`/`9` posting seats with `post`; `route` shares all of those and binds
head-to-`--sha` on the same `12` as `post`).
