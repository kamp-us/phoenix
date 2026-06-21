---
name: canon
description: Author and maintain phoenix's `.patterns/*.md` docs from source so they stop drifting by hand — the patterns-maintenance counterpart to the `glossary` skill (which maintains `.glossary/TERMS.md`). Derives each pattern doc from phoenix's own in-repo code (`apps/web/worker`, `packages/`) and the grounding refs `CLAUDE.md` mandates (effect-smol `LLMS.md`/`ai-docs/`, fate, alchemy-effect), and lands it in the existing flat `.patterns/` house style with an `.patterns/index.md` table row — never a foreign-shaped `<subject>/` subtree. Two modes — bootstrap (seed a missing/thin doc from a fresh source read) and incremental refresh (update one doc whose source moved). Trigger on "canon a pattern", "author a pattern doc", "refresh `.patterns/<x>` from source", "the patterns drifted from the code", "ground `.patterns/<x>` in source", "bootstrap a pattern doc", "/canon". NOT an architecture audit (that files issues — `architecture-audit`), NOT the domain-noun glossary (`.glossary/TERMS.md` — `glossary`), NOT the `.decisions/` *why* surface (`adr`); this skill edits `.patterns/` only.
---

# canon

You author and maintain `.patterns/*.md` — phoenix's **how-the-code-is-shaped** doc
surface: the evergreen references (effect-*, fate-*, alchemy-*, feature-*, …) every
`write-code` run grounds in before it touches a service. A pattern doc nobody refreshes
rots: it lags the live `apps/web/worker`/`packages` code it describes, drifts from the
grounding sources `CLAUDE.md` mandates, and then **actively misleads** every agent that
trusts it. Your job is to keep that *how*-knowledge current against the source that is the
authority — the same leverage the `glossary` skill gives the *what*-vocabulary.

This is the **phoenix-native** counterpart to the personal `/canon` skill. That one clones
a **foreign** library and emits a `<subject>/` subtree of pure library knowledge; this one
mines **phoenix's own source** (and the cited grounding refs) and emits a **flat
`.patterns/<name>.md`** in the existing house style, with a row in `.patterns/index.md`. The
mining discipline is shared — read docs + types + tests, document every valid approach with
complete code, never invent an API — but the source, the output shape, and the doc-surface
rules are phoenix's, not the generic skill's.

You operate on **one surface and one only**: `.patterns/*.md` (the docs + their
`index.md`). You are **read-only on application code** — you read `apps/web/worker`,
`packages/`, and the grounding refs to *learn* the pattern; you never change them. You do
**not** open a PR, run a gate, or touch GitHub issues as part of your core loop — this is a
working-tree doc-maintenance skill, not a pipeline-execution skill. (When a `write-code` run
*dispatched* you to produce this edit, the surrounding flow opens the PR and `review-skill`
or `review-doc` gates it; your job ends at a correct, committed edit under `.patterns/`.)

## Scope — what this skill is, and what it is NOT

- **It maintains `.patterns/*.md` only** — the how-the-code-is-shaped surface. It edits the
  pattern docs and `.patterns/index.md`'s routing table; it touches nothing else.
- **NOT the `.decisions/` *why* surface.** `.patterns/` describes *how the current code is
  shaped*; the *why* (the binding decision + its history, including superseded approaches)
  lives in `.decisions/` and is recorded with the `adr` skill. When you find yourself wanting
  to write down a rationale or a decision rather than a shape, that belongs in an ADR — link
  to it from the pattern (`[ADR 0082](../.decisions/0082-…​.md)`), don't re-derive it here. A
  pattern doc that re-litigates an ADR's *why* is the drift `CLAUDE.md` calls out (collapse it
  to a `// See ADR NNNN`-style pointer).
- **NOT the domain-noun glossary.** `.glossary/TERMS.md` (maintained by the `glossary` skill)
  holds the canonical *nouns*; `.glossary/LANGUAGE.md` holds the architecture vocabulary. This
  skill *uses* those terms when it names a module or a concern — it never edits them.
