# `/review-ui` — derived CLI contract

**Skill:** [`review-ui`](SKILL.md) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`review-ui`** subcommand group, registered
in `packages/fabrika-cli/src/registry.ts` beside the shipped `adr`, `build`, `report`,
`review`, `spend`, `triage` and `wire` groups. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug. **None of these verbs exists yet** —
this spec is greenfield.

**`fabrika` calls the retired v1 pipeline CLI nowhere, and neither does the skill.** The v1 prior
art — its `review-design` skill and the six tools behind it — was **read** for semantics and scars;
none is invoked, wrapped, or deferred to. Each Grounding section names the scar the v1 counterpart
carries and what this spec does instead.

**The capture-machinery boundary (the tandem ruling).** Rendering, capture validation, golden
resolution and raster diffing are **one machinery shared with `build-ui`** — same render paths,
same golden formats, same modules (founder ruling, brief amendment 2026-08-09). That machinery is
fabrika-owned: it lives at `packages/fabrika-cli/src/capture/` behind the capture subpath, while
repo-specific DATA — golden bytes, `golden-pointer.json`, harness config — stays per-repo. An implementer
imports that module the way `build`'s verbs import the `wire` modules. Every scar this spec designs
out binds regardless of whether the implementation imports or reimplements.

**Reused, never respecified — the sibling contracts this one leans on:**

- **Gate mechanics** are the shipped `review` group's ([`../review/contract.md`](../review/contract.md)):
  `review scope`, `review diff`, `review criteria`, `review ci`, `review verdicts`,
  `review deviations`. The skill invokes them as-is; restating one here would be the second home
  a shared fact drifts from.
- **The named-gate read** is `heal-ci`'s ([`../heal-ci/contract.md`](../heal-ci/contract.md)):
  `heal-ci surface`. §5 needs each armed design gate's live state *by name* — the
  check-run name, the job's `name:` inside each workflow file, never its filename;
  `review ci` collapsed its check rows to a bounded status tally, and even uncollapsed it could
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
| `review-ui post` | the single sanctioned `review-ui` verdict emit: verify-upload the evidence set, compose through the wire format, bind to the inspected head at post time, append into this namespace's one comment, read it back | upload-verify-compose-post-readback is a protocol; *the polarity and every finding behind it* are judgment |
| `review-ui note` | the single sanctioned non-verdict write: post one plain comment naming a proven blocker state (can't-see, escalation), leak-scanned, read back — never a marker | compose-scan-post-readback is a protocol; *whether the state warrants a note* is judgment |
| `review-ui route` | the single sanctioned way to resolve this namespace with no verdict: post one head-bound `routed-elsewhere` record stating that the PR renders nothing, or, on a PR with no preview, that the repo's `reviewUi.whenNoPreview` rules skip the render or an owner's hand-check stands in for it (its `basis:`), leak-scanned, upserted, read back | binding, upsert and read-back are a protocol; *whether the diff renders anything* is judgment, and no verb may take it |

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
  into "not a UI PR" (a trailing `|| true`) and scrapes its predicate out of another skill's
  markdown at `ref=main` (three copies of one regex, one live-scraped). The modality decision is
  the skill's judgment over `review diff`'s refusal-guarded bytes; `render` takes explicit
  `--surface` operands and refuses zero. No verb guesses surfaces, so no verb can fail open on
  the guess.
- **A token-discipline / inventory-freshness / a11y verdict.** Each is enforced at the repo's own
  CI gate for it — and every real v1 design FAIL was the deterministic token-seam class those gates
  now own. The skill states the expectation; the verdict stays where it is enforced.
- **A control-plane classifier.** v1's leg computed a control-plane answer and then discarded it,
  and the content probe behind it over-matched most of the decision corpus — a content-keyed check
  that cannot see its subject, answering confidently. That whole
  branch retires with v1. Here §CP arrives as the `--carrier` **input**, exactly as in
  `review post`; nothing in this group computes membership.
- **A second parser for the marker, the pointer, the registry, or the preview comment.** The
  marker is the registered wire format; the pointer and registry schemas are `build-ui`'s
  contract's; the preview-comment anchor grammar is the capture machinery's one resolver module.
  v1 held three copies of its UI predicate and two of the design law; one home each is the point.
- **A verdict-ledger / learn-back verb.** The charter sequences learn-back after this skill is
  eval-green: registry → goldens → corpus → `review-ui` eval-green → learn-back. Scraping
  markers into structured data is that later work's verb, in its own contract.
- **A before-capture verb (rendering the base branch).** The pairwise *before* is the blessed
  golden or nothing — an unblessed surface is judged against the rubric checklist, and the
  builder's attached captures are deliberately not consumed (the skill's independent-render
  rule). Rendering the merge-base would double the preview machinery for a pair the charter does
  not require.

### Nothing here recomputes an enforced answer

