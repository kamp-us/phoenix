---
name: canon
description: Author and maintain this repo's `.patterns/*.md` docs from source so they stop drifting by hand — the patterns-maintenance counterpart to the `glossary` skill (which maintains `.glossary/TERMS.md`). Derives each pattern doc from the repo's own in-repo code and the grounding sources `CLAUDE.md` mandates, and lands it in the existing flat `.patterns/` house style with an `.patterns/index.md` table row — never a foreign-shaped `<subject>/` subtree. Two modes — bootstrap (seed a missing/thin doc from a fresh source read) and incremental refresh (update one doc whose source moved). Trigger on "canon a pattern", "author a pattern doc", "refresh `.patterns/<x>` from source", "the patterns drifted from the code", "ground `.patterns/<x>` in source", "bootstrap a pattern doc", "/canon". NOT an architecture audit (that files issues — `architecture-audit`), NOT the domain-noun glossary (`.glossary/TERMS.md` — `glossary`), NOT the `.decisions/` *why* surface (`adr`); this skill edits `.patterns/` only.
---

# canon

You author and maintain `.patterns/*.md` — the repo's **how-the-code-is-shaped** doc
surface: the evergreen references every `write-code` run grounds in before it touches a
service. A pattern doc nobody refreshes rots — it lags the live code, drifts from the
grounding sources `CLAUDE.md` mandates, and then **actively misleads** every agent that
trusts it. Your job is to keep that *how*-knowledge current against the source that is the
authority — the leverage the `glossary` skill gives the *what*-vocabulary. (Unlike the
generic `/canon`, which clones a **foreign** library into a `<subject>/` subtree, this skill
mines **the repo's own source** and emits a **flat `.patterns/<name>.md`** in the house style
with a row in `.patterns/index.md`.)

You operate on **one surface only**: `.patterns/*.md` (the docs + their `index.md`). You are
**read-only on application code** — you read the repo source and the grounding sources to
*learn* the pattern; you never change them, file an issue, or open a PR. (When a `write-code`
run *dispatched* you, the surrounding flow opens the PR and a review gate handles it; your job
ends at a correct, committed edit under `.patterns/`.)

## Scope — what this skill is, and what it is NOT

The repo's knowledge is split across surfaces; canon owns exactly one. Stay in your lane:

- **`.patterns/` only — the how-the-code-is-shaped surface.** You edit the pattern docs and
  `.patterns/index.md`'s routing table; nothing else.
- **NOT the `.decisions/` *why* surface.** `.patterns/` describes *how the current code is
  shaped*; the *why* (the binding decision + its history) lives in `.decisions/`, recorded with
  the `adr` skill. A rationale belongs in an ADR — link to it, don't re-derive it; a pattern
  doc that re-litigates an ADR's *why* is drift, collapse it to a pointer at the ADR.
- **NOT the `.glossary/` noun surface.** The canonical *nouns* live in `.glossary/` (the
  `glossary` skill). This skill *uses* those terms when it names a module or concern.
- **NOT an architecture audit** (that sweeps for refactor candidates and files issues —
  `architecture-audit`) and **NOT intake** (filing/classifying issues — `report` / `triage`).
  The only thing canon produces is an edit under `.patterns/`.

## Repo-agnostic — resolve the target once

This skill is **repo-agnostic** (the pipeline suite is an installable plugin). It never
hardcodes a repo. When you need the GitHub target (e.g. to cite an issue/ADR number), resolve
it once, at the top of your run, per the shared contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

The **paths themselves are repo-relative** — `.patterns/` at the repo root — resolved from
the working tree, never an absolute or home path. Resolve the repo root with
`git rev-parse --show-toplevel` and operate on `<root>/.patterns/`.

## The source you mine — in-repo code + the grounding sources `CLAUDE.md` mandates

Your source is **the repo's own code plus the grounding sources `CLAUDE.md` mandates** — not a
foreign clone. The repo is the authority: when a doc and the source disagree, **fix the doc**.
Mine, in this priority order:

1. **The repo's in-repo source** — the live shape the pattern describes. Read the feature/
   service code and the shared packages the concern lives in.
   - **The tests are first-class source.** A test that exercises an approach *is* the example
     (cleaned up), exactly as the generic skill takes examples from a library's tests. Mine
     the unit + integration suites for the canonical usage and the edge cases.
2. **The grounding sources `CLAUDE.md` mandates.** Read `CLAUDE.md` for the conventions on
   grounding (the rule that platform/runtime/dependency claims and API/design decisions are
   grounded in an authoritative source over intuition) and **follow it** — read the sources it
   names and cite them by section. `CLAUDE.md` is the single source for *which* sources those
   are; do not enumerate them here, because they change.
3. **The neighbouring doc surfaces** — `.decisions/` for the *why* a pattern points at, and
   `.glossary/` for the canonical names. Read these to *reference* them correctly, never to
   copy their content into a pattern.

A pattern doc is grounded **only** in what you actually read in (1)–(2). Every rule,
anti-pattern, and default traces to a type, a test, a doc section, or a source line you saw —
if you can't point to where the source enforces it, it's opinion, not canon: cut it.

## The output you produce — flat `.patterns/<name>.md`, house style (NOT a subtree)

**Study the live docs before you write — mirror the neighbouring `.patterns/*.md` doc in the
same layer.** The shape below is the floor, not a replacement for reading the real files.

- **Flat file, not a subtree.** The doc is `<root>/.patterns/<name>.md` — never
  `.patterns/<subject>/index.md`. **Read `.patterns/index.md` for the layer-prefix grammar and
  the when-to-add criteria; apply them as written.** Match an existing prefix; coin a new one
  only for a genuinely new layer.
