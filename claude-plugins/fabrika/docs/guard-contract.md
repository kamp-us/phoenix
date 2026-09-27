# `guard` — derived CLI contract

The `guard` group has no skill of its own, so this page is its contract: what each guard judges, how
it scopes itself and why the check exists. Caller facts — invocation, flags, stdout, exit meanings
and an example — are in each leaf's `--help`, which ends on a pointer to its section here. Read one
section by its heading:

`fabrika wire doc-section --heading "readme-guard check" < <plugin-root>/docs/guard-contract.md`

Every leaf except `design-inventory generate` shares one output shape: a one-line all-clear on
stdout, and on a red the report on stderr with GitHub `::error` annotations beside it under Actions.
`design-inventory generate` is a write, so it prints the file it wrote and its primitive count
instead of an all-clear, and it never reds on a violation. Every leaf, that one included, reds on
zero scope rather than passing vacuously. The shared verdict taxonomy is
[`guard/verdict.ts`](../../../packages/fabrika-cli/src/guard/verdict.ts).

## readme-guard check

Fails the build unless every real `packages/*` workspace member holds a `README.md`. A real member
is a directory carrying a `package.json`; a dead-shell directory is ignored.

This leaf judges every member. `fabrika build check` runs the same rule over only the members its
diff adds or edits, so a tree whose older packages predate the rule is not red on a lane that never
touched them. Under that change scope the declared-glob and zero-member floors still read the whole
tree.

Zero scope is no member scanned, or `pnpm-workspace.yaml` no longer declaring `packages/*`.

## skill-lint check

Walks `claude-plugins/` and reds on any of four mechanical defects in the skill and agent corpus:

- a GraphQL-path `gh` invocation, because this org's GitHub access is REST only;
- a `SKILL.md` or `agents/*.md` frontmatter block that does not parse as strict YAML;
- a bare `git push` in a runnable block;
- a repo-relative `./claude-plugins/…` literal inside a fence, which cannot resolve in a consumer's
  install.

Prose naming a forbidden form is untouched; only runnable text is judged. Zero scope is nothing
walked, a plugin directory that contributed no file, or a check that saw no file.

## no-gh check

Walks `packages/fabrika-cli/src/` and reds on any invocation of the `gh` binary, in all three
spellings: the binary named in argv position to any spawner, a shell string that runs it under a
`-c` argument, and the same string reached after a shell operator.

Every GitHub call belongs on the fetch client in `src/io/gh-api.ts`, so a verb runs where no `gh` is
installed. Comments are stripped before matching and a command string is judged only beside a spawn,
so the package's own prose and test fixtures are untouched. The sanctioned credential leg is allowed
by file and by matched text, never file-wide.

Zero scope is nothing walked, or a directory that contributed no file.

## portability-guard check

Walks `claude-plugins/fabrika/` and `packages/fabrika-cli/src/` and reds on any reference that
resolves only in the repository fabrika is developed in: a ticket number, a decision-record number
in either spelling, a decision-corpus path, a hosted issue or pull-request URL, and any name declared
under the `portability` key of the repo config.

These are not references:

- a markdown heading;
- a hex colour;
- a ticket number that is test data: a string literal in a `*.test.ts` file, or anything under a
  fixtures directory;
- an `@ruling <issue or pull-request URL>` citation under `packages/fabrika-cli/`, which is how a
  docblock there names the ruling that governs it. Only the tag's own span is admitted, and a tag
  naming no URL admits nothing.

The allow-list at `portability-guard.config.json` carries two buckets, each entry with a mandatory
`why`. `exempt` is a permanent per-file cap. `unmigrated` is the sweep floor and only shrinks, so a
ceiling left above the count reds too.

Zero scope is a root walked to nothing, a directory that contributed no file, or an unusable
allow-list. A violation is a reference found, a ceiling exceeded, or a floor row sitting above its
count.

## homing-guard check

Every `status:triaged` issue must carry either an arc/campaign milestone or exactly one of the two
standing-lane labels, `wayfinder:backlog` and `axis:pipeline-hardening`. Neither is a violation, and
both is banned outright.

`--issue N` scopes the scan to the one issue triage just stamped, which is where the invariant
binds; a bare run sweeps the whole open triaged backlog. Zero scope is a backlog sweep that found no
triaged issue at all.

## pitch-guard check

Every lane-entering issue — a `status:triaged` `type:epic`, or a `status:triaged` `type:feature` with
no parent — must carry a five-field `## Pitch` section (Problem, Arc, Appetite, Rabbit-holes,
No-gos) and a founder approval. Either carrier gives it:

- a `bet` on the table: the issue's row on the table project with Stage `bet` and a Size equal to
  the body's size. A `bet` on an epic or chain row approves the head and every member, bound by the
  row's Size. A `bet` counts when a write+ collaborator set the Stage, an agent under their token
  included;
- a `pitch-approved: appetite <S|M|L>` comment naming the same size the body declares.

