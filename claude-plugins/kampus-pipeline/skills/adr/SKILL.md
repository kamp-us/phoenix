---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. There is no committed index (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)) and **no `SessionStart` ADR-map hook** (ADR [0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md), dropping 0126's hook as needless indirection) — discovery is the CLAUDE.md contract alone, the same in every context: `ls .decisions/` + each file's frontmatter (`id`/`title`/`status`), with `pipeline-cli decisions-index compact` rendering the full `id · title · status` map **on demand** (never auto-injected). An ADR PR is **purely additive**: it adds one `.decisions/NNNN-slug.md` file (plus the superseded file's status edit when superseding), and never touches or regenerates an index.

## Steps

1. **Claim the next number with an in-flight reservation lock** (ADR [0074](https://github.com/kamp-us/phoenix/blob/main/.decisions/0074-adr-number-claim-lock.md)) — not next-free-on-disk. Numbers are 4-digit zero-padded, monotonic. Compute the next number from the **union of two sets** and take `max(union) + 1`:
   - **Merged set** — the `NNNN` on the base ref, read from the `.decisions/NNNN-*.md` *filenames* (the authority; there is no committed index to consult — ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)).
   - **In-flight set** — the `NNNN` **claimed by open ADR PRs**. An open PR that adds a `.decisions/NNNN-*.md` file *is* the reservation for `NNNN` (no separate artifact, exactly as ADR 0059's `status:planning` label *is* the epic lock — opening the PR reserves, merging/closing releases). Enumerate via **`gh api` REST, never GraphQL** (the org's Projects-classic integration breaks GraphQL):
     ```bash
     # NNNN claimed by any open PR that ADDS a .decisions/00NN-*.md file (REST, per-PR files endpoint)
     for PR in $(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].number'); do
       gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
         --jq '.[] | select(.status=="added") | .filename
               | capture("^\\.decisions/(?<n>[0-9]{4})-") | .n'   # --paginate + streaming --jq: a >100-file PR that adds .decisions/NNNN past file #100 still claims its number (the API caps per_page at 100; #725)
     done
     ```
     (`$REPO` resolves the same way write-code's does: `${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}`.) **Fail closed** (ADR 0074, ADR 0059's fail-closed acquire): if the in-flight query errors, **surface it and re-run** — never silently fall back to the on-disk-only number. That stale-on-disk fall-back is the bug this step removes.

   This is **detect-and-serialize, not a CAS** — it *narrows* the collision window, it does not eliminate it. Two authors who enumerate in the same window before either PR is visible both pick the same number; that residual is **backstopped by the CI duplicate-`id` check** (the `decisions-index validate` PR job — see [ADR number lock](#adr-number-lock)), which reddens the second-to-merge PR for a manual renumber. The lock turns the *common* "branch after another's ADR PR is open" case from collide-and-renumber into don't-collide; the CI check remains the safety net for the rare residual.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below — the front-matter `title`/`status`/`date` are the **source of truth** for the ambient map row (ADR 0126: the compact map derives `id · title · status` straight from frontmatter), so write the exact display text you want there (inline markdown and all). Keep `title` to **one dense line** — every session pays a token for it in the injected map.
4. **The ADR PR is purely additive — add only `.decisions/NNNN-slug.md`** (plus the superseded file's status edit when superseding). There is no committed `.decisions/index.md` to regenerate or commit (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)); discovery is ambient and derives from frontmatter, so nothing else changes. Because ADR PRs carry no shared generated file, two concurrent ADR PRs can't collide — adding an ADR is conflict-free. To **preview** the compact map locally you may run the CLI, but there is no index file to stage:
   ```bash
   # OPTIONAL local preview of the ambient map — nothing to `git add` (no committed index)
   if [ -f packages/pipeline-cli/src/bin.ts ]; then
     node packages/pipeline-cli/src/bin.ts decisions-index compact   # phoenix-local: the in-repo consolidated bin
   else
     pnpm dlx @kampus/pipeline-cli@0.1.0 decisions-index compact      # foreign install: the published consolidated CLI (single-source pin)
   fi
   ```
   The published CLI operates on the local `.decisions/` filesystem (no GitHub target), so there is no `$REPO`/`$CLAUDE_PIPELINE_REPO` resolution here — it is purely the in-repo-vs-published invocation swap.
5. **Record the ADR's vocabulary impact (required — a named term or an explicit "none").** An ADR is a primary *coining site*: it is where a concept most often enters the repo vocabulary — a new term, or a redefinition of an existing one (ADR 0126's "ambient discovery" was coined here and drifted silently). So before you tell the user the path, run the point-of-coining glossary catch defined in [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source). This is a **coining-time authoring hook, not the `review-code` gate** — it lives in this skill (prong (c) of ADR [0128](https://github.com/kamp-us/phoenix/blob/main/.decisions/0128-glossary-concept-trigger-off-the-gate.md), Fixes #1737); it never touches `review-code`'s fail-closed Step 3c. **You must land on one of two explicit outcomes — a named term routed to the glossary, or a recorded "no vocabulary impact"; silently skipping it is not an option.**
6. Tell the user the path. Do not summarize the body — they just stated it.

## Vocabulary impact — catch a coined or redefined term at its source

The glossary ([`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)) is the repo-owned domain vocabulary every contributor and CI-spawned agent shares. Its `review-code` freshness gate (Step 3c) only sees **structural** surfaces — a new feature folder / package / export — so a **concept-level** term coined or redefined *within existing surfaces* (a renamed model, a redefined lever, an ADR-coined phrase) sails past it. An ADR is exactly where those terms are named, so catch them **here, at coinage**, where you already hold the concept — not in a later archaeology pass (ADR [0128](https://github.com/kamp-us/phoenix/blob/main/.decisions/0128-glossary-concept-trigger-off-the-gate.md) prong (c); the grounded miss is ADR 0126's "ambient discovery").

This is a **required, not-silently-skippable** authoring step. When you write the ADR, ask: *does this decision coin a new term, or redefine an existing one?* You must record **exactly one** of two outcomes — you cannot leave it blank:

- **Term(s) coined/redefined → feed the glossary.** Name each term (and, for a redefinition, what changed). Then route it to `.glossary/TERMS.md`: if the term's canonical definition is short and unambiguous, add/update its row directly in the same ADR PR; if it needs the fuller treatment (a "not …" disambiguation, cross-links), **invoke `/glossary`** (`claude-plugins/kampus-pipeline/skills/glossary/SKILL.md`) or file a `report` so the glossary skill picks it up. Either way the term is surfaced, never left implicit in the ADR prose.
- **No vocabulary impact → record it explicitly.** If the ADR coins/redefines nothing (it re-decides mechanics, sequencing, or policy over already-named concepts), state that plainly — e.g. tell the user "no vocabulary impact" as part of Step 6's report. The explicit "none" is the recorded outcome; it is what distinguishes *"considered and there is none"* from *"forgot to check."*

This hook is **off the fail-closed gate by construction**: it is authoring-time judgment in this skill, it blocks no PR, and it does not (and must not) alter `review-code`'s Step 3c. It is the routed-term half of ADR 0128; the un-routed code-PR class is the sibling drift-sweep backstop, not this skill's job.

## File template

```markdown
---
id: NNNN
title: <Title Case>
status: accepted
date: YYYY-MM-DD
tags: [<area>, <area>]
---

# NNNN — <Title>

## Context
<Why this came up — situation, constraint, prior pain.>

## Decision
<What we do now, declarative. No hedging.>

## Consequences
<What this makes easier / harder. What's now banned. Any migration cost.>
```

## Discovery — the CLAUDE.md contract, no committed index

There is no committed `.decisions/index.md` (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md), supersedes 0066's storage half) and **no `SessionStart` ADR-map hook** (ADR [0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md), which drops 0126's §Decision 3 hook as needless indirection). Discovery is the CLAUDE.md contract alone, uniform across every context (session, subagent, CI): `ls .decisions/` (the `NNNN-slug` filenames are the map) plus each file's frontmatter (`id`/`title`/`status`) for the row. For the full one-line-per-ADR `id · title · status` map **on demand**, run `pipeline-cli decisions-index compact` (derived straight from frontmatter, ordered ascending by `id`) — never auto-injected. Nothing is generated, committed, or regenerated — so nothing can drift, and an ADR PR is purely additive.

The map's `title`/`status` fields are the file's frontmatter values **verbatim** — so a linked supersede status (`superseded by [0009](0009-slug.md)`) is written in the file's `status:` field and the rendered map carries it through. Keep `title` to one dense line.

### ADR number lock

On a **PR**, `.github/workflows/decisions-index.yml` runs `decisions-index validate`, which fails the build on a duplicate `id` or a filename/front-matter number mismatch (two PRs grabbed the same number — #1471). This is the number-lock backstop for Step 1's reservation; it does not check any index (there is none to check).

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- `status`: `accepted | proposed | superseded | deprecated` (or a richer linked phrase like `superseded by [NNNN](NNNN-slug.md)`). Default `accepted` unless the user says otherwise. Whatever you put in `status:` is what the ambient map shows.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's front-matter `status: superseded by [NNNN](NNNN-slug.md)` plus a body line `Superseded by [NNNN](NNNN-slug.md).` The ambient map reflects both from frontmatter — there is no index to touch.
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead.
- **Always resolve the vocabulary-impact outcome** (Step 5 / [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source)): every ADR ends with *either* a term surfaced to `.glossary/TERMS.md` *or* an explicit recorded "no vocabulary impact." Never leave it unstated — the explicit "none" is a real outcome, not a skip.
- Your PR adds only the ADR file (plus the superseded file's status edit); there is no committed index. Optional local preview of the ambient map (nothing to stage): `node packages/pipeline-cli/src/bin.ts decisions-index compact` when the consolidated bin is on disk, else `pnpm dlx @kampus/pipeline-cli@0.1.0 decisions-index compact`.