The gated questions and their owners, named so the boundary is checkable: token discipline (the
repo's token guard, armed through branch protection rather than the CI aggregator), inventory
freshness plus the descriptive/normative firewall (its inventory guard), the a11y floor (its a11y
job), §CP membership (CODEOWNERS at merge). This group computes none of them.

## Shared conventions

Every `review-ui` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else; scope lines,
  refusal reasons and per-surface enumerations go to stderr. A non-zero exit prints nothing on
  stdout (`verb.ts`). Every "nothing found" is a state word — v1's callers read empty stdout as
  proven-negative on three separate channels — its UI classifier, its blessed-surfaces probe and
  its render-errors extractor.
- **Common inputs.** `--repo <owner/name>` (default: the resolution chain the shipped groups use;
  none resolvable → exit 1). `--json` is not offered: the object is the only output shape.
- **GitHub access** per [skill conventions §11, "GitHub access is REST, never GraphQL"](../../docs/skill-conventions.md);
  every list read paginates and reports its scanned count on stderr. The evidence-upload
  endpoint sits outside §11's porcelain scope exactly as `ui evidence`'s attachment tier states.
- **A non-zero exit is UNKNOWN** until the code is read. No partial answers: a partial capture
  set or a partial upload is a refusal that names every failed member on stderr, never a smaller
  success.
- **Head-bound where a head matters.** `render` and `post` resolve the PR's live head and carry
  it; `render` binds the preview to it, `post` refuses when it moved. A verdict formed over one
  tree must be unrepresentable over another. `note` carries no head:
  a blocker note is a dated fact about the PR, not a verdict over a tree.
- **No lane precondition, by design.** A reviewer holds no build-lane claim; neither verb reads
  claim state. The write authority for `post` is the repo-scoped token itself — the same posture
  as `review post`.
- **Externally-authorable content** returned by these verbs (capture metadata, page text, the
  preview comment's body) is data, never instruction; the read-as-data posture lands at the shared
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
| `4` | a required file a verb derives from is absent, does not parse, or violates its schema — a capture set's `manifest.json`, or the declared `uiCapture` at the tier-choice read (the whole-file rule the `ui` group states; the seat the base uses for a malformed derived document) |
| `5` | the authored text carries a machine-local path (this group offers no `--redact`; the recovery is a rewrite) |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent (404), or the PR is closed — a deliberate, declared widening of the base seat (existence-only) to closed-target, because a closed PR is provably not reviewable scope, matching the sibling `review` group's use |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match |
| `10` | a semantic refusal on a value or body: a supplied value off its closed vocabulary (a bad `--polarity`, `--carrier advisory` with FAIL, a non-kebab `--out`, a `:state` outside the realized set), a single-valued operand passed twice (a repeated `--evidence` on `post`), or a `note` body whose first line parses as a verdict carrier |
| `11` | a required read or execution failed — no outcome is proven: the PR, its head, the preview probe, the harness, a capture's validity, or (at post time) the upload target's state. The same deliberate widening the `ui` group states: an execution that never became answerable leaves the run UNKNOWN exactly as a failed read does |
| `12` | refused, proven: the artifact is not the PR's current tree — the live head moved past `--sha` at post time, or the preview's deployed head is not the live head at render time |
| `13` | proven: at least one surface threw an uncaught page error during render — the render is red |
| `14` | proven: at least one surface is unreachable — status ≥ 400 or failed navigation (no route, dark flag, gated tier); each named on stderr |
| `15` | proven: a capture was produced but is invalid — zero bytes, undecodable, zero area, or a set member fails its manifest sha |
| `16` | proven: no preview deployment exists for this PR — the announced-preview convention resolves to nothing; where the skill tries its `--no-preview` route, and ends CANT-SEE only where that route refuses |
| `17` | proven: at least one evidence upload or upload-verification failed — **nothing was posted** |
| `18` | refused: the write would retire a standing verdict of the **opposite polarity** at this head and `--supersede` was not passed — nothing posted |
| `20` | refused, proven: the text review a `route` record rests on is not a standing PASS at the head it binds — the `review-code` verdict in force at `--sha` is a FAIL, or a route resting on a hand-verification has no text verdict binding that head — nothing posted |
| `21` | refused, proven: the repo's `reviewUi.whenNoPreview` rules do not admit a `--no-preview` route — the PR resolves `require-render`, or `hand-check` with no owner's hand-check at the head on the PR — nothing posted |
| `22` | refused, proven: the named hand-check is not an owner's screenshots at this head — nothing posted |
| `23` | refused, proven: a `--no-preview` route found a preview announced on the PR, so a render can run — nothing posted |
| `127` | the verb never ran at all (unresolved binary) |

**`7` versus `11`** is the package's spine: a 404 is a fact about the repository, an unreachable
GitHub is not a fact about anything; no message here reads "does not exist, or is not readable".
**`12` fuses two triggers deliberately and one meaning binds them** — *the pixels or the marker
would bind a tree that is not the PR* — because the caller's move is identical (re-render /
re-review at the live head), where `13`/`14`/`15`/`16` each route differently and stay four codes.
**`16` is not `7`**: the PR exists; what is proven absent is the repo's ability to show it — a
routable state the skill acts on by name: it runs the `--no-preview` route there, and only where
that route refuses is it a can't-see the reviewer declares out loud, made mechanical.

## Required environment — the two render paths

Per the tandem ruling (both briefs, 2026-08-09), declared identically to `build-ui`:

- **Default path (required): the headless capture machinery** — the fabrika-owned capture
  package driving a headless browser at the **preview deployment's URL**. The browser
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
- **A tier-naming surface needs the preview worker's signing secret plus its identity's own
  session token.** Neither needs a credential beyond repository access: the secret resolves off the
  checkout, and a token the environment does not hold is fetched from the repository's
  `PREVIEW_TEST_LOGINS` variable.
  The secret is the one the *preview worker deployed with*, so the
  cookie signature verifies, and it needs no credential: every `pr-<n>` preview deploys with the key
  committed at `infra/preview-auth-key/key.txt`, deliberately public, which the verb resolves off
  the checkout it runs in with no flag and no environment variable. Production keeps a
  separate founder-held secret, and the production worker refuses a preview-prefixed key at boot.
  `--auth-secret-from <file>` overrides the committed key, and in a checkout carrying no committed
  key the ambient `$BETTER_AUTH_SECRET` stands in. Whatever the source, **a value that is empty or
  carries the `insecure_` placeholder an example env file ships is refused on `11` rather than
  signed with**.
  A placeholder-signed cookie is perfectly well-formed and the worker answers it as a visitor, which
  at the shot is indistinguishable from a preview nobody seeded — two gate rounds were spent
  splitting exactly that by hand. The
  token is the one `preview-seed test-account` wrote onto the preview D1 for that identity —
  `PREVIEW_TEST_SESSION_TOKEN` for `:auth` (yazar), `PREVIEW_TEST_CAYLAK_SESSION_TOKEN` for
  `:auth-caylak` (çaylak), `PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN` for
  `:auth-caylak-unverified` (the email-unverified çaylak). **One token per identity, and a
  missing one is never satisfied by another's**: a token found in neither place below means the run
  cannot sign in as that identity, and falling back to one it does hold would render the audience
  the surface said it was not — the verified çaylak's token standing in for the unverified one
  would shoot the write the surface exists to show refused. **Each token is read from its own environment variable first, and
  only an identity the environment leaves unset is looked up in the repository variable
  `PREVIEW_TEST_LOGINS`**: one JSON object keyed by those same three variable names, read through
  `GET /repos/{repo}/actions/variables/PREVIEW_TEST_LOGINS` under the run's GitHub credential. The
  deploy workflow seeds every preview from the Actions secret of the same name, and
  `preview-seed rotate-logins` writes the secret and the variable together, so the two hold one
  value. A run whose environment already holds every requested token makes no such request, and a
  run that names no tier reads neither. Every token is held `Redacted` from the read to the cookie
  it signs, and no refusal quotes one. A 404 on the variable is "nobody has set it" and any other
  failed read is UNKNOWN; the two are separate refusals. With a requested identity's token in
  neither place the request refuses `11` rather than
  substituting; with no tier-naming surface asked for, every surface renders anonymously as before.
  Holding them is necessary and not sufficient — whether the cookie authenticated, at which tier and
  with which email verification, is the per-shot session proof's answer, also an `11`. **A visitor
  answer names which of two failures it was**, read off whether the probe's response expired the
  session cookie: better-auth's `getSession` returns before touching any cookie when the signature
  does not verify, and expires the session cookie (`Max-Age=0`) when the signature verifies and no
  live session row carries the token. So `bad signature` is a wrong signing key and
  `missing session row` is a preview whose database does not hold this token.
- **`--flag` needs those same values plus one grant on the preview D1.** The override cookie is
  honored only for a platform admin, per the repo's own override authorization, and
  `preview-seed test-account` provisions moderation authority to the yazar identity and nothing at
  all to either çaylak identity. So a forced run is preceded by `node packages/admin-grant/src/bin.ts grant
  --user-id <the identity's account id> --database-id <preview-d1>` — offline and direct-D1, on a
  throwaway preview only, never against a database holding real accounts. Admin is a relation tuple,
  not a tier, so granting it to `preview-test-caylak` or `preview-test-caylak-unverified` leaves that
  identity a çaylak with its own email verification, and the session proof still binds. The grant
  is what makes the forced capture an admin's view as well, which is the trade the operand asks for
  and the reason it is not the default.

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

A PR that mints no preview is announced with the same prefix in its no-preview form,
`<!-- preview-deploy:none head:<sha> -->`. When the newest announcement is that form, the SHA decides
the answer. A SHA naming the head being judged (either side may be abbreviated) is the proven `16`,
the same as no anchor, and `review-ui route --no-preview` routes on it. A SHA naming any other
head refuses on `11`: the marker proves there was no preview at an earlier push, and the workflow
may not have answered for this one yet. A no-preview marker beside an app block is malformed, `11`.

---

## `review-ui render`

**Invocation**

```
fabrika review-ui render --pr 4321 --out judged --surface /feed --surface /feed/yeni [--viewport desktop --viewport mobile] [--flag <key>=<on|off>] [--locale <value>] [--scheme light --scheme dark] [--accent <value>] [--interact '<surface>#<label>=<step>;<step>;…'] [--auth-secret-from <file>] [--app web] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose preview is judged |
| `--out` | string | yes | — | kebab-case capture-set name; captures land under `<OS temp>/fabrika-review-ui/<pr>-<head8>/<set>/` |
| `--surface` | string, repeatable | yes (≥1) | — | a surface id: a route (`/feed`), or a route plus a realized tier state (`/feed:auth`, `/feed:auth-caylak`, `/feed:auth-caylak-unverified`); zero operands is `1` — no tool guesses surfaces from a diff |
| `--viewport` | string, repeatable | no | `desktop` alone | a viewport to shoot every `--surface` at, over the closed set `desktop` (1280×800) and `mobile` (390×844); crossed with `--surface`, so two of each is four captures. A name outside the set, or one passed twice, is `10` |
| `--flag` | string, repeatable | no | every flag at its default | force one flag for this run: `<key>=on` or `<key>=off`; anything else, or a key forced twice, is `10` |
| `--locale` | string | no | the app's default locale, nothing seeded | render every shot in this locale — one of the values `.fabrika.jsonc`'s `uiCapture.locale` declares; with no declaration, or a value outside its list, it is `10` before a browser launches |
| `--scheme` | string, repeatable | no | the browser's own scheme, nothing emulated or proved | a colour scheme to shoot every `--surface` at, over the closed set `light` and `dark`; crossed with `--surface` and `--viewport`, so one surface at one viewport in both schemes is two captures. A name outside the set, a name passed twice, or any `--scheme` while `.fabrika.jsonc` declares no `uiCapture.scheme`, is `10` before a browser launches |
| `--accent` | string | no | the app's own accent, nothing set | render every shot in this theme accent — one of the values `.fabrika.jsonc`'s `uiCapture.accent` declares; applied to every surface, viewport and scheme. With no declaration, or a value outside its list, it is `10` before a browser launches |
| `--interact` | string, repeatable | no | every surface at rest alone | an interaction state to shoot beside a `--surface`'s at-rest shot: `<surface>#<label>=<step>;<step>;…`, where `<surface>` is one of this run's `--surface` ids exactly, `<label>` is kebab-case (`[a-z0-9-]`, at most 64 characters) and names the shot, and each step is `hover:<locator>`, `focus:<locator>`, `click:<locator>`, `press:<key>` or `expect:<locator>`. Crossed with `--viewport` and `--scheme` like its surface. A malformed operand, an operand on a surface the run did not ask for, two operands whose shots would share a PNG name, or steps ending on `click` or `press`, is `10` before a browser launches |
| `--app` | string | no | the sole app in the preview comment; ambiguity refuses on `11` | which app's sub-line of the preview comment to resolve. Whichever app is resolved, a `--surface` whose own `uiSurfaces` row belongs to an app this preview did not announce is `11` — omitting the flag routes around no fence |
| `--auth-secret-from` | string | no | the committed preview key at `infra/preview-auth-key/key.txt`, else the ambient `$BETTER_AUTH_SECRET` | a file holding a signing secret to use instead of the repo's own — rarely needed, since the committed preview key is what every `pr-<n>` worker deploys with and needs no credential; a file that cannot be read is `11`, and so is a resolved value that is empty or carries the `insecure_` placeholder |
| `--repo` | string | no | resolved | the repository |

A `:state` suffix is admitted **only for a state something here actually puts on screen**, and
refused on `10` otherwise. The realized set is `auth`, `auth-caylak` and
`auth-caylak-unverified`, and **each one names the audience it renders as**: `:auth` is the
yazar+moderator identity, `:auth-caylak` the email-verified çaylak, `:auth-caylak-unverified` a
çaylak whose email is unverified. Each seeds that identity's own better-auth session cookie into the
capture context, and each account is provisioned direct-D1 by `preview-seed test-account`, never by
a worker route.

The tier is an axis of the surface id because a tier is an audience. A surface whose whole point is
that it renders *below* yazar — a çaylak nudge, a pre-promotion prompt, an onboarding ask — is
suppressed for anyone clearing the floor, so a yazar's shot of it comes back valid, decodable and
showing the state the PR did not add. That is the dangerous failure this axis closes: a clean-looking
capture of the wrong audience.

Seeding a cookie is not the same as being signed in, and being signed in is not the same as being
signed in *as that identity*, so the shot proves both rather than assuming either. From the same
browser context, before the shot is classified, the verb reads the preview's own
`/api/auth/get-session` and requires a user back **whose `tier` is the one the surface named and
whose boolean `emailVerified` is the one the surface's identity carries** — `false` for
`:auth-caylak-unverified`, `true` for `:auth` and `:auth-caylak`. Anything else — a bare `null`, a
non-200, an unreadable body, a user with no tier, a user with no boolean `emailVerified`, a user at
another tier, a user with the other email verification — refuses the surface on `11` and records no
capture under that surface id. The verification check is what tells the two çaylak identities apart:
a verified çaylak on `:auth-caylak-unverified` clears the tier check and is still refused. A cookie that did not authenticate renders the
visitor's page and one that authenticated as the wrong identity renders somebody else's, and both are
perfectly valid PNGs no byte check can tell from the real one.

**`--viewport` is the width axis, and it is closed for the same reason `:state` is.** The narrow half
of the design law — a sub-36px tap target, a nowrap string that overflows, spacing that goes off-grid
— is only answerable from narrow pixels, and before this operand existed every shot was 1280 wide, so
an acceptance criterion phrased about a phone ended the gate as disclosed-UNKNOWN rather than PASS or
FAIL, and one PR took a FAIL that no change to its branch could repair. Omitting it renders
at `desktop` alone, exactly as every invocation written before it did. The two realized names resolve
to the constants in `capture/plan.ts`; a third name would have to fall back to some width, and a shot
at the fallback width filed under the asked-for label is coverage claimed and not held. Repeating one
name is `10` too — the second shot would overwrite the first's file and its evidence.

Viewports **cross** the surfaces rather than pairing with them: two surfaces and two viewports is one
set of four captures. Nothing collides, because the PNG file name has always carried the viewport
label (`feed@desktop.png`, `feed@mobile.png`) and each manifest entry now records it beside the
surface id — so a set can say what width each of its shots is of, and the evidence gallery heads each
one `<surface> @ <viewport>`.

Asking for a width is not the same as rendering at it, so — like the session and the override — the
shot proves its own. The recorded width is read back from the captured PNG's own header, never echoed
from the request, and a shot whose width is not the requested viewport's is refused on `19` and
recorded nowhere. A desktop-width capture filed under `mobile` is a perfectly valid PNG of a layout
nobody asked about, and no byte check downstream can tell it from the real thing.

**`--flag` forces a dark-shipped flag on, so the state the PR adds paints.** It
rides the worker's existing flag-override cookie — no route is added and the override
authorization is untouched — and that gate is why the operand carries a fence of its
own: on a deployed stage the cookie is honored only for a request whose actor holds platform
`Admin`, so an anonymous surface would drop it and render the default state cleanly under the
forced name. Every `--surface` in a forced run must therefore name a tier state, and a bare route
beside a `--flag` is `10`. No preview test account holds admin, so a forced run also needs
`admin-grant grant --user-id <that identity's account id> --database-id <preview-d1>` against that
throwaway preview D1 — offline, direct-D1, the same path the repo already sanctions for a grant. Admin is
a relation tuple and not a tier, so a granted `preview-test-caylak` is still a çaylak and still
passes the tier proof, and a granted `preview-test-caylak-unverified` is still unverified and still
passes the verification proof — which is how a forced email-verification write gate renders its
denial on `:auth-caylak-unverified`.

Seeding an override is not the same as the override taking, so — like the session — the shot proves
it. From the same context, before the shot is classified, the verb POSTs the preview's own
`/api/flags/evaluate` asking each forced key with the **opposite** value as its default: a dropped
cookie answers `!forced` for every key, which is `11` naming the inert keys. A key the probe leaves
unevaluated, or a probe that cannot be read, is `11` too and is never folded into "the override was
dropped" — that would be a fact about the override read off a probe nobody could read.

**`--locale` shoots the surface in a locale other than the app's default**, so a PR whose visible
change is only in another language is judged from its pixels. Where an app keeps the reader's locale
only in `localStorage`, no URL or header can pick it, and before this operand every such state was
disclosed as could-not-render. fabrika compiles in no app's key: the consumer declares it in
`uiCapture.locale`, beside `storageState`:

```jsonc
"uiCapture": {"locale": {"storageKey": "kampus.locale", "values": ["tr", "en"]}}
```

`storageKey` is the non-empty `localStorage` key the app reads; `values` is the closed, non-empty
list of distinct locale tags it accepts, each the `lang` the page carries when it renders in that
locale. The schema refuses a malformed declaration, and an absent one (or `null`) leaves every
render unchanged. The operand is read against that list before any network read or browser launch:
`--locale` with no declaration, or with a value off the list, is `10`, the same class as a
malformed `--flag`. A `--locale` run reads `uiCapture` too, so a declaration that does not decode is
`11`; a run without the operand never reads it.

The seed is a context init script, so the key is written in every document of each shot's context
before any page script runs, and the app's first read already sees it. It applies to every surface,
anonymous or tier-naming alike. Seeding a key is not the same as the app rendering in that locale, so
— like the session and the override — the shot proves it. After navigation and before the
screenshot, the verb waits (up to 10s) for `document.documentElement.lang` to name the requested
value, because an app may set `lang` only once an asynchronously loaded catalog lands, then reads it
back. A page whose `lang` names anything else, or one whose `lang` cannot be read, is `11` and
records no capture: a seed the app never read paints the default-locale page cleanly under the
requested name, and no byte check can tell the two apart. A page that threw during render is still
`13` — the locale proof is read off the page, so a crash outranks it. Every stderr line of a seeded
run names the shot `in locale <value>`.

**`--scheme` shoots the surface in a named colour scheme**, so a component whose styling depends on
the scheme is judged from dark pixels as well as light ones. Before this operand every shot took
whatever the headless browser resolved to, which is light, and a verdict on a scheme-dependent
component had to disclose the dark scheme as could-not-render.

The request rides the browser, not the app: each shot's context emulates `prefers-color-scheme` at
the named value, so an app left on its system-following default renders that scheme and fabrika
writes no app's storage key. That request is a fact about the browser only — an app with a stored
choice, or one that pins its scheme, paints its own — so **the shot proves the scheme the page
resolved to, never the one it asked for**. The page's own answer is read off an attribute on
`document.documentElement`, and which attribute is the consumer's declaration in `uiCapture.scheme`:

```jsonc
"uiCapture": {"scheme": {"rootAttribute": "data-theme"}}
```

`rootAttribute` is a lowercase HTML attribute name whose value is `light` or `dark` once the page has
resolved its scheme. The schema refuses a malformed declaration, and an absent one (or `null`) makes
every `--scheme` a `10`, because there is nothing to prove the request against; a run without the
operand never reads it. A `--scheme` run reads `uiCapture` too, so a declaration that does not decode
is `11`.

After navigation and before the screenshot, the verb waits (up to 10s) for the attribute to name the
requested scheme, because an app may publish it from an effect after mount, then reads it back. An
attribute naming anything else, or one that is absent or cannot be read, is `11` and records no
capture: an emulated preference the app overrode paints the other scheme cleanly under the requested
name, and no byte check can tell the two apart. A page that threw during render is still `13` — the
proof is read off the page, so a crash outranks it.

A scheme-crossed shot carries the scheme in its PNG name (`feed@desktop-dark.png`) and a `scheme`
object on its manifest entry holding the `requested` scheme and the `proven` one the page published;
the evidence gallery heads it `<surface> @ <viewport>, scheme requested <s>, proven <s>`, and every
stderr line names the shot `in scheme <s>`. A run without `--scheme` keeps every name, entry and
heading it had before.

**`--accent` shoots the surface under a named theme accent**, so a change that reads the accent
tokens is judged under the accent that breaks it rather than only the default one. A contrast pair
can clear under nine accents and fail under the tenth, and before this operand that cell could not be
shot at all. The lever is an attribute on `<html>` the app's stylesheet switches accents on, and
which attribute, and which values it accepts, is the consumer's declaration in `uiCapture.accent`:

```jsonc
"uiCapture": {"accent": {"rootAttribute": "data-color-theme", "values": ["ember", "amber"]}}
```

`rootAttribute` is a lowercase HTML attribute name; `values` is the closed, non-empty list of
distinct accent names it accepts. The schema refuses a malformed declaration, and an absent one (or
`null`) makes every `--accent` a `10`, because there is no attribute to set. The operand is read
against the list before any network read or browser launch, so a value off it is `10` too. A
`--accent` run reads `uiCapture`, so a declaration that does not decode is `11`; a run without the
operand never reads it.

The attribute is set on `document.documentElement` once each shot has navigated, not from an init
script: the parser creates `<html>` after an init script runs, so a value written in the served
markup would overwrite one set before it. Setting the attribute is not the same as the page
rendering in that accent, so the shot proves it. Before the screenshot, the verb waits (up to 10s)
for the attribute to name the requested value, then reads it back. An attribute naming another
accent, or one that is absent or cannot be read, is `11` and records no capture: an app that
re-asserts its own accent paints that one cleanly under the requested name. A page that threw during
render is still `13`, because the crash check reads first. The shot fast-forwards the CSS
transitions the new accent started, so the pixels are the settled accent.

One accent applies to the whole run, and the PNG name does not carry it, so render the default and
an accent into two `--out` sets to compare them. Each entry of an accented set carries an `accent`
object holding the `requested` accent and the `proven` one read off the page; the evidence gallery
heads it `<surface> @ <viewport>[, scheme …], accent requested <a>, proven <a>`, and every stderr line
names the shot `in accent <a>`. A run without `--accent` keeps every name, entry and heading it had
before.

**`--interact` shoots the surface in an interaction state** — hovered, focused, a menu opened, a
toast raised — so a change that paints only after someone touches the page is judged from its own
pixels. Before this operand every shot was the page at rest, and a PR whose change lived in `:hover`
or behind a click parked CANT-SEE. An interaction is its own operand and not a `:state` token:
`:state` names the identity a page loads as, and an interaction is a thing done to the page after it
loads, so it composes with every `:state`, `--flag`, `--locale`, `--scheme`, `--accent` and
`--viewport` rather than replacing any.

The operand is `<surface>#<label>=<step>;<step>;…`. The surface is read up to the first `#` and the
label up to the first `=` after it, so a locator may carry either character; a step cannot carry
`;`. The steps run in order on the shot's page after navigation and after the locale, scheme and
accent proofs:

| Step | Does | Proves |
|---|---|---|
| `hover:<locator>` | moves the pointer over the element | the element matches `:hover` |
| `focus:<locator>` | focuses the element | the element matches `:focus-visible` |
| `click:<locator>` | clicks the element | nothing — it only acts |
| `press:<key>` | presses a key on the page (a Playwright key name: `Tab`, `Escape`, `Enter`) | nothing — it only acts |
| `expect:<locator>` | waits for the element to show | exactly one visible element matches |

`<locator>` is a Playwright selector, role and accessible name first (`role=menuitem[name="Sil"]`).
A role selector admits only Playwright's own attributes (`name`, `checked`, `pressed`, `expanded`,
`selected`, `level`, `disabled`, `include-hidden`), so an expectation about any other attribute is
written as CSS: `expect:[role=menuitem][data-highlighted]:has-text("Sil")`. Every locator step first
waits (up to 5s) for its element and refuses unless **exactly one** element matches, so no step acts
on whichever of several the browser happened to pick.