- **NOT an architecture audit.** It does not sweep for shallow modules / refactor candidates
  and it does **not** file issues — that is `architecture-audit`. canon's output is a pattern
  doc, never a triageable finding.
- **NOT intake.** It does not file, classify, or prioritize GitHub issues — that is `report` /
  `triage`. The only thing it produces is an edit under `.patterns/`.

## Repo-agnostic — resolve the target once

This skill is **repo-agnostic** (the pipeline suite is an installable plugin — ADR 0062). It
never hardcodes a repo. When you need the GitHub target (e.g. to cite an issue/ADR number in
a doc), resolve it once, at the top of your run, per the shared contract's **Target repo
resolution** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

In phoenix this defaults to `kamp-us/phoenix` with no config (ADR 0062 §1). The **paths
themselves are repo-relative** — `.patterns/` at the repo root — resolved from the working
tree, never an absolute or home path. Resolve the repo root with
`git rev-parse --show-toplevel` and operate on `<root>/.patterns/`.

## The source you mine — in-repo code + the grounding refs (NOT a foreign clone)

The generic `/canon` clones one foreign library; phoenix-native canon's source is **phoenix's
own code plus the references `CLAUDE.md` mandates**. The repo is the authority — when a
pattern doc and the source disagree, the **source wins and the doc is what you fix**.

Mine, in this priority order:

1. **Phoenix's in-repo source** — the live shape the pattern describes:
   - `apps/web/worker/**` — services, the fate seam, the worker entry, the DO, tests.
   - `packages/**` — the shared internal packages (`fate-effect`, `epic-ledger`,
     `crabbox-manifest`, …).
   - **The tests are first-class source.** `*.unit.test.ts` and the `integration/` suites
     show the author's canonical usage; a test that exercises an approach *is* the example
     (cleaned up), exactly as the generic skill takes examples from a library's tests.