- **House-style sections.** Lead with a one-line what-it-is + an ADR pointer where one binds,
  then **tables and short prose** (an approach table, repo-grounded fenced examples, a
  "which to use" table, rules, anti-patterns, a `## See also`). Adopt the shape of the
  neighbouring doc in the same layer rather than imposing a fixed skeleton.
- **Standard markdown links, repo-relative — never wikilinks.** Cite an ADR/issue by number,
  link by repo-relative path. **No Obsidian `[[wikilinks]]`, no machine-absolute / home / vault
  paths** (the in-repo doc rule from `CLAUDE.md`).
- **Comments earn their place — in the examples too** (the comment bar in `CLAUDE.md`): a
  load-bearing note stays, narration goes, a re-derived *why* collapses to an ADR pointer.
- **No stale markers.** No "as of" / "currently" / version pins (unless a paradigm shift is
  the point). The doc is evergreen.
- **Update `.patterns/index.md`.** Every doc you add or rename gets its routing-table row
  fixed (see [Always update the index](#always-update-the-index)).

## The bar — read `.patterns/index.md`'s "when to add a new pattern doc"

**Read the "when to add a new pattern doc" criteria in `.patterns/index.md` and apply them as
the gate as written — do not restate or fork them here; the index is the single source.** This
bar is what makes canon a *maintenance* skill, not a doc generator: when the source carries no
pattern that clears it, the honest output is **no new doc** (refresh an existing one, or a clean
no-op).

---

## Mode selection — bootstrap vs. incremental refresh

Pick the mode from the state of the doc and the ask (the same two-mode split the `glossary`
skill uses):

- **Bootstrap** when the doc is **absent or thin** — no doc for a pattern that clears the index
  bar, or an existing doc is a stub that misses the decision surfaces in the source — or when
  explicitly asked to "bootstrap / author a pattern doc for X". You write the doc from the
  ground up.
- **Incremental refresh** when the doc **exists and is populated** and the **source moved** (a
  rename, an API shape change, a new approach, a superseding ADR, "the patterns drifted").

When in doubt, prefer incremental: a populated doc carries hand-curated nuance a wholesale
rewrite would lose.

---

## Bootstrap mode — author a doc from a source read

Run it when there's no doc worth preserving for a pattern that clears the index bar.

1. **Confirm the doc earns its place** against the index bar above. If it fails — stop;
   there's no doc to write. List the existing docs so you slot into the right layer/prefix and
   don't duplicate one:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   ls "$ROOT"/.patterns/*.md
   ```

2. **Read the source for the concern, in layers.** Stop as soon as you can name the decision
   surfaces and every valid approach:
   - **Layer 1 — the grounding source + neighbouring docs** (the intended idiom): the relevant
     section of the source `CLAUDE.md` names, and the sibling `.patterns/` docs in the same
     layer for house style and cross-refs.
   - **Layer 2 — the in-repo types & shapes** (what the code actually allows): the service
     classes, the schema/service declarations, the public exports.
   - **Layer 3 — the tests** (how the repo validates it): the unit + integration suites for
     the concern — the canonical usage and the edge cases that become anti-patterns.
   - **Layer 4 — the call sites** (why it's shaped this way): read source only where types +
     tests leave ambiguity — constructors, boundary functions, the seams agents call directly.

   Read the concern's source, not the whole repo: once you can name the decision surfaces,
   you've read enough. If you're still reading broadly without having named them, zoom in.

3. **Name the decision surfaces.** A concern is a point where an agent must choose an approach
   and could choose wrong. The filter: *"would an agent pick the wrong approach or invent a
   non-existent API without this doc?"* — yes → it belongs in the doc; no → skip it. One doc
   covers one concern; if the source surfaces two genuinely separate decision surfaces, that's
   two docs.

4. **Write the doc** in the house style: the one-line what-it-is + ADR pointer, the
   approach/tier table, repo-grounded fenced examples (taken from the tests/source, not
   invented), the decision table, rules, anti-patterns, and `## See also`. Keep examples
   complete enough to copy-adapt. Ground every claim in what you read; cite the grounding
   source by section where the idiom comes from upstream. Edit `<root>/.patterns/<name>.md`
   directly.

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
   git -C "$ROOT" diff --name-status "$LAST"..HEAD -- <source-dirs>
   ```

   If the doc has never been committed, that's the bootstrap case. If `LAST` is empty for
   another reason, fall back to the working-tree diff
   (`git -C "$ROOT" diff --name-status HEAD -- <source-dirs>`).

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

- **Add** a row in the **layer section** the doc belongs to — match the existing
  `| Doc | Topic | Read when |` shape, with a standard repo-relative link and a one-line
  "read when" framed from the agent's task ("Adding a feature service", not "Feature service
  patterns").
- **Rename** a row's link + label when you rename a doc; never leave a dangling link.
- Keep the row's "read when" honest to what the doc covers after your edit.

Don't touch index rows for docs you didn't change — a small index diff mirrors a small doc
diff.

---

## Verify before you hand off

Run mechanically — don't self-assess, actually check:

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
to where you found it** (a grounding-source section, a type, a test, a source line); an
approach you can't trace to the source is invented → cut it. For each default/contract —
confirm it matches the source verbatim, not a paraphrase.

---

## Conventions

This skill is one of the pipeline suite; the shared formats, label semantics, and the
target-repo resolution it cites live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). The load-bearing invariants
are stated at their use sites above; the spine: **`.patterns/` only** (the *why* lives in
`.decisions/`, the *nouns* in `.glossary/`, conventions in `CLAUDE.md` — don't widen past it),
**source is the source of truth** (when the doc and the source disagree, fix the doc), **the
index bar gates a new doc** (an honest no-op beats a doc that fails it), and **read-only on
code, doc-only output** (no issue, no PR).