The steps must end on a proving step — `hover`, `focus` or `expect` — and an operand ending on
`click` or `press` is `10`: the shot would record whatever the page drew next with nothing checked
about it. Every proving step is checked where it runs, not only the last: a hover the page never
registered paints the surface at rest cleanly under the interacted name, and no byte check can tell
the two apart. A locator matching zero or several elements, a proof that does not hold, or a step
that times out stops the steps there, and the shot is `11` with **no capture written** — no
screenshot is taken, because the page past a failed step is not the state the label names. A page
that threw during render is still `13`: the crash outranks the interaction, as it does the scheme.
The shot of a proven interaction fast-forwards the CSS transitions its steps started, so the pixels
are the settled state and never a frame halfway to it.

A PR whose menu item paints only while the menu is open and the item highlighted reads:

```
--surface /lab/atolye/menu --interact '/lab/atolye/menu#sil-highlighted=click:role=button[name="Menü"];hover:role=menuitem[name="Sil"];expect:[role=menuitem][data-highlighted]:has-text("Sil")'
```

Each operand adds shots beside its surface's at-rest ones and replaces none, so one surface with two
interactions at one viewport is three captures. An interacted shot carries its label in its PNG name
after a `~` (`menu~sil-highlighted@desktop.png`, `menu~sil-highlighted@desktop-dark.png`), a
character a route's name never carries, and an `interaction` object on its manifest entry holding the
`label`, the `steps` it ran and what the page `proven` at each proving step, read off the page and
never echoed from the operand. The evidence gallery heads it `<surface> @ <viewport>[, scheme …][, accent …],
interaction <label>`, and every stderr line names the shot `with interaction <label>`. A run without
`--interact` keeps every name, entry and heading it had before.

The refusal on every other token is the same fence v1 stated, kept for the same reason: v1 demanded
`:focus-visible` captures with no mechanism to prove the state was realized, and a state that
silently rendered unfocused PASSed its prohibition forever. Parsing a state is not rendering one —
a token with no mechanism shoots the default pixels under a variant's name, which is coverage
claimed and not held. A focused shot is asked for through `--interact`'s `focus` step instead, which
carries exactly the `:focus-visible` proof v1 lacked. The sibling `ui` group renders in-tree with no
preview and no session, so it still refuses every `:state`.

**Output** — machine. One JSON object on full success only:

```
{"set": "judged", "pr": 4321, "head": "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c",
 "previewUrl": "https://app-pr-4321.example.workers.dev",
 "captures": [
   {"surface": "/feed", "viewport": "desktop", "path": "<abs>/judged/feed@desktop.png",
    "width": 1280, "height": 2140, "sha256": "…", "pageErrors": {"rows": [], "more": 0}}
 ]}
```