A table that does not read (none configured, a token without the `project` scope, or a failed read)
approves nothing and is named on stderr, and the comments decide as before.

`**Appetite:**` is a size, `S`, `M` or `L`, whose dollar amount per epic child `.fabrika.jsonc`
`appetiteSizes` sets (shipped S = $15, M = $35, L = $40). A legacy `<N> cycles` appetite still
reads, approved only by a `pitch-approved: appetite <N> cycles` comment. An optional `**Success:**`
line names the one sentence the two-week check judges; a pitch without it is still well-formed. A
body appetite that differs from the approved one needs re-approval. Approval is resolved at the
GitHub ACL, write or above only and fail-closed, and a marker stamped with agent provenance never
counts. A `.fabrika.jsonc` that refuses to read leaves the verdict UNKNOWN.

`--issue N` scopes the scan to the issue triage just stamped, which is the intake point the
requirement binds at; a bare run sweeps the whole open lane-entering backlog. This guard binds at
intake only and is never wired to red a pull request. Zero scope is a backlog sweep that found no
lane-entering issue at all.

## roadmap-guard check

Validates `ROADMAP.md`'s founder-voice `## Arcs` and `## Campaigns` tables against the live GitHub
milestone projection. `ROADMAP.md` is the only parsed surface; the milestones are what it is checked
against. The invariants are the ones
[`guard/roadmap.ts`](../../../packages/fabrika-cli/src/guard/roadmap.ts) states:

- I1: every arc and campaign row pins an existing milestone by number; a queued arc may defer.
- I2: exactly one arc is active.
- I3: every open milestone is claimed by some row.
- I4: zero rows or zero milestones fails closed.
- I5: an active or paused row's milestone is open, and a done row's is closed.

I6, the focus-row check, retired with the `## Focus` table it kept honest.

## unresolved-threads-guard check

Reds when a live unresolved inline review thread, human or CodeQL/GHAS bot, is not accounted for in
the latest authorized `review-code` verdict. The verdict accounts for a thread by naming its
`path:line`.

The check is polarity-blind: a FAIL row naming the site accounts for it exactly as a PASS does, so
what it catches is the silent omission, not the objection. Zero threads is a clean, proven pass; the
fail-closed case is a thread channel that could not be read. A pull request that is not found is
zero scope.

## settings-env-guard check

Reds when any `.claude/settings.json` `env` value carries an unexpanded `${...}` token. Claude Code
applies env values verbatim and expands nothing in them, so such a token never resolves and is used
literally. An empty or absent `env` block is a real pass; the fail-closed case is the file itself.

## catalog-guard check

Every dependency in every workspace `package.json`, the root manifest included, must come from the
pnpm `catalog:` or a `workspace:` ref, never a hardcoded version string, because a second version of
one dependency breaks frozen-lockfile CI downstream. A genuinely unavoidable exception lives in the
guard's explicit reasoned allowlist, never a silent tolerance.

## fanout-guard check

Three invariants over the worker's `Fate.mutation` set:

1. every mutation is classified fanned or not in the fanned-mutations manifest;
2. every fanned mutation's feature publishes a `/fate/live` invalidation;
3. every declared topic is still reachable from that feature's `live.ts` binding.

The omission is invisible at the mutation site, because the publisher's error channel is `never`,
so nothing at the call site forces it; a mis-aimed topic needs the third invariant on top. Zero scope
is no mutation discovered, or a manifest that parsed to no rows.

## patch-guard check

Every maintained `pnpm patch` must carry at least one registered behavior-pinning test, and no pin
may be stale. A patch is a silent fork of a dependency's behaviour, so the rule requires a test that
fails if the patched behaviour regresses. That test registers itself with a
`// @patch-pin: <name>@<version>` marker keyed to the exact `patchedDependencies` entry
(`.patterns/dependency-patch-behavior-pins.md`).

## pointer-guard check

Every backticked repo-root-relative path in a git-tracked `CLAUDE.md` must resolve on disk or be
gitignored; a deliberately absent generated path such as `apps/site/.env` is a valid pointer.

The `doc-links` gate cannot see this class: it validates `[text](path)` links and masks code spans by
construction, so a backticked prose pointer rots unseen when its target moves. Only unambiguous
root-relative tokens are read, so a bare basename or an app-relative fragment is left alone.

## publish-isolation-guard check

Every package the release pipeline ships must install from a clean registry. A `workspace:` link or
an `@kampus/*` dependency, direct or `npm:`-aliased, passes only when its target is itself
published. A path-form `workspace:../…`, `link:`, `file:` or `portal:` dependency always reds.

The published set is derived from `publish.yml`'s resolve arms, keyed on the directory each arm
publishes rather than hand-kept, so it cannot drift from what actually publishes. Zero scope is no
published package derived, or an arm that names no single member: no `PKG_DIR`, no member there, a
package name that does not match the tag prefix, or a name another member shares.