2. **The grounding refs `CLAUDE.md` mandates** — the upstream truth phoenix builds on, so the
   doc tracks the documented idiom over intuition (per `CLAUDE.md`, "Ground Effect API/design
   decisions in effect-smol's `LLMS.md` over intuition"):
   - **effect-smol `LLMS.md` and its `ai-docs/` examples** — the canonical Effect v4 idioms.
     When the documented idiom and a "cleaner" instinct conflict, the documented idiom wins;
     cite it by section.
   - **[fate](https://github.com/usirin/fate)** — the data-protocol substrate the `fate-*`
     docs describe.
   - **[alchemy-effect](https://github.com/usirin/alchemy-effect)** — the infra substrate the
     `alchemy-*` docs describe.
3. **The existing doc surfaces** — `.decisions/` for the *why* a pattern points at, and
   `.glossary/` for the canonical names to call things. Read these to *reference* them
   correctly, never to copy their content into a pattern.

A pattern doc is grounded **only** in what you actually read in (1)–(2). Every rule,
anti-pattern, and default traces to a type, a test, a doc section, or a source line you saw —
if you can't point to where the source enforces it, it's opinion, not canon: cut it.

## The output you produce — flat `.patterns/<name>.md`, house style (NOT a subtree)

Study the live docs before you write — `effect-testing.md`, `feature-services.md`,
`effect-context-service.md` are the house-style exemplars. Mirror what you see; the shape
below is the floor, not a replacement for reading the real files.

- **Flat file, not a subtree.** The doc is `<root>/.patterns/<name>.md` — never
  `.patterns/<subject>/index.md`. The name is the concern in the repo's existing grammar:
  `effect-*` for the Effect domain layer, `fate-*` for the protocol/client layers, `alchemy-*`
  for infra, `feature-*`/`worker-*` for app-layout concerns. Match an existing prefix; coin a
  new one only for a genuinely new layer.
- **House-style sections.** Phoenix pattern docs lead with a one-line statement of what the
  doc is + an ADR pointer where one binds, then **tables and short prose**: a tier/approach
  table, fenced TypeScript examples taken from the repo, a "which to use" decision table,
  rules, anti-patterns, and a **`## See also`** list of repo-relative links. Adopt the shape
  of the neighbouring doc in the same layer rather than imposing the generic skill's fixed
  `## Approaches / ## Decision guide / ## Rules / ## Anti-patterns` skeleton — phoenix docs
  vary by layer, and a canon doc must read like the docs beside it.
- **Standard markdown links, repo-relative — never wikilinks.** Link a sibling pattern as
  `[effect-testing.md](./effect-testing.md)`, an ADR as
  `[ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)`, source as
  `[`Vote.unit.test.ts`](../apps/web/worker/features/vote/Vote.unit.test.ts)`. Cite an ADR/issue
  by number and link by repo-relative path. **No Obsidian `[[wikilinks]]`, no
  machine-absolute / home / vault paths.** (This is the in-repo doc rule from `CLAUDE.md`.)
- **Comments earn their place — in the examples too.** The code examples you write follow the
  repo's comment bar: a load-bearing note stays, narration of obvious control flow goes, a
  re-derived *why* collapses to a `// See ADR NNNN` pointer. Don't ship example code buried in
  boilerplate comments a reader skips.
- **No stale markers.** No "as of" / "currently" / version pins (unless a paradigm shift like
  the effect v4 cutover is the point). The doc is evergreen.
- **Update `.patterns/index.md`.** Every doc you add or rename gets its routing-table row
  fixed (see [Always update the index](#always-update-the-index)).

## The bar — honor `.patterns/index.md`'s "when to add a new pattern doc"

Read the **"When to add a new pattern doc here"** section at the bottom of
[`.patterns/index.md`](https://github.com/kamp-us/phoenix/blob/main/.patterns/index.md) and
apply it as the gate — **do not restate or fork the criteria here; the index is the single
source.** In short: a doc earns
its place when the pattern is used in **2+ places** and future agents need it, it is
**non-obvious from reading the code** (it codifies a design choice, not visible structure),
and a future agent would **invent a worse version** without it. Don't add a doc for a one-off,
something obvious from the code, or migration steps.

This bar is what makes canon a *maintenance* skill, not a doc generator: you author a new doc
only when a real, repeated, non-obvious pattern exists in the source and lacks one — exactly
the `CLAUDE.md` rule "if you rely on a pattern not yet in `.patterns/`, add or extend a doc."
When the source carries no such pattern, the honest output is **no new doc** (refresh an
existing one, or a clean no-op). A doc that fails the bar is the noise the index exists to
keep out.

---

## Mode selection — bootstrap vs. incremental refresh

Pick the mode from the state of the doc and what you were asked to do (the same two-mode split
the `glossary` skill uses):

- **Bootstrap** when the pattern doc is **absent or thin** — there's no doc for a real,
  repeated, non-obvious pattern that clears the index bar, or an existing doc is a stub that
  doesn't cover the decision surfaces in the source. *Or* when you're explicitly asked to
  "bootstrap / author a pattern doc for X". You read the source for that concern and write the
  doc from the ground up.
- **Incremental refresh** when the doc **already exists and is populated**, and the trigger is
  that the **source moved**: a service was renamed, an API changed shape, a new approach
  landed, an ADR superseded the one the doc cites, "the patterns drifted from the code", or
  "refresh `.patterns/<x>`". You touch only what the source change moved — update the drifted
  sections, re-ground the examples, fix the cross-references — and leave the rest intact.

When in doubt, prefer incremental: a populated doc usually carries hand-curated nuance that a
wholesale rewrite would lose. Bootstrap is the cold-start case for a genuinely missing pattern.

---

## Bootstrap mode — author a doc from a source read

Run it when there's no doc worth preserving for a pattern that clears the index bar.

1. **Confirm the doc earns its place.** Before reading deeply, sanity-check the concern
   against the index bar above: is the pattern used in 2+ places, non-obvious from the code,
   and a thing agents would otherwise get wrong? If not — stop; there's no doc to write. List
   the existing docs so you slot into the right layer/prefix and don't duplicate one:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   ls "$ROOT"/.patterns/*.md
   ```

2. **Read the source for the concern, in layers** (the generic skill's read order, pointed at
   phoenix's source + grounding refs). Stop as soon as you can name the decision surfaces and
   every valid approach:
   - **Layer 1 — the grounding ref + neighbouring docs** (the intended idiom): the relevant
     effect-smol `LLMS.md`/`ai-docs/` section (or fate / alchemy-effect), and the sibling
     `.patterns/` docs in the same layer for house style and cross-refs.
   - **Layer 2 — the in-repo types & shapes** (what the code actually allows): the service
     classes, the `Schema`/`Context.Service` declarations, the public exports under
     `apps/web/worker/**` and `packages/**`.
   - **Layer 3 — the tests** (how phoenix validates it): the `*.unit.test.ts` and
     `integration/` suites for the concern — the canonical usage and the edge cases that
     become anti-patterns.
   - **Layer 4 — the call sites** (why it's shaped this way): read source only where types +
     tests leave ambiguity — constructors, boundary functions, the seams agents call directly.

   **Read budget:** ~15–20 files for one concern. Past it without having named the decision
   surfaces → you're reading too broadly; zoom in.

3. **Name the decision surfaces.** A concern is a point where an agent must choose an approach
   and could choose wrong. The filter: *"would an agent pick the wrong approach or invent a
   non-existent API without this doc?"* — yes → it belongs in the doc; no → skip it. One doc
   covers one concern (e.g. *testing*, *error modeling*, *the fate source contract*); if the
   source surfaces two genuinely separate decision surfaces, that's two docs.

4. **Write the doc** in the house style: the one-line what-it-is + ADR pointer, the
   approach/tier table, repo-grounded fenced examples (taken from the tests/source, not
   invented), the decision table, rules, anti-patterns, and `## See also`. Keep examples
   complete enough to copy-adapt. Ground every claim in what you read; cite the grounding ref
   by section where the idiom comes from upstream. Edit `<root>/.patterns/<name>.md` directly.

5. **Update `.patterns/index.md`** — add the routing-table row in the right layer section (see
   [Always update the index](#always-update-the-index)).

---

## Incremental-refresh mode — re-ground the doc against the moved source

The steady state: the doc exists, the source moved, and the doc must catch up to **just** the
change. Surgical — touch the drifted parts, preserve everything else.

1. **Scope the drift to the diff since the doc last moved.** The doc's git history dates the
   last update; scan what changed in the source it describes since then, not the whole repo:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   # the commit that last touched this pattern doc — the lower bound of "what changed since"
   LAST=$(git -C "$ROOT" log -1 --format=%H -- .patterns/<name>.md)
   # the source surfaces that changed since then (scope to the dirs the doc describes)
   git -C "$ROOT" diff --name-status "$LAST"..HEAD -- apps packages
   ```

   If the doc has never been committed, that's the bootstrap case. If `LAST` is empty for
   another reason, fall back to the working-tree diff
   (`git -C "$ROOT" diff --name-status HEAD -- apps packages`).

2. **Classify each source change against the doc:**
   - **A new approach / API shape** the doc doesn't cover → **add** the section, grounded in
     the new tests/source.
   - **A renamed symbol or moved file** the doc names → **update** the reference (the prose,
     the example, the `See also` link target).
   - **A changed default / contract** → **re-ground** the affected example and rule against
     the new source; a paraphrased default that no longer matches the source constant is the
     most common drift — fix it verbatim.
   - **A superseding ADR** → re-point the doc's ADR citation to the current decision and align
     the prose to it (the *why* stays in the ADR; the doc tracks the *shape*).
   - **No doc impact** (an internal refactor that moves nothing the doc describes) → **no
     edit.** Not every diff moves a pattern; an honest no-op is correct.

3. **Apply the minimal edit.** Change only the drifted sections. Don't reformat untouched
   prose, don't regenerate examples you didn't need to change, don't re-order the whole doc — a
   noisy diff buries the one real change and risks clobbering a hand-curated nuance.

4. **Re-check cross-references and the index.** If the change renamed the doc or altered what
   it covers, fix its `.patterns/index.md` row; if it added/removed a `See also` target,
   reconcile the link.

The result of either mode is a **clean, committed edit under `.patterns/`** and nothing else —
no code change, no issue, no PR (the dispatching `write-code` flow, when there is one, owns the
PR and the gate).

---

## Always update the index

`.patterns/index.md` is the routing table `write-code` reads to find the doc — a doc with no
row is a doc no agent finds. Whenever you add or rename a doc, fix its row:

- **Add** a row in the **layer section** the doc belongs to (*Effect domain layer*, *fate
  protocol layer*, *fate client layer*, *alchemy infra layer*, *Lint tooling*, *CI /
  pipeline*) — match the existing `| Doc | Topic | Read when |` shape, with a standard
  repo-relative link `[<name>.md](./<name>.md)` and a one-line "read when" framed from the
  agent's task ("Adding a feature service", not "Feature service patterns").
- **Rename** a row's link + label when you rename a doc; never leave a dangling link.
- Keep the row's "read when" honest to what the doc covers after your edit.

Don't touch index rows for docs you didn't change — a small index diff mirrors a small doc
diff.

---

## Verify before you hand off

Run mechanically — don't self-assess, actually check (the generic skill's verify gate, pointed
at phoenix's surface):

```bash
ROOT="$(git rev-parse --show-toplevel)"
# 1. cross-refs resolve: every relative link target in the docs you touched exists
grep -roh '](\.\?\.\?/[^)]*\.md)' "$ROOT"/.patterns/<name>.md | sed 's/^](//; s/)$//'
# 2. no wikilinks / leaked absolute paths
grep -nE '\[\[|/Users/|\$USIRIN_VAULT_PATH|file://' "$ROOT"/.patterns/<name>.md && echo "LEAK — fix" || echo "links clean"
# 3. no stale markers
grep -niE 'as of|currently|at the time|in newer versions|when available' "$ROOT"/.patterns/<name>.md && echo "stale marker — fix" || echo "no stale markers"
# 4. the index row exists for the doc
grep -n '<name>.md' "$ROOT"/.patterns/index.md || echo "MISSING index row — add it"
```

Then, by judgment: for the doc — **name the specific mistake an agent makes without it**;
can't name one → it fails the index bar, don't ship it. For each approach documented — **point
to where you found it** (a grounding-ref section, a type, a test, a source line); an approach
you can't trace to the source is invented → cut it. For each default/contract — confirm it
matches the source verbatim, not a paraphrase.

---

## Conventions

This skill is one of the pipeline suite; the shared formats, label semantics, and the
target-repo resolution it cites live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). The surface this skill
maintains is the repo's **how-the-code-is-shaped** doc surface (`.patterns/`), one of the four
that sit alongside `CLAUDE.md`, `.decisions/`, and `.glossary/`:

- **One surface, `.patterns/` only.** The pattern docs + `index.md` are the whole reach. The
  *why* lives in `.decisions/` (`adr`), the *nouns* in `.glossary/` (`glossary`), conventions
  in `CLAUDE.md`. Don't widen past `.patterns/`.
- **Source is the source of truth.** Every pattern is derived from phoenix's code + the
  grounding refs; when the doc and the source disagree, fix the doc, never the source.
- **Flat house style, not a subtree.** A doc is `.patterns/<name>.md` in the existing grammar
  with an index row — never a foreign-shaped `<subject>/` tree (the one real divergence from
  the personal `/canon`).
- **The index bar gates a new doc.** Author a doc only when the concern clears
  `.patterns/index.md`'s "when to add" criteria; an honest no-op beats a doc that fails the bar.
- **Surgical in refresh mode.** Touch only the drifted sections; a small diff is the point.
  Wholesale rewrite is the bootstrap exception, not the steady state.
- **Standard md links, no leaked paths.** Repo-relative `[text](path)` into `.patterns/` /
  `.decisions/` / source; never an absolute, home, vault, or Obsidian-wikilink path.
- **Read-only on code, doc-only output.** It reads the source to learn the pattern and never
  edits it; it files no issue and opens no PR — the dispatching `write-code` flow owns the PR,
  and `review-skill`/`review-doc` the gate.