**The mechanism, in order — each step gates the next.** Resolve the PR and its live head (`7` /
`11`). Resolve the preview comment for `--app` (paginated sweep; anchor absent, or a
`none head:<sha>` marker naming the live head → `16`; anchor present but unparseable, or a `none`
marker naming another head → `11`). **Bind the preview to the head**: the comment's deployed SHA
must equal the live head — a preview that lags the push is `12`, because pixels of an old tree
bound to a new SHA are the stale-verdict class at the capture seam. **Fence the app axis**: every
surface resolves to its owning `uiSurfaces` row by longest claiming mount and that row to its app —
the leading segment of the row's `name`, so `web-lab` is `web`'s and `desk-chat` is `desk`'s — and
a surface whose app is not among the ones this preview announced is `11` before a browser launches,
naming every such surface. One origin is resolved for the run, so shooting a foreign surface at it
returns that app's not-found page: a clean PNG the outcome typing would record as `captured`. A
surface no declared row claims is shot as before — which app serves it is a question the list does
not answer either way. **Resolve the tier signing
secret** — the file `--auth-secret-from` names when one is passed, else the committed preview key at
`infra/preview-auth-key/key.txt` in the checkout this verb runs in, else the ambient variable — and
refuse on `11` before a browser launches when it cannot be read, is empty, or carries the `insecure_`
placeholder. The refusal names the source it read and the route out, and the route differs by source:
with no flag it is to run from a checkout that carries that committed key, which needs no flag, no
credential and no environment variable; with a flag it is to drop the flag, since the named file does
not hold the value this preview verifies against and the committed key resolves on its own.
For each `--surface` at each
`--viewport`, in the provisioned headless browser sized to that viewport: navigate to
`<previewUrl><route>`; status ≥ 400 or failed navigation is **unreachable** (`14`); an uncaught
page exception is **crashed** (`13`); otherwise screenshot full-page to
`<set>/<route-slug>@<viewport>.png` (`@<viewport>-<scheme>.png` for each `--scheme`, after its scheme proof; `<route-slug>~<label>@…` for each `--interact` on the surface, after its steps and their proofs) and validate (exists, non-zero bytes, decodable, non-zero area —
`15` on any failure), then **read the width back off those bytes** and refuse a shot that is not the
requested viewport's width (`19`).
`console.error` output is **recorded per capture in `pageErrors`, never a gate outcome** — the
crash/advisory split is the machinery's page-error module, and an empty list is only ever
written from a successfully-read error channel (v1's extractor returned empty on a parse failure,
fusing "no crashes" with "never looked"). Because nothing reads a row by name, it is an
evidence-array and prints collapsed to a bounded shape: `{"rows": [<first 3>], "more": <the rest>}`, with
`more` always present so a list capped at exactly its length reads as whole. The stderr
per-surface line counts the **whole** tally, not the kept rows. **Write the set manifest** `<set>/manifest.json`,
byte-identical to the stdout JSON — `post` reads the set through it, and a set without its
manifest is not a set.

Exit 0 requires **every** requested surface captured and valid at **every** requested viewport. `12` and `16` are run-level
refusals decided before the per-surface loop and never mix with its outcomes. When per-surface
outcomes mix, the reported code is the smallest applicable of `13`/`14`/`15` and stderr carries
every surface's outcome — the code routes, the stderr enumerates. Dropping a surface is the skill's explicit
re-invocation without it, on the record; never the tool's tolerance.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed |
| `10` | `--out` not kebab-case; a `--surface` names a `:state` outside the realized set (`auth`, `auth-caylak`, `auth-caylak-unverified`); a `--viewport` names a viewport outside the closed set (`desktop`, `mobile`) or is passed twice; a `--flag` operand is not a `<key>=<on\|off>` pair, or forces one key twice; `--flag` was passed beside an anonymous surface; `--locale` was passed with no `uiCapture.locale` declared, or with a value outside its declared list; a `--scheme` names a scheme outside the closed set (`light`, `dark`), is passed twice, or is passed with no `uiCapture.scheme` declared; `--accent` was passed with no `uiCapture.accent` declared, or with a value outside its declared list; or an `--interact` operand names an unknown step verb, an empty locator, key or label, a non-kebab label or no steps, names a surface no `--surface` asked for, would write the same PNG as another `--interact`, or ends on `click` or `press` |
| `11` | the PR/head/comment read failed; the declared `uiSurfaces` cannot be read, or `--locale`, `--scheme` or `--accent` was passed and the declared `uiCapture` cannot be read; the preview comment is present but malformed for `--app`, or `--app` is omitted while the comment names several apps; a `--surface` is served by an app this preview does not announce; the browser provision is broken; a capture's validity could not be determined; a tier-naming surface was requested while its identity's session token is in neither the environment nor the `PREVIEW_TEST_LOGINS` repository variable, while that variable could not be read or is set but malformed, while the resolved signing secret is empty or carries the `insecure_` placeholder, while `--auth-secret-from` names a file that could not be read, or while the repo root could not be located at all so the committed preview key was never looked for; a tier-naming surface's session proof did not come back signed in, came back at a tier the surface did not name, or came back with an email verification the surface did not name; a forced flag evaluated at its default anyway; a seeded shot's `document.documentElement.lang` did not read back as the `--locale` value; a scheme-crossed shot's declared root attribute did not read back as its `--scheme` value; an accented shot's declared root attribute did not read back as the `--accent` value; or an interacted shot's step found zero or several elements, timed out, or its `:hover`, `:focus-visible` or visible-match proof did not hold — no capture is written for it |
| `12` | proven: the preview comment's deployed SHA is not the PR's live head — stale preview; re-render after the preview catches up |
| `13` | proven: at least one surface threw an uncaught page error |
| `14` | proven: at least one surface is unreachable (status ≥ 400, failed navigation, no route, dark flag, gated tier) |
| `15` | proven: at least one capture is invalid (zero bytes, undecodable, zero area) |
| `16` | proven: this repo, or this PR, has no preview to judge — no comment carries the preview anchor, or the newest announcement is a `none head:<sha>` marker naming the live head |
| `19` | proven: a capture's PNG width, read back from its own bytes, is not the requested viewport's width — the requested viewport's render is UNKNOWN, and nothing was recorded under that label |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui render: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui render: PR #<n> is closed — nothing to judge.` | 7 | refusal |
| `review-ui render: --surface "<id>" names a :state nothing renders — the realized states are auth, auth-caylak, auth-caylak-unverified; render the bare route.` | 10 | refusal |
| `review-ui render: a tier-naming surface was requested but its credentials are incomplete (unset: <names>; <repo> has no PREVIEW_TEST_LOGINS repository variable to fetch them from) — the named tier's render is UNKNOWN, never a seeded substitute.` | 11 | refusal |
| `review-ui render: a tier-naming surface was requested but its credentials are incomplete (unset: <names>; <repo>'s PREVIEW_TEST_LOGINS repository variable does not carry them) — the named tier's render is UNKNOWN, never a seeded substitute.` | 11 | refusal |
| `review-ui render: a tier-naming surface was requested, its session token is not in the environment, and <repo>'s PREVIEW_TEST_LOGINS repository variable could not be read (<reason>) — the named tier's render is UNKNOWN.` | 11 | refusal |
| `review-ui render: a tier-naming surface was requested, its session token is not in the environment, and <repo>'s PREVIEW_TEST_LOGINS repository variable is set but <what is wrong with it>; its contents were not printed — the named tier's render is UNKNOWN.` | 11 | refusal |
| `review-ui render: a tier-naming surface was requested but <the source> carries the insecure_ placeholder prefix — a cookie signed with it is one the preview worker answers as a visitor — the named tier's render is UNKNOWN, never a cookie the worker will reject; <the route out>` | 11 | refusal |
| `review-ui render: a tier-naming surface was requested but <the source> is empty — there is no key to sign the tier cookie with — the named tier's render is UNKNOWN, never a cookie the worker will reject; <the route out>` | 11 | refusal |
| `review-ui render: cannot read the session-signing secret at <path>: <reason> — the named tier's render is UNKNOWN.` | 11 | refusal |
| `review-ui render: surface "<id>" at <viewport> did not render signed in (<reason>) — the authenticated render is UNKNOWN, never the anonymous one.` | 11 | refusal |
| `review-ui render: surface "<id>" at <viewport> named tier <wanted> and rendered as <rendered> — the named tier's render is UNKNOWN, never another tier's.` | 11 | refusal |
| `review-ui render: surface "<id>" at <viewport> named an email-<verified\|unverified> identity and rendered as an email-<unverified\|verified> one — the named identity's render is UNKNOWN, never another audience's.` | 11 | refusal |
| `review-ui render: --flag "<token>" is not a <key>=<on\|off> pair (<reason>) — an operand nothing can force would shoot the default state under the forced name.` | 10 | refusal |
| `review-ui render: --flag was passed with the anonymous surface "<id>" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name a tier state (auth, auth-caylak, auth-caylak-unverified) on every surface.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> did not render with its forced flags (<reason>) — the forced render is UNKNOWN, never the default one.` | 11 | refusal |
| `review-ui render: --locale "<value>" cannot be seeded (<reason>) — an operand nothing seeds would shoot the default locale under the requested name.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> in locale <value> did not render in its seeded locale (<reason>) — the seeded locale's render is UNKNOWN, never the default one.` | 11 | refusal |
| `review-ui render: --scheme "<name>" is not a colour scheme this verb renders — the names are light, dark.` | 10 | refusal |
| `review-ui render: --scheme "<name>" was passed twice — the second shot would overwrite the first's file and evidence.` | 10 | refusal |
| `review-ui render: --scheme "<name>" cannot be proved (this repo declares no uiCapture.scheme, so there is no root attribute to read the page's scheme from) — an unproved scheme would shoot the default one under the requested name.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> in scheme <scheme> did not resolve to the <scheme> scheme (<reason>) — the requested scheme's render is UNKNOWN, never the other one.` | 11 | refusal |
| `review-ui render: --accent "<value>" cannot be set (this repo declares no uiCapture.accent, so there is no root attribute to set it on) — an operand nothing sets would shoot the default accent under the requested name.` | 10 | refusal |
| `review-ui render: --accent "<value>" is not an accent this repo declares — the declared accents are <list>.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> in accent <value> did not render in the <value> accent (<reason>) — the requested accent's render is UNKNOWN, never the default one.` | 11 | refusal |
| `review-ui render: --interact "<operand>" is not <surface>#<label>=<step>;… over the steps hover, focus, expect, click, press (<reason>) — an operand nothing can run or prove would shoot the at-rest surface under the interacted name.` | 10 | refusal |
| `review-ui render: --interact "<operand>" names surface "<id>", which no --surface asked for — an interaction runs on a surface of this run.` | 10 | refusal |
| `review-ui render: --interact "<operand>" would write the same PNG as --interact "<other>" — the second shot would overwrite the first's file and evidence.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> with interaction <label> did not reach its interaction state (<step>: <reason>) — the interacted render is UNKNOWN, never the at-rest one; no capture was written.` | 11 | refusal |
| `review-ui render: --viewport "<name>" is not a viewport this repo renders — the names are desktop, mobile.` | 10 | refusal |
| `review-ui render: --viewport "<name>" was passed twice — the second shot would overwrite the first's file and evidence.` | 10 | refusal |
| `review-ui render: surface "<id>" at <viewport> was asked for at <wanted>px and its bytes read back <actual>px wide — the requested viewport's render is UNKNOWN, never another width's.` | 19 | refusal |
| `review-ui render: --out "<value>" is not a kebab-case set name.` | 10 | refusal |
| `review-ui render: cannot read <what> for #<n>: <reason> — the render is UNKNOWN.` | 11 | refusal |
| `review-ui render: the preview comment names apps <list> — pass --app to pick one.` | 11 | refusal |
| `review-ui render: --surface "<id>" is served by app "<app>" (row "<row>"), which this preview does not announce — it announces <list>; the shot would come back as an announced app's not-found page.` | 11 | refusal |
| `review-ui render: the preview comment carries the anchor but no parseable URL + SHA for app "<app>" — a malformed announcement is unreadable, not absent.` | 11 | refusal |
| `review-ui render: the preview deploys <deployed-sha7>, the live head is <head7> — stale preview; pixels of an old tree must not bind a new head (#4808's class).` | 12 | refusal |
| `review-ui render: surface "<id>" at <viewport> threw during render: <first page error> — the render is red; a broken page is not composition to judge.` | 13 | refusal |
| `review-ui render: surface "<id>" at <viewport> is unreachable at the preview (<reason>) — judge what renders, and hold the gap against the PR's Deviations (#4305).` | 14 | refusal |
| `review-ui render: surface "<id>" at <viewport> captured invalid bytes (<detail>) — a capture nobody can open is not evidence (#3925's class).` | 15 | refusal |
| `review-ui render: no preview-deploy comment on PR #<n> — nothing to judge without running the PR's code; the run is CANT-SEE.` | 16 | refusal |
| `review-ui render: PR #<n>'s preview comment marks no preview deploy at <head7> — nothing to judge without running the PR's code; the run is CANT-SEE.` | 16 | refusal |