## leak-guard scan

Scans the handed files for machine-local filesystem paths in shared-artifact surfaces: markdown docs
and `.sh` scripts. A `.sh` file is scanned whole, because a shell comment is the likeliest place for
one to land. The scanner scopes itself, so a caller may hand it every changed file. Zero scope is an
empty file list.

## path-filter-guard check

`ci.yml`'s `changes.e2e` and `deploy.yml`'s `changes.deploy` dorny/paths-filter steps must classify
a pull request's diff identically: the same globs and the same `(token, base)` diff basis.

Deploy's run-set must be a superset of e2e's, because `ci.yml`'s `e2e` job polls `deploy.yml`'s
sticky preview-deploy comment on a 10-minute deadline. A pull request that trips e2e while its deploy
skips times that poll out and wedges the required `ci-required` check. Equal globs are not enough:
the two steps' `token` and `base` inputs decide which changed-file set the globs apply to, so the two
can drift while the lists stay byte-identical.

Zero scope is a missing file, job, step or key, or an empty list.

## change-detect-guard check

`ci.yml`'s `changes` job must detect changed files with a pure `git diff`, never the GitHub API.
dorny/paths-filter calls `pulls.listFiles` whenever a `token` is set and falls back to `git diff`
only when it is empty, and the action defaults the token, so an absent `token:` selects API mode too.
That live API read is the job's only flake surface, and a transient blip in it reds the `ci-required`
aggregate on a defect-free pull request.

Zero scope is no `changes` job, no paths-filter step, or no `with:` block.

## codeowners-cp check

Every path the §CP boundary regex marks control-plane must have a covering `.github/CODEOWNERS` row.
The boundary is one anchored regex and CODEOWNERS enumerates the same paths literally, so the two
drift silently. The `main` ruleset pairs `required_approving_review_count: 0` with
`require_code_owner_review: true`, so a path matching no row merges with zero approvals. The §CP set
is derived from the boundary constant, never a re-hardcoded copy.

Zero scope is no CODEOWNERS, no owned rows, or a boundary resolving to no paths.

## decisions-index validate

The ADR number lock. Every record in the corpus `decisionsDir` declares carries the four index
fields, its filename number and its frontmatter `id` name the same ADR, and no two records claim one
id. The two halves compose: the duplicate check only sees a filename collision because the
prefix-to-id lock forces both axes to agree, so two branches each minting the same number, green
apart, are caught once both land.

A repo declaring `decisionsDir: null` keeps no corpus, so the guard is skipped with success and that
declaration named; a declared absence is not the zero-scope red. Zero scope is a declared corpus
directory that is missing or holds no records.

## design-token-guard check

The first deterministic rung of the four-pillars design law in `design-system-manifest.md`: a component CSS file
must consume the design-token layer. Three rules:

- every `var(--…)` resolves to a declared, runtime-injected or grandfathered property, because a
  dead ref renders unstyled with nothing failing;
- no hex literal outside the raw-scale layer `tokens.css` (Pillar 2);
- no raw `px` above 2px beyond each file's grandfathered ceiling, because the 4px grid sanctions only
  1px and 2px.

The bounded allow-lists in `packages/design/design-token-lint.config.json` grandfather the catalogued
debt, so the gate is green on main while still redding any new bypass. `--write-baseline`
re-snapshots the ceilings after a real cleanup leg. Zero scope is no CSS file discovered, or a
malformed allow-list config.

## design-inventory check

Re-extracts the descriptive component inventory from the JSDoc on the annotated
`packages/design/src` primitives and reds when the committed `design-system-inventory.md` no longer
matches it. The inventory is what an agent reads to pick a primitive, so a stale one silently routes
every reader to a component contract that is not what ships. Zero scope is no annotated primitive
discovered.

## design-inventory generate

Regenerates `design-system-inventory.md` from the annotated `packages/design/src` primitives. It is
the one write in this group, and the only command whose output `design-inventory check` compares
against. The write routes through the descriptive/normative firewall, which admits the inventory and
nothing else: the founder-authored `design-system-manifest.md` — the four pillars, the
prohibitions, the role-token values — has no path here, so normative law can
only change by a human's hand.

## i18n-guard check

Scans every non-test `src/**/*.{ts,tsx}` in the scanned app, outside its `i18n/` and `lab/`
directories, and reds on a Turkish character (çğıöşü, either case) inside a string literal or a run
of JSX text. Copy that lives in a component can never render in English, which is why it belongs
behind the typed catalog. Comments, regex literals and unquoted object keys are not copy and are not
judged.

The bounded allow-list beside the catalog carries two buckets, `exempt` for the permanently Turkish
(a wire enum value, a product alphabet, a lab surface) and `unmigrated` for tracked debt. Each entry
is a per-file ceiling with a mandatory `why`, so the gate is green today while redding any new
literal. Zero scope is no file scanned, or a malformed allow-list config.
