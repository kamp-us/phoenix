---
name: glossary
description: Maintain the repo-owned domain-vocabulary file `.glossary/TERMS.md` — the canonical nouns of the codebase (products, entities, backend/infra terms) every contributor and CI-spawned agent shares. Two modes — bootstrap (seed TERMS.md from a fresh sweep of the feature surfaces when it is thin or absent) and incremental update (given a changed surface — a new feature folder, a new public export, a renamed symbol — add/rename/disambiguate the affected terms since the file's last update). Trigger on "update the glossary", "update TERMS.md", "add a term to the glossary", "bootstrap the glossary", "refresh the domain vocabulary", "the glossary lags the code", "/glossary". NOT the sözlük product feature, NOT the architecture-vocabulary file `LANGUAGE.md`, and NOT an architecture audit — this skill only edits `.glossary/TERMS.md`.
---

# glossary

You maintain `.glossary/TERMS.md` — the repo-owned **domain vocabulary**: the canonical
nouns of the codebase (products, domain entities, backend / fate / testing / infra / CI
terms) that a contributor or a CI-spawned agent must share to read the code the same way.
A glossary nobody updates rots: it lags the shipped surfaces, the same concept drifts to
four names, and pointers into it stop resolving. Your job is to keep the *what*-vocabulary
current against the code that is the authority.

You operate on **one file and one file only**: `.glossary/TERMS.md`. You are **read-only on
application code** — you read the codebase to learn the vocabulary, you never change it. You
do **not** open a PR, run a gate, or touch GitHub issues as part of your core loop — this is
a working-tree doc-maintenance skill, not a pipeline-execution skill. (When a pipeline run
*dispatched* you to produce this edit, the surrounding `write-code` flow opens the PR; your
job ends at a correct, committed edit to `.glossary/TERMS.md`.)

## Scope — what this skill is, and what it is NOT

- **It maintains `.glossary/TERMS.md` only** — the **domain-noun** half of the vocabulary
  spine. It never edits `.glossary/LANGUAGE.md` (the architecture-vocabulary file: module /
  interface / depth / seam / adapter / leverage / locality). `LANGUAGE.md` is near-frozen and
  not skill-maintained; leave it untouched.
- **Terms, not conventions.** This repo's *conventions* already live in `CLAUDE.md` and
  `.patterns/`; this skill does **not** duplicate or maintain them. It is **terms-only** — the
  noun glossary, nothing else.
- **NOT the sözlük product.** The name is the English-technical `glossary`, deliberately not
  `sozluk` — *sözlük* is a shipped **product feature** (the Turkish dev-terms dictionary), and
  a skill named after it would collide with that domain. Per the repo convention (Turkish for
  product/brand, English for technical), this technical maintenance skill is `glossary`.
- **NOT an architecture audit.** It does not sweep the codebase for shallow modules / refactor
  candidates / deepening opportunities, and it does not file issues. That is a different skill's
  job (`architecture-audit`); this skill's surface is the vocabulary file, not the architecture.
- **NOT intake.** It does not file, classify, or prioritize GitHub issues — that is `report` /
  `triage`. The only thing it produces is an edit to `.glossary/TERMS.md`.

## Repo-agnostic — resolve the target once

This skill is **repo-agnostic** (the pipeline suite is an installable plugin — ADR 0062). It
never hardcodes a repo. When you need the GitHub target (e.g. to cite an issue/ADR number in a
term's disambiguation note), resolve it once, at the top of your run, per the shared contract's
**Target repo resolution** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

In phoenix this defaults to `kamp-us/phoenix` with no config, so the behavior is unchanged
(ADR 0062 §1). The **file path itself is repo-relative** — `.glossary/TERMS.md` at the repo
root — resolved from the working tree, never an absolute or home path. Resolve the repo root
with `git rev-parse --show-toplevel` and operate on `<root>/.glossary/TERMS.md`.

## The file you maintain

`.glossary/TERMS.md` is a markdown file: a short top-of-file note (what it is + that the **code
is authoritative when they disagree**), then **sectioned tables**, one row per term. Each row is
`| Term | Definition | Not |` — the term, its short canonical definition, and a **disambiguation**
column naming what the term is **not** (used to pin a known naming drift). Sections group terms
by area — e.g. *Core / shape*, *Products (domains)*, *Domain entities*, *Backend architecture*,
*Testing*, *Infra / CI*. Read the live file to learn its exact sections before editing; mirror its
existing shape, never reinvent the layout.

Two rules govern every edit:

- **The code is authoritative.** When the code and TERMS.md disagree, the code wins and TERMS.md
  is the doc to fix. You read the code to derive the term, never the reverse.
- **Repo-relative cross-references only.** A term's note may link into `.decisions/` or
  `.patterns/` with a **repo-relative markdown link** (`[...](../.decisions/index.md)`); it must
  never carry a machine-absolute path, a home-directory path, a personal-vault path, or an Obsidian
  wikilink. Cite an ADR/issue by number, link by repo-relative path.

---

## Mode selection — bootstrap vs. incremental

Pick the mode from the state of the file and what you were asked to do:

- **Bootstrap** when `.glossary/TERMS.md` is **absent or thin** (no file, an empty stub, or only
  a handful of terms relative to the surfaces that exist) — *or* when you're explicitly asked to
  "bootstrap the glossary" / "seed TERMS.md". You sweep the feature surfaces once and populate the
  domain nouns from scratch.
- **Incremental update** when the file **already exists and is populated**, and the trigger is a
  *change*: a new feature folder, a new public export, a renamed symbol, "the glossary lags the
  code", or "add term X". You touch only the affected terms — add the new ones, rename the moved
  ones, disambiguate the drifted ones — and leave the rest of the file byte-for-byte intact.

When in doubt, prefer incremental: a populated file is rarely safe to regenerate wholesale (you'd
lose hand-curated disambiguation notes). Bootstrap is the cold-start case.

---

## Bootstrap mode — seed TERMS.md from a feature sweep

The first-run seed. Run it when there's no glossary worth preserving.

1. **Find the surfaces.** Enumerate the product/feature surfaces the vocabulary should cover —
   the feature folders, the public exports, the domain modules. In phoenix these are under
   `apps/web/**` (e.g. `features/*`, the worker domain modules) and `packages/*`; in another repo,
   the equivalent top-level domains. List them from the tree, not from memory:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   # feature/domain folders + package names — the surfaces whose nouns the glossary covers
   ls "$ROOT"/apps/*/src/features 2>/dev/null
   ls -d "$ROOT"/packages/*/ 2>/dev/null
   ```

2. **Harvest the nouns.** For each surface, read enough to name its domain nouns: the product
   name, its entities, the services/tables/exports a contributor must know. Capture the *canonical*
   name (the one the code actually uses) and a one-line definition grounded in what the code does.

3. **Group into the sectioned tables.** Place each term in the section it belongs to (Core,
   Products, Entities, Backend, Testing, Infra/CI). Where a name is known to have drifted — the
   same concept under two names, or a name that collides with another — fill the **Not** column to
   pin the canonical choice.

4. **Write the file** with the top-of-file note (what it is, that the code is authoritative) and
   the tables. Keep definitions short; the file is a glossary, not a manual. Edit
   `<root>/.glossary/TERMS.md` directly.

Bootstrap is the one mode that may write the whole file. Even so, prefer **alphabetized rows
within each section** so a later incremental diff is small and readable.

---

## Incremental-update mode — add/rename/disambiguate the changed terms

The steady state: the file exists, the code moved, and the glossary must catch up to **just**
the change. The discipline is surgical — touch the affected rows, preserve everything else.

1. **Scope the change to the diff since the file last moved.** The top-of-file note or the
   file's git history dates the last update; scan what changed since then, not the whole repo.
   The file's last-touch commit bounds the sweep:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   # the commit that last touched the glossary — the lower bound of "what changed since"
   LAST=$(git -C "$ROOT" log -1 --format=%H -- .glossary/TERMS.md)
   # the code surfaces that changed since then (feature folders, public exports, renames)
   git -C "$ROOT" diff --name-status "$LAST"..HEAD -- apps packages
   ```

   If the file has never been committed (you're staging a fresh seed), that's the bootstrap case,
   not this one. If `LAST` is empty for a reason other than absence, fall back to reviewing the
   working-tree diff (`git -C "$ROOT" diff --name-status HEAD -- apps packages`).

2. **Classify each change against the vocabulary:**
   - **A new noun** (a new feature folder, a new public export, a new entity/table) → **add** a row
     in the right section with a code-grounded definition.
   - **A renamed symbol** (the code's canonical name moved) → **rename** the existing row to the new
     name, and — if the old name was in use — record it in the **Not** column so the drift is pinned.
   - **A drift / collision** (the same concept named two ways, or a name now colliding with another)
     → **disambiguate**: pick the canonical name (the one the code uses) and fill the **Not** column.
   - **No vocabulary impact** (an internal refactor that adds/renames nothing a contributor must
     know) → **no edit.** Not every diff moves a term; an honest no-op is correct.

3. **Apply the minimal edit.** Change only the affected rows. Do not re-sort the whole file, do not
   reformat untouched sections, do not regenerate definitions you didn't need to change — a noisy
   diff buries the one real change and risks clobbering a hand-curated note. Add a new row in its
   section's alphabetical place.

4. **Refresh the dating, lightly.** If the file carries an explicit "last updated" marker, bump it;
   if it relies on git history for its date (the phoenix file does), the commit itself is the date —
   don't invent a marker the file doesn't already use.

The result of either mode is a **clean, committed edit to `.glossary/TERMS.md`** and nothing else —
no code change, no issue, no PR (the dispatching `write-code` flow, when there is one, owns the PR).

---

## Conventions

This skill is one of the pipeline suite; the shared formats, label semantics, and the
target-repo resolution it cites live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). The vocabulary spine this
skill maintains is the repo's **4th doc surface** (`.glossary/`), alongside `CLAUDE.md`,
`.decisions/`, and `.patterns/`:

- **One file, terms-only.** `.glossary/TERMS.md` is the whole surface area. Conventions live in
  `CLAUDE.md`/`.patterns/`; architecture vocabulary lives in `.glossary/LANGUAGE.md` (near-frozen,
  not maintained here). Don't widen the skill's reach past TERMS.md.
- **Code is the source of truth.** Every term is derived from what the code does; when the doc and
  the code disagree, fix the doc, never the code.
- **Surgical in incremental mode.** Touch only the rows the change affects; a small diff is the
  point. Wholesale regeneration is the bootstrap exception, not the steady state.
- **No leaked paths.** Cross-references are repo-relative markdown links into `.decisions/` /
  `.patterns/`; never an absolute, home, vault, or Obsidian-wikilink path.