**Scope** — exactly the `--surface` × `--viewport` × `--scheme` cross product against one PR's announced preview (no `--scheme` counts as one default-scheme column), every cell under the one `--accent` when it is passed, each surface's cell shot at rest and once per `--interact` on it. Zero operands
is `1`, so "rendered nothing, found nothing wrong" is unrepresentable — this verb fails closed on
zero scope like every other. The
per-surface outcome enumeration goes to stderr on every path, success included.

**Examples**

```
$ fabrika review-ui render --pr 4321 --out judged --surface /feed
{"set":"judged","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/feed","viewport":"desktop","path":"/tmp/fabrika-review-ui/4321-03135b91/judged/feed@desktop.png","width":1280,"height":2140,"sha256":"9c41…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out judged --surface /feed --surface /admin
review-ui render: surface "/feed" at desktop captured: 1280x2140, 0 page errors
review-ui render: surface "/admin" at desktop is unreachable at the preview (status 404) — judge what renders, and hold the gap against the PR's Deviations (#4305).
$ echo $?
14
```

```
$ fabrika review-ui render --pr 4321 --out narrow --surface /feed --viewport desktop --viewport mobile
review-ui render: surface "/feed" at desktop captured: 1280x2140, 0 page errors
review-ui render: surface "/feed" at mobile captured: 390x3180, 0 page errors
{"set":"narrow","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/feed","viewport":"desktop","path":"/tmp/fabrika-review-ui/4321-03135b91/narrow/feed@desktop.png","width":1280,"height":2140,"sha256":"9c41…","pageErrors":{"rows":[],"more":0}},{"surface":"/feed","viewport":"mobile","path":"/tmp/fabrika-review-ui/4321-03135b91/narrow/feed@mobile.png","width":390,"height":3180,"sha256":"1f7b…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out schemes --surface /feed --scheme light --scheme dark
review-ui render: surface "/feed" at desktop in scheme light captured: 1280x2140, 0 page errors
review-ui render: surface "/feed" at desktop in scheme dark captured: 1280x2140, 0 page errors
{"set":"schemes","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/feed","viewport":"desktop","scheme":{"requested":"light","proven":"light"},"path":"/tmp/fabrika-review-ui/4321-03135b91/schemes/feed@desktop-light.png","width":1280,"height":2140,"sha256":"9c41…","pageErrors":{"rows":[],"more":0}},{"surface":"/feed","viewport":"desktop","scheme":{"requested":"dark","proven":"dark"},"path":"/tmp/fabrika-review-ui/4321-03135b91/schemes/feed@desktop-dark.png","width":1280,"height":2140,"sha256":"41bb…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out amber --surface /feed --accent amber
review-ui render: surface "/feed" at desktop in accent amber captured: 1280x2140, 0 page error(s)
{"set":"amber","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/feed","viewport":"desktop","accent":{"requested":"amber","proven":"amber"},"path":"/tmp/fabrika-review-ui/4321-03135b91/amber/feed@desktop.png","width":1280,"height":2140,"sha256":"7d20…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out hovered --surface /lab/atolye/button --interact '/lab/atolye/button#danger-hovered=click:role=radio[name="Danger"];hover:role=button[name="Kaydet"]'
review-ui render: surface "/lab/atolye/button" at desktop captured: 1280x800, 0 page error(s)
review-ui render: surface "/lab/atolye/button" at desktop with interaction danger-hovered captured: 1280x800, 0 page error(s)
{"set":"hovered","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/lab/atolye/button","viewport":"desktop","path":"/tmp/fabrika-review-ui/4321-03135b91/hovered/lab-atolye-button@desktop.png","width":1280,"height":800,"sha256":"feda…","pageErrors":{"rows":[],"more":0}},{"surface":"/lab/atolye/button","viewport":"desktop","interaction":{"label":"danger-hovered","steps":["click:role=radio[name=\"Danger\"]","hover:role=button[name=\"Kaydet\"]"],"proven":["role=button[name=\"Kaydet\"] matches :hover"]},"path":"/tmp/fabrika-review-ui/4321-03135b91/hovered/lab-atolye-button~danger-hovered@desktop.png","width":1280,"height":800,"sha256":"ad52…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out forced --surface /welcome:auth --flag welcome-banner=on
review-ui render: surface "/welcome:auth" at desktop captured: 1280x1640, 0 page errors
{"set":"forced","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/welcome:auth","viewport":"desktop","path":"/tmp/fabrika-review-ui/4321-03135b91/forced/welcome-auth@desktop.png","width":1280,"height":1640,"sha256":"1f7b…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out caylak --surface /welcome:auth-caylak
review-ui render: surface "/welcome:auth-caylak" captured: 1280x1640, 0 page errors
{"set":"caylak","pr":4321,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","previewUrl":"https://app-pr-4321.example.workers.dev","captures":[{"surface":"/welcome:auth-caylak","path":"/tmp/fabrika-review-ui/4321-03135b91/caylak/welcome-auth-caylak.png","width":1280,"height":1640,"sha256":"4d02…","pageErrors":{"rows":[],"more":0}}]}
```

```
$ fabrika review-ui render --pr 4321 --out caylak --surface /welcome:auth-caylak
review-ui render: a tier-naming surface was requested but its credentials are incomplete (unset: PREVIEW_TEST_CAYLAK_SESSION_TOKEN; acme/app has no PREVIEW_TEST_LOGINS repository variable to fetch them from) — the named tier's render is UNKNOWN, never a seeded substitute.
$ echo $?
11
```

```
$ fabrika review-ui render --pr 4321 --out caylak --surface /welcome:auth-caylak
review-ui render: surface "/welcome:auth-caylak" at desktop did not render signed in (the preview answered the seeded cookie as a visitor: missing session row — its answer expired the session cookie, which is how the worker answers a signature it accepts for a token with no live session, so this preview's database was not seeded with this token, or the seeded session has expired) — the authenticated render is UNKNOWN, never the anonymous one.
$ echo $?
11
```

```
$ fabrika review-ui render --pr 4321 --out caylak --surface /welcome:auth-caylak
review-ui render: surface "/welcome:auth-caylak" named tier çaylak and rendered as yazar — the named tier's render is UNKNOWN, never another tier's.
$ echo $?
11
```

```
$ fabrika review-ui render --pr 4321 --out unverified --surface /welcome:auth-caylak-unverified
review-ui render: surface "/welcome:auth-caylak-unverified" at desktop named an email-unverified identity and rendered as an email-verified one — the named identity's render is UNKNOWN, never another audience's.
$ echo $?
11
```

```
$ fabrika review-ui render --pr 4321 --out forced --surface /welcome --flag welcome-banner=on
review-ui render: --flag was passed with the anonymous surface "/welcome" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name a tier state (auth, auth-caylak, auth-caylak-unverified) on every surface.
$ echo $?
10
```

**Grounding**

- **A crashed capture that read as a clean gate.** v1's capture invocation carried no status
  assertion and no capture-count check, so a crashed helper meant zero surfaces judged, zero
  violations, PASS. Here full success is the only `0`, and every shortfall is a named proven code.
- v1 S22 — the preview resolver took the first `workers.dev` URL anywhere in the comment (wrong
  app on multi-app comments), hardcoded the domain, and read one unpaginated page. The resolver
  module reads the app sub-line, any domain, paginated.
- **A verdict bound to a tree it never saw.** The deployed-SHA-equals-head bind (`12`) exists
  because v1 never checked that the preview it judged was the head it stamped.
- **A crashed page is not composition.** An uncaught exception is a red render (`13`), never a
  screenshot judged as a layout; `console.error` stays advisory data.
- **Unreachable is an outcome, not a skip.** It is a per-surface proven code (`14`) the skill must
  dispose of loudly; the disclosure fork (Deviations-named vs undisclosed) is the skill's.
- v1 S4 — v1's captures lived in an unrecorded `mktemp -d`: a PASS whose evidence upload failed
  was unauditable. The set path here is deterministic from PR + head, and the manifest records it.
- **A flag-off capture that passed for the feature.** The verb captured every flag at its default,
  so under the dark-ship norm the gate judged the off-path and said PASS. `--flag` is the fix, and
  its own proof exists because an override the preview dropped is the same clean-but-wrong capture.
- **One identity meant one audience.** A tier-only surface could not be rendered at all, and the
  yazar's shot of it came back `captured`, valid and decodable, showing the state the PR did not add.
  The audience rides the surface id, one seeded identity per realized state, and the session proof
  reads its tier and email verification back — the third instance of the same class the two bullets
  above name.

---

## `review-ui post`

**Invocation**

```
fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged [--carrier marker|advisory] [--supersede] [--repo <owner/name>]
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
| `--evidence` | string | yes | — | the `review-ui render` capture-set name whose verified upload is this verdict's evidence — exactly one per post; passing it twice is the `10` refusal, before anything is read, uploaded or posted |
| `--carrier` | enum | no | `marker` | `marker` (first-line SHA-bound marker) or `advisory` (§CP: advisory first line, `Reviewed-head: @ <sha>` body line). `advisory` is a PASS path only |
| `--supersede` | boolean | no | `false` | acknowledge that this verdict retires a standing one of the **opposite** polarity at this head; without it that post is the `18` refusal |
| `--repo` | string | no | resolved | the repository |
| stdin | markdown | yes | — | the verdict body below the first line: per-row findings with pixel evidence, the coverage table, advisories |

There is no `--namespace`: this verb emits `review-ui` and nothing else. The one-namespace group
is the structural form of "a gate never emits a namespace it did not judge" — the refusal
`review post` makes at runtime is unrepresentable here.

**Output** — machine. One JSON object:
`{"answer":"posted","namespace":"review-ui","polarity":"FAIL","sha":"03135b91","upsert":"created"|"superseded","carrier":"marker","surfaces":1,"commentUrl":"…"}`
— `surfaces` is the count of captures in the `--evidence` set's manifest, and `upsert` is
`superseded` whenever the write appended into a comment that already carried this namespace.

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
   the GitHub user-attachment tier otherwise, each upload read back). A fresh user-attachment URL
   reads `404` at its own address until posted content embeds it, so the attachment tier reads
   each upload back through GitHub's markdown renderer instead: the signed link the renderer gives
   the asset must answer `200` to an anonymous fetch and serve the capture's exact bytes. The tier choice reads the
   `uiCapture` key of `.fabrika.jsonc` at the repo root the delivery layer resolves — the reviewer's own
   checked-out tree, never the PR head, which this skill never checks out. Any failure is `17`,
   aggregated, **nothing posted**. This inverts v1's posture at the seam where a crashed capture
   still produced a verdict: judging the local bytes stands — the pixels you judged were local —
   but the *marker* does not land over a broken evidence channel. The upload stopped being decoration and became a
   precondition of the verdict's existence.
5. **Compose the comment**: first line through the wire format's `emit` (namespace `review-ui`,
   `--polarity`, `--sha`, `--clause`), or with `--carrier advisory` the fixed advisory line plus
   the `Reviewed-head: @ <sha>` body line; `advisory` with FAIL is a `10` refusal (a §CP FAIL
   posts the ordinary FAIL marker). Below it, the stdin body, then the evidence gallery — per
   surface, the verified hosted URL, and on the line after it
   `<!-- fabrika:evidence sha256=<hex> -->`, the digest of the judged capture. The digest renders
   as nothing; it is what lets a gate hold the hosted capture to the judged bytes later
   (`packages/fabrika-cli/src/review-ui/evidence-gallery.ts`).
6. **Leak-scan the assembled comment** (`5` / `6` — the imported predicates; a finding that must
   cite a leak cites it by class root or repo-relative form).
7. **Append into one comment for this namespace under this carrier** (the disjoint marker/advisory
   match keys, exactly as `review post` step 5 specifies them); a second stacked marker is
   un-anchored and fail-closes a passing PR. **The prior verdict is never replaced**: it is retired
   verbatim below the `<!-- fabrika:superseded -->` fence under a dated `## Superseded verdict —
   YYYY-MM-DD` heading, and the fresh verdict takes the first line so every marker reader resolves
   the newest one. GitHub keeps no comment-body history, so a PATCH over a verdict is that verdict
   gone: on one PR a FAIL became a PASS at an unchanged head and nothing showed a gate had ever
   blocked. When the write would retire a standing verdict of the **opposite** polarity at
   this head, it is the `18` refusal unless `--supersede` is passed, and nothing is posted — the
   flip is legitimate and routine, but it is the one the merge gate reads.
8. **Read it back, unconditionally, from live PR state** — the format's `read` (or the advisory
   anchors), then the whole comment through `normalizeForReadback` (`9` on mismatch). A
   read-back that trusts a carried variable re-ships the false-PASS class.
9. **Re-read the posted comment's evidence** — the comment's rendered HTML, each embedded
   capture's signed link fetched anonymously and held to its judged bytes. A capture that does not
   open is `9`, stated as posted: the verdict landed, so the verb never reports success over
   evidence nobody can see and names the comment to inspect. **The verb never withdraws or
   replaces that verdict** — deleting it loses the record, and restoring a prior body would put an
   older verdict back on the first line. It leaves the verdict as written (on a re-post, the prior
   verdict stays below the fence exactly as step 7 put it) and creates one plain comment beside it:
   `This review-ui verdict does not count: <verdict url>`, the reasons, and the re-post remedy. That
   note is the PR's record that a verdict was attempted and why it does not count; its first line is
   no verdict carrier. If the note fails to land, the exit is still `9` and stderr says so.

**What the gates count.** A posted `review-ui` verdict counts only while its evidence opens.
`ship gate` and `lane prove` re-read the in-force `review-ui` verdict before they count it — the
same step-9 read-back, held to the gallery's recorded sha256 because a gate has no local bytes —
and a verdict whose capture does not open, or whose gallery records no digest, does not count: the
gate rows it `unopened` and blocks, `lane prove` rows it `unopened` and proves no `PASS` over it. A
re-check that cannot read the comment is UNKNOWN (`ship gate` `11`, `lane prove` row `unknown`),
never a count. Only the gallery above the supersede fence is read, so a superseded verdict's
evidence never decides the one in force. This is the ruled direction — the readers re-check, the
verb never withdraws — and the `@ruling` tag in
`packages/fabrika-cli/src/review-ui/standing-evidence.ts` cites the ruling comment.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty verdict body would read as ungated |
| `4` | the `--evidence` set's `manifest.json` is absent or does not parse, or the declared `uiCapture` (the tier-choice read) violates its schema — whole-file rule |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference — the body never arrived |
| `7` | the PR is proven absent (404) or closed |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this marker, or an embedded capture in the posted comment does not open as its judged bytes |
| `10` | a bad `--polarity`; `--carrier advisory` with `--polarity FAIL`; a `--carrier` off its enum; `--evidence` passed more than once — a post carries one capture set, so the refusal names every set passed and lands before stdin, the manifest or any upload is touched |
| `11` | a precondition read failed — the PR, the live head, the evidence set's files, or the upload target's state; nothing was uploaded or posted |
| `12` | refused: the live head moved past `--sha`, or the evidence set was rendered at a different head — the verdict or its pixels would bind a tree that is not the PR |
| `15` | proven: a capture in the evidence set is invalid or fails its manifest sha |
| `17` | proven: at least one evidence upload or its verification failed — nothing was posted |
| `18` | refused: a standing verdict of the opposite polarity at this head would be retired and `--supersede` was not passed — nothing posted |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui post: no body on stdin — an empty verdict reads as ungated; pipe the verdict body in.` | 3 | refusal |
| `review-ui post: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review-ui post: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui post: PR #<n> is closed — a verdict on a closed PR gates nothing.` | 7 | refusal |
| `review-ui post: --polarity must be PASS or FAIL — got "<v>".` | 10 | refusal |
| `review-ui post: --carrier advisory is a PASS path only — post the FAIL marker instead.` | 10 | refusal |
| `review-ui post: --evidence was passed <k> times ("<set>", "<set>", …) — a post carries one capture set, and every set past the first would drop out of the gallery while the verdict still cites its shots. Render every judged surface into one set and pass it once; nothing was read, uploaded or posted.` | 10 | refusal |
| `review-ui post: cannot read <what> for #<n>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `review-ui post: evidence set "<set>" has no readable manifest.json (<absent|parse reason>) — a set without its manifest is not a set; re-run review-ui render.` | 4 | refusal |
| `review-ui post: .fabrika.jsonc declares a `uiCapture` that does not satisfy its schema: <first violation> — the tier choice is unmakeable.` | 4 | refusal |
| `review-ui post: the live head is <live>, not <sha> — the tree you judged is gone; re-review at <live> (ADR 0058).` | 12 | refusal |
| `review-ui post: evidence set "<set>" was rendered at <set-head7>, you are posting at <sha7> — stale pixels; re-render at the live head.` | 12 | refusal |
| `review-ui post: capture "<id>" in set "<set>" is invalid or fails its manifest sha (<detail>).` | 15 | refusal |
| `review-ui post: upload failed for <k> of <m> captures (<first surface>: <reason>) — refusing to post a verdict over a broken evidence channel (#3925).` | 17 | refusal |
| `review-ui post: the assembled comment carries a machine-local path at line <k> (<class>) — cite it repo-relative or by class root.` | 5 | refusal |
| `review-ui post: create/edit failed: <reason> — UNKNOWN whether the verdict landed; run \`fabrika review verdicts <n>\` before retrying.` | 8 | refusal |
| `review-ui post: posted, but the read-back does not yield this marker (<wire reason>) — inspect comment <id>.` | 9 | refusal |
| `review-ui post: POSTED, BUT ITS EVIDENCE DOES NOT OPEN — <k> of <m> embedded captures fail the read-back (<first reason>); the verdict in comment <id> stays on the PR and does not count — ship gate and lane prove re-check its evidence and will not count it while it does not open. Re-render and post again.` | 9 | refusal |
| `review-ui post: noted on the PR why this verdict does not count: <note url>` | 9 | notice |
| `review-ui post: the note saying this verdict does not count did not land (<reason>) — the gates re-check its evidence either way.` | 9 | notice |
| `review-ui post: a standing <PASS\|FAIL> for review-ui at <sha> would be superseded by this <PASS\|FAIL> — pass --supersede to retire it on the record. Nothing was posted.` | 18 | refusal |

**Scope** — one PR (its live head, its comments), one evidence set (its manifest and every
capture in it), the caller's stdin. Steps 1–4 failing on a read is `11` — nothing written,
outcome known-unwritten.

**Examples**

```
$ fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged < verdict.md
{"answer":"posted","namespace":"review-ui","polarity":"FAIL","sha":"03135b91","upsert":"created","carrier":"marker","surfaces":1,"commentUrl":"https://github.com/<owner>/<repo>/pull/4321#issuecomment-5154902211"}
```

```
$ fabrika review-ui post 4321 --polarity PASS --sha 03135b91 --clause "ok" --evidence judged < verdict.md
review-ui post: the live head is a1b2c3d4, not 03135b91 — the tree you judged is gone; re-review at a1b2c3d4 (ADR 0058).
$ echo $?
12
```

```
$ fabrika review-ui post 7081 --polarity PASS --sha 77f61ce9 --clause "merge-ready" --evidence judged < verdict.md
review-ui post: a standing FAIL for review-ui at 77f61ce9 would be superseded by this PASS — pass --supersede to retire it on the record. Nothing was posted.
$ echo $?
18
```

```
$ fabrika review-ui post 7081 --polarity PASS --sha 77f61ce9 --clause "merge-ready" --evidence judged --supersede < verdict.md
{"answer":"posted","namespace":"review-ui","polarity":"PASS","sha":"77f61ce9","upsert":"superseded","carrier":"marker","surfaces":1,"commentUrl":"https://github.com/<owner>/<repo>/pull/7081#issuecomment-5460446728"}
```

**Grounding**

- **An upload channel typed so failure could not surface.**
  (`packages/fabrika-cli/src/capture/upload.ts` — every transport failure degraded to
  `{hostedUrl: null, uploadError}` and no consumer ever read `uploadError`): the upload outcome
  was advisory by contract, so a wholly-failed channel decorated months of PASSes. Step 4 makes it
  a precondition; `17` is this contract's reason to exist.
- **Judge the local bytes, but do not post over a broken channel.** The *judged* source stays the
  local pixels; what changed is that the *verdict* cannot exist without its verified public
  evidence — audit trail and gate outcome stop being separable.
- v1 S14 — the comment id was `awk '{print $2}'` over a prose line; here the answer is one JSON
  object and the read-back is the format's own `read`.
- **One sanctioned emit, with an unconditional live-state read-back.** A hand-rolled `gh api`
  marker post is the incident, not an alternative.
- **The advisory carrier has a fixed shape and a PASS-only rule**, matched with `review post` so
  §CP reads one grammar across the review family; the old discarded-answer leg is gone because
  membership is the carrier input, never computed here.
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
{"answer":"noted","pr":4321,"commentId":512399,"commentUrl":"https://github.com/<owner>/<repo>/pull/4321#issuecomment-512399"}
```

**Grounding**

- v1 S23 — the can't-gate "plain note" had no sanctioned emit path and no read-back; a typed
  non-verdict write is the smallest cure that does not mint a second marker grammar.
- **Every write goes through a verb with a read-back.** A bare `gh api` comment is the incident,
  whatever the comment says.
- **The can't-see declaration this verb carries is a note, not a verdict.** Whether it later
  becomes a machine-read state is a decision still open, and the typed refusal of marker-shaped
  bodies keeps this verb from pre-empting it.

---

## `review-ui route`

**Invocation**

```
fabrika review-ui route 6326 --sha <head> --clause "<why>" [--verified-at <head> | --no-preview [--hand-check <comment>]] [--repo <owner/name>]
```

The reasoning arrives on **stdin only**, for the same reason as `post` and `note`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | yes | — | the head whose diff was read, 7–40 lowercase hex |
| `--clause` | string | yes | — | the one-line why, carried on the record's first line; blank is refused |
| `--verified-at` | string | no | none | the head a hand-verification standing in for the render ran at, 7–40 lowercase hex; the range to `--sha` is then read and a `ui`-class file in it refuses the route, as does a range the platform could not read whole or at all |
| `--no-preview` | boolean | no | `false` | the PR has no preview deploy: route under the repo's `reviewUi.whenNoPreview` rules instead of the diff; the verb checks the absence itself and refuses on `23` when a preview is announced; refused beside `--verified-at` |
| `--hand-check` | string | no | none | pin the owner's hand-check comment on this PR, as an id or a URL ending `#issuecomment-<id>`, instead of letting the verb find the newest one; implies `--no-preview` |
| `--repo` | string | no | resolved | the repository |
| stdin | markdown | yes | — | which files changed and why none of them renders anything, or, on a `--no-preview` route, why the PR has no preview and what stands in for the render |

**Output** — machine. One JSON object:
`{"answer":"routed","namespace":"review-ui","sha":"6c6fe226…","uiFiles":2,"verifiedAt":null,"basis":null,"textReview":"absent","upsert":"created","commentUrl":"…"}`,
or, where the diff raises no `ui` class and nothing is posted,
`{"answer":"none","namespace":"review-ui","sha":"6c6fe226…","uiFiles":0}`. `answer` is the closed
outcome token: `routed` or `none`.
`verifiedAt` is the `--verified-at` head the range was cleared over, and `null` where the route
rested on no hand-verification. `basis` is `hand-check` or `skip` on a `--no-preview` route and
`null` otherwise; it is the same token the record's first line carries. `handCheck` is the id of the
owner's comment a `hand-check` route stood on, and is absent on every other route. `textReview` is the `review-code` verdict this record rests on:
`pass` where one stands in force at `--sha`, `absent` where none binds that head — and `absent` is
reachable only on a prose-only or `skip` route, because a route carrying `--verified-at` or resting
on a `hand-check` is refused at `20` without one.

**Why it exists.** `ship scope` raises the `ui` class from a path test that cannot see whether
pixels moved, so a PR whose only change under a declared `uiSurfaces` prefix is prose requires this namespace — and
`render` refuses zero surfaces while `post` refuses without captures, so nothing legal could fill
it and `ship gate` blocked forever. This verb records the answer that was missing. It is
**not** a second verdict path: the `routed-elsewhere` wire format carries no polarity, so
`verdict-marker` reads it as `Absent` and it can never be counted as a PASS; `ship gate` resolves
it as its own `routed` state and admits it for `review-ui` alone; and the record is head-bound, so
any push voids it: a gate that owes no verdict still has to record that it owes none.

**The mechanism, in order.** Validate `--sha` and `--clause` (`10`). Read stdin (`3` on empty) —
an unexplained route is an assertion nobody can check. Resolve the PR, open and non-empty
(`7`/`11`). Refuse if the live head has moved past `--sha` (`12`): the record binds the tree whose
diff was read, and is re-read rather than re-bound. Read the changed-file list through
`review/local-file-set.ts`'s `platformFileSet`: the enumeration is the file set, and the
`changed_files` the pull-request record declares prints as a disagreement line rather than refusing,
because that count is computed against a base cached at the last push and no caller can invalidate
it. An **empty** list is `7` — the `ui` count would then be derived over a diff nobody read — and a
list at GitHub's 3000-file ceiling is `11`, because that is the one truncation the enumeration
cannot rule out on its own and it can only ever shrink the `ui` count. Answer `none` on exit `0` over a
diff that raises no `ui` class, writing nothing — nothing required
this namespace, so there is nothing to route, and that is a clean end rather than a refusal; the predicate is `review/classes.ts`'s own
`isUiSurface`, over the same declared `uiSurfaces` prefixes the gate raised the class from, never a
second copy. Read the PR's comments and resolve the `review-code` verdict in force at `--sha`; a
standing FAIL is `20`, and so is an absent verdict on a route carrying `--verified-at` or resting on
a `hand-check`. That read
runs **before** the `--verified-at` comparison below, so a route that is both spent at
`--verified-at` and standing-FAIL at `--sha` exits `20`, not `12` — a record asserting a text PASS
that is not there is unpostable at any head, while a spent hand-verification is cleared by re-running
it, so the text lane is the move to name first. With `--verified-at`, compare that head to `--sha`
and refuse on `12` when any file in
the range raises the `ui` class — the hand-verification is then spent and a fresh one is owed at
`--sha`; a comparison that came back at GitHub's 300-file ceiling is `11`, because the compare
declares no total and a capped list can only ever hide a `ui`-class file, and so is one whose two
heads have diverged, because the platform's three-dot compare then answers from their merge base and
the range was never read at all. With `--no-preview`, the mode is resolved right after the `ui`
class (`21` on `require-render`); the comments read then checks that no preview is announced
(`23`, or `11` when the announcement does not read) and, under `hand-check`, admits the owner's
hand-check (`21` with none found, `22` when a pinned one fails a fact), both before the text
verdict. Compose the record's first
line through the `routed-elsewhere` wire format, leak-scan the assembled comment (`5`/`6`), upsert
one record for this namespace on the emitter's own comment, and read it back from live state (`9` on
mismatch, `8` on an unproven write).

**The hand-verification's currency, and why the verb owns it.** An app that deploys to no preview
has no address the reviewer can render, so a route over it can rest on the builder's own
hand-verification instead — a run at the desk, posted with the head it ran at. That evidence stands
for the record's head exactly when no `ui`-class file changed in between, and a gate left to derive
that range by eye derives it differently or not at all. `--verified-at` moves the derivation here.
It is optional because a prose-only diff under a declared prefix rests on the body alone and has no
head to compare; where a hand-verification exists, naming it is what makes the record checkable.
Nothing about the `routed-elsewhere` bytes changes either way: the record stays head-bound to
`--sha` and carries no evidence field.

**The text review the record rests on.** An interim exception that lets a hand-verification stand
in for a render prescribes the clause such a record carries, and that clause asserts a text review
PASS beside the hand-verification. The verb used to post it while reading neither half, so a record
over a standing text FAIL and one over a PASS read identically — and the `routed-elsewhere` format
carries no polarity for a later reader to tell them apart. The text PASS is a precondition, not
commentary, and the verb reads it: it resolves the `review-code` verdict in force at `--sha` through
`review verdicts`' own two carriers — the `verdict-marker` first line and the §CP advisory — ordered
by `ship gate`'s `inForce`, judged current by the same `bindToContent`, and given the advisory's
polarity by the one `advisoryPolarity` its sibling readers call, so no two readers hold different
rules. That last one was a copy before it was shared, and the copy diverged: a `[FAIL]` row inside an
advisory is an invalid emission, and it cleared this route while `ship gate` refused on the same
comment. A standing FAIL refuses on `20`. An **absent** verdict refuses on `20` only where
`--verified-at` is passed or the route rests on a `hand-check`: each asserts the conjunction, while
a prose-only or `skip` route asserts nothing about the text lane and says so on stderr instead of
blocking. The host's native review fold
is `ship gate`'s widening and is not read here — the merge gate still reads it, and this verb only
judges what its own clause claims.

**A PR with no preview, under the repo's `reviewUi.whenNoPreview` rules.** A repo may say, by
path, what this gate needs when a PR has no preview deploy (`.fabrika.jsonc`,
`reviewUi.whenNoPreview`: a list of `{paths, mode}` rules). `--no-preview` resolves the mode over
the PR's `ui`-class files: the first rule whose glob matches a file sets its mode, a file no rule
matches is `require-render`, and the PR takes the strictest — `require-render`, then `hand-check`,
then `skip`. The verb then acts on it:

**The verb checks the "no preview" itself.** Before it routes, it reads the PR's preview
announcement through the same resolver `review-ui render` uses for its exit `16`, and it routes only
where `render` would refuse there for want of one. An announced preview, at this head, behind it or
naming several apps, refuses on `23`: a render can run, so no rule may stand in for it. An
announcement that does not read is `11`. So `--no-preview` is never the caller's word alone.

- `require-render` refuses on `21`. A render is owed, so no preview is CANT-SEE, exactly as with no
  rules at all.
- `skip` posts the record with `basis:skip` on its first line. The standing `review-code` FAIL
  refusal still holds; an absent text verdict does not refuse.
- `hand-check` needs the owner's hand-check. **The owner's hand-check is admissible evidence here**:
  a comment on this PR, by an account on the control-plane roster `.github/CODEOWNERS` names, that
  names the PR's exact head (a 7–40 hex prefix of it) and carries at least one screenshot. The verb
  reads the PR's comments and stands on the newest one that passes all four facts; with none, it
  refuses on `21`. `--hand-check <comment>` pins one instead, and a pinned comment that fails a fact
  refuses on `22`. It stands in for the render the way a desk run does, so it rests on a standing
  `review-code` PASS at `--sha` too (`20` without one). The record carries `basis:hand-check` and a
  closing line naming the comment and its author. Under a `skip` mode a pinned hand-check is checked
  the same way and recorded as `hand-check`.

**A `21`, and a `22`, carries the note for the PR on stderr.** The lines between
`----- note begins -----` and `----- note ends -----` are the body the skill sends to
`review-ui note` unchanged, composed in `review-ui/cant-see-note.ts` from what this run read. Under
`hand-check` it carries a comment to paste with the live head filled in, says that the comment needs
a screenshot image, that an owner posts it and an agent does not, and that a new push needs a new
one. It then lists up to three of the newest comments that name the head and fail exactly one other
fact, each with the fact it failed: an owner's comment with no screenshot, or a screenshot from an
account off the roster. A comment that fails both is not an attempt and is not listed, and neither is
a verdict or an earlier copy of this note. The pasteable comment holds a text placeholder where the
image goes, never image markup, so the note cannot be admitted as the hand-check it asks for. Under
`require-render` the note names the files that set the mode and lists the four ways through: a
preview deploy, the builder's own run of the app, a `hand-check` rule, a `skip` rule.

Both flags ride the record's first line, so `ship gate` still reads the namespace as `routed` and
flags the row with the basis, and `lane prove` carries it onto the namespace row it records. `lane
report` writes it on the `PASS` line as `routedBasis`, and `table flags` raises `not-rendered` on the
board row off it.

**What this verb does not decide.** Whether the diff renders anything. That is the skill's judgment
over `review diff`'s refusal-guarded bytes. Narrowing the `ui` path class instead was proposed and
rejected: no path test can decide whether pixels moved, so a verb that tried would just
relocate the defect. This verb takes the judgment as `--clause` plus a body and records it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `0` with `"answer":"none"` | the diff raises no `ui` class — nothing required this namespace, so nothing was posted |
| `7` | the PR is proven absent (404), closed, has zero changed files, or is served an empty changed-file list |
| `8` | the create/edit failed — UNKNOWN whether the record landed |
| `9` | the record landed but does not read back as sent |
| `10` | `--sha` or `--verified-at` is not a head SHA, `--clause` is blank, `--hand-check` names no comment, or `--verified-at` is passed beside `--no-preview` |
| `11` | a precondition read failed, the changed-file list came back at GitHub's 3000-file ceiling, or the `--verified-at` comparison came back at the 300-file ceiling or between two diverged heads — nothing was posted |
| `12` | the live head moved past `--sha` — the diff you read is gone; or a `ui`-class file changed between `--verified-at` and `--sha`, so the hand-verification is spent |
| `20` | the `review-code` verdict in force at `--sha` is a FAIL, or a route resting on `--verified-at` or an owner's hand-check has no `review-code` verdict binding that head |
| `21` | a `--no-preview` route the repo's `reviewUi.whenNoPreview` rules do not admit: the PR resolves `require-render`, or `hand-check` with no owner's hand-check at the head on the PR |
| `22` | the `--hand-check` comment is not an owner's hand-check: not on this PR, not by a control-plane account, naming no head this PR is at, or carrying no screenshot |
| `23` | a `--no-preview` route over a PR that announces a preview, at the head, behind it, or for several apps |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `review-ui route: no body on stdin — a route with no reasoning is an assertion nobody can check; pipe the reasoning in.` | 3 | refusal |
| `review-ui route: the assembled comment carries a machine-local path at line <k> (<class>).` | 5 | refusal |
| `review-ui route: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `review-ui route: PR #<n> not found in <repo>.` | 7 | refusal |
| `review-ui route: PR #<n> is closed — a route on a closed PR resolves nothing.` | 7 | refusal |
| `review-ui route: GitHub served no changed files for #<n> against the <m> its own pull-request record declares — refusing to derive the ui class from a diff nobody read.` | 7 | refusal |
| `review-ui route: create/edit failed: <reason> — UNKNOWN whether the route landed; re-read the PR before retrying.` | 8 | refusal |
| `review-ui route: posted, but the read-back does not yield this record (<why>) — inspect comment <id>.` | 9 | refusal |
| `review-ui route: --sha "<value>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review-ui route: --clause is blank — a route with no stated reason records nothing a reader can check.` | 10 | refusal |
| `review-ui route: --verified-at "<value>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `review-ui route: --verified-at and --no-preview name two different routes — a desk run at an earlier head, or the repo's no-preview rules at this one; pass one.` | 10 | refusal |
| `review-ui route: --hand-check "<value>" is not a comment id or a comment URL ending in #issuecomment-<id>.` | 10 | refusal |
| `review-ui route: GitHub's file list for #<n> came back at its 3000-file ceiling, so the list is provably partial — a ui-class file could sit in the part the platform never served.` | 11 | refusal |
| `review-ui route: the comparison over <verified>..<sha> came back at GitHub's 300-file ceiling — refusing to clear the hand-verification against a capped read.` | 11 | refusal |
| `review-ui route: <verified> is <status> of <sha>, not an ancestor — the comparison answers from their merge base, so <verified>..<sha> was never read. Re-run the hand-verification at <sha>.` | 11 | refusal |
| `review-ui route: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `review-ui route: the live head is <live>, not <sha> — the diff you read is gone; re-read at <live>.` | 12 | refusal |
| `review-ui route: <files> raise the ui class in <verified>..<sha> — the hand-verification at <verified> is spent; re-run it at <sha>.` | 12 | refusal |
| `review-ui route: review-code stands FAIL at <sha> (comment <id>) — this record would assert a text PASS that is not there; repair the finding and route at the head the text gate passes.` | 20 | refusal |
| `review-ui route: no standing review-code verdict binds <sha>, and a route resting on a hand-verification asserts one — land the text verdict first, and read what stands with fabrika review verdicts <n>.` | 20 | refusal |
| `review-ui route: reviewUi.whenNoPreview resolves require-render for #<n> (<files>) — a render is owed, so a PR with no preview is CANT-SEE, never routed.` | 21 | refusal |
| `review-ui route: reviewUi.whenNoPreview resolves hand-check for #<n>, and no comment on it is an owner's hand-check at <head> — a control-plane account's screenshots naming this head; with none posted, the PR is CANT-SEE.` | 21 | refusal |
| `review-ui route: cannot read <roster> — whether an owner's hand-check stands on #<n> is UNKNOWN; nothing was posted.` | 11 | refusal |
| `review-ui route: comment <id> <why it is not an owner's hand-check at this head>; nothing was posted.` | 22 | refusal |
| `review-ui route: #<n>'s preview comment carries the anchor but does not read (<reason>) — whether a preview exists is UNKNOWN; nothing was posted.` | 11 | refusal |
| `review-ui route: #<n> announces a <app> preview at <sha> — a render can run, so a no-preview rule cannot stand in for it; run review-ui render.` | 23 | refusal |
| `review-ui route: #<n> announces a <app> preview at <deployed>, not yet at <sha> — this PR deploys previews, so wait for it to redeploy and render; a no-preview rule cannot stand in for it.` | 23 | refusal |
| `review-ui route: #<n> announces a preview for <apps> — a render can run, so a no-preview rule cannot stand in for it; run review-ui render --app <app>.` | 23 | refusal |

**Scope** — one PR, one comment write, the caller's stdin.

**Example**

```
$ fabrika review-ui route 6326 --sha 6c6fe226 \
    --clause "no rendered delta; both changed files are prose only" <<'EOF'
`shell-keys.ts` rewrites one JSDoc paragraph to drop a `pipeline-cli` reference — no statement,
export or type changed. `design-token-lint.config.json` rewrites two note strings; the guard's
data fields are byte-identical. No component, route, token or style is touched.
EOF
{"answer":"routed","namespace":"review-ui","sha":"6c6fe226","uiFiles":2,"verifiedAt":null,"basis":null,"textReview":"absent","upsert":"created","commentUrl":"https://github.com/<owner>/<repo>/pull/6326#issuecomment-5123990412"}
```

A route resting on a hand-verification names the head it ran at, and the range decides whether it
still stands:

```
$ fabrika review-ui route 4471 --sha fb01065b --verified-at 8efd315a \
    --clause "no rendered delta; the app deploys to no preview, hand-verified at the desk" <<'EOF'
The desk run at `8efd315a` drove every readout this diff touches. `8efd315a..fb01065b` is one
commit under `packages/<cli>/`, so the composition is byte-identical.
EOF
{"answer":"routed","namespace":"review-ui","sha":"fb01065b","uiFiles":3,"verifiedAt":"8efd315a","basis":null,"textReview":"pass","upsert":"created","commentUrl":"https://github.com/<owner>/<repo>/pull/4471#issuecomment-5598041887"}

$ fabrika review-ui route 4471 --sha fb01065b --verified-at 8efd315a --clause "…" < why.md
review-ui route: scanned 2 files changed in 8efd315a..fb01065b; 2 raise the ui class.
review-ui route: apps/<app>/src/window/usage.tsx, apps/<app>/src/page/reply-row.tsx raise the ui
class in 8efd315a..fb01065b — the hand-verification at 8efd315a is spent; re-run it at fb01065b.
# exit 12

$ fabrika review-ui route 4471 --sha 9c40aa71 --verified-at 8efd315a --clause "…" < why.md
review-ui route: 8efd315a is diverged of 9c40aa71, not an ancestor — the comparison answers from
their merge base, so 8efd315a..9c40aa71 was never read. Re-run the hand-verification at 9c40aa71.
# exit 11

$ fabrika review-ui route 4471 --sha fb01065b --verified-at fb01065b --clause "…" < why.md
review-ui route: scanned 6 comments.
review-ui route: scanned 2 review-code claims; FAIL at fb01065b via the marker carrier.
review-ui route: review-code stands FAIL at fb01065b (comment 5598219196) — this record would
assert a text PASS that is not there; repair the finding and route at the head the text gate passes.
# exit 20
```

A PR with no preview, in a repo whose `.fabrika.jsonc` declares
`"reviewUi": {"whenNoPreview": [{"paths": ["apps/admin/**"], "mode": "hand-check"}]}`:

```
$ fabrika review-ui route 5210 --sha 3a9e41c0 --no-preview \
    --clause "no preview; the owner hand-checked this head" <<'EOF'
apps/admin deploys to no preview. The owner's screenshots of the two changed readouts at 3a9e41c0
stand in for the render.
EOF
{"answer":"routed","namespace":"review-ui","sha":"3a9e41c0","uiFiles":2,"verifiedAt":null,"basis":"hand-check","handCheck":5870011234,"textReview":"pass","upsert":"created","commentUrl":"https://github.com/<owner>/<repo>/pull/5210#issuecomment-5870019876"}
```

With no owner's hand-check at `3a9e41c0` on the PR, the same route refuses on `21`. On a PR whose
preview comment announces a deploy, it refuses on `23` and names the preview to render.

**Grounding**

- **Two rules that could not both hold.** The `ui` class is raised by a path test, and the gate
  demanded a namespace nothing legal could fill; recording the routed answer is the shape that
  keeps both, rather than narrowing the class.
- **The zero-scope rules this verb inherits rather than loosens**: `render` still refuses zero
  surfaces, `post` still refuses without captures, and this verb refuses a diff nobody read (an
  empty changed-file list) — while a diff it did read that raises no `ui` class is not a refusal:
  it answers `none` on exit `0` and writes nothing.
- **The record is authored**, so the write+ ACL binds it at `ship gate` exactly as it binds a
  verdict marker.
- **A hand-verification's currency is the verb's judgment, not the gate's**, and it binds the
  `ui` files' content rather than the record's own head — a commit that moves no rendered surface
  keeps the evidence rather than spending a desk session to re-prove it.
- **The text PASS a hand-verification clause asserts is read, not assumed** — a standing
  `review-code` FAIL at the record's head refuses the route, and the reader is `review verdicts`'
  own, so the two gates cannot answer one question differently.
- **The head binding**, and why a moved head is re-read rather than re-bound.
- **A repo decides, by path, what a PR with no preview needs.** The rules only loosen the gate
  where a repo declared them, the strictest file decides, and both looser outcomes are flagged on
  the record rather than read as a render.

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own the group-local rows; the universal `0/1/126/127`
live once in the shared matrix, which owns every code's single meaning); every error names
message, stream, and code; every verb states scope and zero-scope behavior (`render` refuses
zero surfaces at `1`; `post` refuses an empty body at `3` and an unreadable evidence set at
`4`/`11`; `note` refuses an empty body at `3` and a verdict-shaped body at `10`; `route` refuses an
empty body at `3` and an empty changed-file list at `7`, and answers `none` on exit `0` over a diff
raising no `ui` class); and no clause
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
`3`/`5`/`6`/`8`/`9` posting seats with `post`; `route` shares all of those and binds
head-to-`--sha` on the same `12` as `post`).
