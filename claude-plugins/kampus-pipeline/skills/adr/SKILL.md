---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. There is no committed index (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)) and **no `SessionStart` ADR-map hook** (ADR [0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md), dropping 0126's hook as needless indirection) — discovery is the CLAUDE.md contract alone, the same in every context: `ls .decisions/` + each file's frontmatter (`id`/`title`/`status`), with `pipeline-cli decisions-index compact` rendering the full `id · title · status` map **on demand** (never auto-injected). An ADR PR is **purely additive**: it adds one `.decisions/NNNN-slug.md` file (plus the status-line edit on a file it supersedes or amends-in-part), and never touches or regenerates an index.

## The extracted scripts

This skill's shell lives in [`scripts/`](scripts/), and each fenced block is an **invocation** of one
(epic #4435 phase 1 — the shell moved as-is; turning its glue into tested `pipeline-cli` verbs is
#1929). They set `set -uo pipefail`, deliberately not `-e`, and install no `EXIT` trap: the moved glue
steers its own control flow, `errexit` would abort a fail-closed branch before it printed its refusal,
and on bash 3.2 a `set -u` abort that reaches an `EXIT` trap yields exit **0** — a fail-closed script
exiting clean having printed its FAIL (#4476, class #4479).

**[`scripts/claimed-numbers.sh`](scripts/claimed-numbers.sh) fails closed on an unreadable query, and
that is the whole point of the reservation lock.** An empty in-flight set reads as "nothing reserved",
which is exactly the stale-on-disk fall-back ADR 0074 removes — so a failed enumeration exits non-zero
rather than printing nothing, and an empty listing is only "nothing reserved" on **exit 0**.

## Steps

1. **Claim the next number with an in-flight reservation lock** (ADR [0074](https://github.com/kamp-us/phoenix/blob/main/.decisions/0074-adr-number-claim-lock.md)) — not next-free-on-disk. Numbers are 4-digit zero-padded, monotonic. Compute the next number from the **union of two sets** and take `max(union) + 1`:
   - **Merged set** — the `NNNN` on the base ref, read from the `.decisions/NNNN-*.md` *filenames* (the authority; there is no committed index to consult — ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)). Don't eyeball this — run **`"$PCLI" decisions-index next`** (resolve `$PCLI` with §CLI's canonical preamble — [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) §CLI), the deterministic allocator (#2064): it reuses the same frontmatter parse `validate` runs and prints `max(id) + 1` zero-padded (e.g. `0155`). That kills the stale-guess case (a local checkout reading `0150` while origin/main is `0151`); run it against a **freshly fetched** base ref so the merged set is current. Take the `max` of *its* output and the in-flight set below.
   - **In-flight set** — the `NNNN` **claimed by open ADR PRs**. An open PR that adds a `.decisions/NNNN-*.md` file *is* the reservation for `NNNN` (no separate artifact, exactly as ADR 0059's `status:planning` label *is* the epic lock — opening the PR reserves, merging/closing releases). Enumerate via **`gh api` REST, never GraphQL** (the org's Projects-classic integration breaks GraphQL):
     ```bash
     # every NNNN claimed by an open PR that ADDS a .decisions/NNNN-*.md file, one per line
     bash ./claude-plugins/kampus-pipeline/skills/adr/scripts/claimed-numbers.sh || exit 1
     ```
     (The script resolves `$REPO` itself, the same way write-code does.) **Fail closed** (ADR 0074, ADR 0059's fail-closed acquire): if the in-flight query errors it exits non-zero — **surface it and re-run**, and never silently fall back to the on-disk-only number. That stale-on-disk fall-back is the bug this step removes, so an empty listing is only "nothing reserved" on **exit 0**.

   This is **detect-and-serialize, not a CAS** — it *narrows* the collision window, it does not eliminate it. Two authors who enumerate in the same window before either PR is visible both pick the same number; that residual is **backstopped by the CI duplicate-`id` check** (the `decisions-index validate` PR job — see [ADR number lock](#adr-number-lock)), which reddens the second-to-merge PR for a manual renumber. The lock turns the *common* "branch after another's ADR PR is open" case from collide-and-renumber into don't-collide; the CI check remains the safety net for the rare residual.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below. Directly beneath the `# NNNN — <Title>` heading, write the **required** plain one-line `**What this decides:** …` summary (see the [Rules](#rules)) — the front-matter `title`/`status`/`date` are the **source of truth** for the on-demand `compact` map row (ADR 0126: the compact map derives `id · title · status` straight from frontmatter; rendered on demand, never injected — ADR 0129), so write the exact display text you want there (inline markdown and all). Keep `title` to **one dense line** — it is what the rendered `compact` map shows for this ADR.
4. **Sweep the live `accepted` ADRs for a same-question conflict, and cite or amend every real hit (required).** A new ADR that decides the opposite of an unsuperseded `accepted` ADR leaves every future agent two authoritative, incompatible rules with no signal a conflict exists. Run the sweep defined in [§Contradiction sweep](#contradiction-sweep--never-decide-against-a-live-adr-silently) **before the PR goes up** — it is the authoring-side mirror of `review-doc`'s Step 4a, and the cheapest place to resolve a hit is here, not in a repair round.
5. **The ADR PR is purely additive — add only `.decisions/NNNN-slug.md`** (plus the status-line edit on a file this ADR supersedes or amends-in-part). There is no committed `.decisions/index.md` to regenerate or commit (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md)); discovery is the CLAUDE.md contract — `ls .decisions/` + frontmatter, with `compact` on demand (ADR [0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md)) — so nothing else changes. Because ADR PRs carry no shared generated file, two concurrent ADR PRs can't collide — adding an ADR is conflict-free. To **render** the compact map locally you may run the CLI, but there is no index file to stage:
   ```bash
   # OPTIONAL local render of the on-demand compact map — nothing to `git add` (no committed index).
   # The `bin/pipeline-cli` shim resolves the bin (in-repo, else installed, else pinned dlx reading
   # the ONE pin in hooks/pin.sh) — no version pinned here (#3653).
   # §CLI — bind the shim by LITERAL assignment, run from the repo root.
   PCLI="./claude-plugins/kampus-pipeline/bin/pipeline-cli"
   "$PCLI" decisions-index compact
   ```
   The published CLI operates on the local `.decisions/` filesystem (no GitHub target), so there is no `$REPO`/`$CLAUDE_PIPELINE_REPO` resolution here — it is purely the in-repo-vs-published invocation swap.
6. **Record the ADR's vocabulary impact (required — a named term or an explicit "none").** An ADR is a primary *coining site*: it is where a concept most often enters the repo vocabulary — a new term, or a redefinition of an existing one (ADR 0126's "ambient discovery" was coined here and drifted silently). So before you tell the user the path, run the point-of-coining glossary catch defined in [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source). This is a **coining-time authoring hook, not the `review-code` gate** — it lives in this skill (prong (c) of ADR [0128](https://github.com/kamp-us/phoenix/blob/main/.decisions/0128-glossary-concept-trigger-off-the-gate.md), Fixes #1737); it never touches `review-code`'s fail-closed Step 3c. **You must land on one of two explicit outcomes — a named term routed to the glossary, or a recorded "no vocabulary impact"; silently skipping it is not an option.**
7. Tell the user the path. Do not summarize the body — they just stated it.

## Contradiction sweep — never decide against a live ADR silently

Two live `accepted` ADRs that decide opposite things on one question are worse than an open
question: each reads as authoritative, neither hints the other exists, and which one an agent obeys
depends on which file it happened to open. The house convention for *resolving* such a clash has
existed for a long time; what was missing was any obligation to *look* (#3980). This section is it,
and `review-doc`'s Step 4a is its independent mirror on the gate side.

**1. Enumerate what this ADR decides — as questions, not as a summary.** From your `title`, your
`**What this decides:**` line and your `## Decision`, write down each question the ADR settles:
*"may an open issue exist without a milestone?"*, *"what happens to work that serves no active
arc?"*. You cannot sweep for a question you cannot phrase.

**2. Sweep the live `accepted` ADRs for those same questions.** The mechanical shortlist ranks the
live-accepted ADRs whose decision domain yours touches and which you do **not** cite:

```bash
# Exit 0 = nothing left to open. Non-zero = a shortlist to clear, or an INDETERMINATE run.
bash ./claude-plugins/kampus-pipeline/skills/adr/scripts/sweep-shortlist.sh \
  .decisions/NNNN-slug.md
```

`pipeline-cli decisions-index compact` is the manual fallback: scan the `id · title · status` map
for ADRs whose title rules on one of your questions, and open those.

**3. Cite or amend every real hit — before the PR goes up.** Open each shortlist entry and decide
whether it rules on a question you re-decide. Most are merely adjacent; for the ones that genuinely
overlap:

- **You replace it outright** → supersede it (the existing convention in the [Rules](#rules)).
- **You change part of it and the rest still stands** → the amendment shape: set `status:
  amended-in-part by [NNNN](NNNN-your-slug.md)` on the **older** ADR's **status line only**, leave
  its body untouched (an accepted ADR's decision text is immutable), and name the relationship in
  your `## Context`. Precedents: `0023`, `0028`, `0031`, `0035`.
- **You only *refine* mechanics of your own prior ADR, the ruling standing** → the dated
  `## Amendments` note (the [Rules](#rules)), not a status change.

**The tool is a shortlist, not an oracle — do not let it stand in for move 3.** It detects lexical
and tag adjacency on decision-bearing text minus your own citations. It does **not** detect a
semantic contradiction: an ADR that disagrees with yours about what a *label means*, sharing no
distinctive vocabulary, will not appear. A `no-overlap` result means "nothing mechanically adjacent
was left to open," never "no contradiction," and an `indeterminate` result carries no information at
all — read by hand in both cases. A corpus the tool cannot read fails closed rather than reporting a
clean sweep (ADR [0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md)).

## Vocabulary impact — catch a coined or redefined term at its source

The glossary ([`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)) is the repo-owned domain vocabulary every contributor and CI-spawned agent shares. Its `review-code` freshness gate (Step 3c) only sees **structural** surfaces — a new feature folder / package / export — so a **concept-level** term coined or redefined *within existing surfaces* (a renamed model, a redefined lever, an ADR-coined phrase) sails past it. An ADR is exactly where those terms are named, so catch them **here, at coinage**, where you already hold the concept — not in a later archaeology pass (ADR [0128](https://github.com/kamp-us/phoenix/blob/main/.decisions/0128-glossary-concept-trigger-off-the-gate.md) prong (c); the grounded miss is ADR 0126's "ambient discovery").

This is a **required, not-silently-skippable** authoring step. When you write the ADR, ask: *does this decision coin a new term, or redefine an existing one?* You must record **exactly one** of two outcomes — you cannot leave it blank:

- **Term(s) coined/redefined → feed the glossary.** Name each term (and, for a redefinition, what changed). Then route it to `.glossary/TERMS.md`: if the term's canonical definition is short and unambiguous, add/update its row directly in the same ADR PR; if it needs the fuller treatment (a "not …" disambiguation, cross-links), **invoke `/glossary`** (`claude-plugins/kampus-pipeline/skills/glossary/SKILL.md`) or file a `report` so the glossary skill picks it up. Either way the term is surfaced, never left implicit in the ADR prose.
- **No vocabulary impact → record it explicitly.** If the ADR coins/redefines nothing (it re-decides mechanics, sequencing, or policy over already-named concepts), state that plainly — record it in the ADR's terminal `## Records` section (see the [Rules](#rules)) and tell the user "no vocabulary impact" as part of Step 7's report. The explicit "none" is the recorded outcome; it is what distinguishes *"considered and there is none"* from *"forgot to check."*

This hook is **off the fail-closed gate by construction**: it is authoring-time judgment in this skill, it blocks no PR, and it does not (and must not) alter `review-code`'s Step 3c. It is the routed-term half of ADR 0128; the un-routed code-PR class is the sibling drift-sweep backstop, not this skill's job.

## File template

```markdown
---
id: NNNN
title: <one decision-carrying clause, ≤ ~12 words — this is the compact-map row>
status: accepted
date: YYYY-MM-DD
tags: [<area>, <area>]
---

# NNNN — <Title, verbatim from the frontmatter `title`>

**What this decides:** <one plain human-language sentence a non-author can parse cold — what the decision *is*, not a restatement of the dense `title`.>

## Context
<Why this came up — situation, constraint, prior pain.>

## Decision
**<One bolded declarative sentence — the decision itself, in a line.>**

<Then the mechanics / reasoning, declarative. No hedging.>

<!-- When (and only when) this ADR constrains future work, follow the reasoning with an
     austere list — terse, one line per item — under a bolded label. Omit it entirely if
     the ADR constrains nothing (the 0092/0107 form):
**Binding constraints.**
- <constraint>
**Banned.**
- <what this rules out> -->

## Consequences
<What this makes easier / harder. Any migration cost.>

<!-- Optional terminal sections — add only when they carry content, in this order:

## Records
     Merge-time bookkeeping, quarantined out of the decision body: backlog reconciliation
     (`Closes/Reshapes #N`), blocks-cleared, and the Step-6 vocabulary-impact outcome (the
     term routed to .glossary/TERMS.md, or an explicit "no vocabulary impact").

## Amendments
     The one sanctioned currency shape — a dated forward note when a later change refines
     this ADR; the decision above still stands (0107's form, never a top-of-file blockquote):
- **#NNNN — <what changed> (YYYY-MM-DD).** <the refinement.> -->
```

## Discovery — the CLAUDE.md contract, no committed index

There is no committed `.decisions/index.md` (ADR [0126](https://github.com/kamp-us/phoenix/blob/main/.decisions/0126-ambient-adr-discovery.md), supersedes 0066's storage half) and **no `SessionStart` ADR-map hook** (ADR [0129](https://github.com/kamp-us/phoenix/blob/main/.decisions/0129-adr-discovery-is-the-claude-md-contract.md), which drops 0126's §Decision 3 hook as needless indirection). Discovery is the CLAUDE.md contract alone, uniform across every context (session, subagent, CI): `ls .decisions/` (the `NNNN-slug` filenames are the map) plus each file's frontmatter (`id`/`title`/`status`) for the row. For the full one-line-per-ADR `id · title · status` map **on demand**, run `pipeline-cli decisions-index compact` (derived straight from frontmatter, ordered ascending by `id`) — never auto-injected. Nothing is generated, committed, or regenerated — so nothing can drift, and an ADR PR is purely additive.

The map's `title`/`status` fields are the file's frontmatter values **verbatim** — so a linked supersede status (`superseded by [0009](0009-slug.md)`) is written in the file's `status:` field and the rendered map carries it through. Keep `title` to one dense line.

### ADR number lock

On a **PR**, `.github/workflows/decisions-index.yml` runs `decisions-index validate`, which fails the build on a duplicate `id` or a filename/front-matter number mismatch (two PRs grabbed the same number — #1471). This is the number-lock backstop for Step 1's reservation; it does not check any index (there is none to check).

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- **Every new ADR opens with a plain one-line `**What this decides:** …` summary, directly beneath the `# NNNN — <Title>` heading and above `## Context`.** Write it in plain human language — what the decision *is*, so the founder (who ratifies ADRs — ADR [0078](https://github.com/kamp-us/phoenix/blob/main/.decisions/0078-product-driven-decisions-by-default.md)) can parse it cold, without decoding the dense agent-oriented prose below it. It is a reader-facing summary for a non-author, **not** a restatement of the one-line `title` (the `title` is the dense `compact`-map row; this is the human gloss). This line is required on every new ADR — never omit it.
- **Title discipline — `title` is one decision-carrying clause (≤ ~12 words); the `# NNNN — <Title>` H1 repeats it verbatim.** The frontmatter `title` *is* the `compact`-map row (per the [Discovery](#discovery--the-claudemd-contract-no-committed-index) note that it renders verbatim), so it must **carry the decision, not name the topic** — `Every gate fails closed on zero scope` over `Gate scope handling` — and stay to a single dense clause. The H1 then matches it character-for-character; the human gloss lives in the `**What this decides:**` line above, not in a second, looser title. (0092/0107/0191 already do this.)
- **`## Decision` opens with one bolded declarative sentence.** State the decision in a single bolded line *before* the mechanics (0092's `**Every gate fails closed…**`, 0107's `**instances + standing…**`) so a reader gets the ruling in one line. When — and only when — the ADR constrains future work, follow the reasoning with an **austere** list (terse, one line per item) under a bolded `**Binding constraints.**` / `**Banned.**` label. This is authoring *guidance*, not a fail-closed template section: an ADR that constrains nothing carries no such list, and nothing reds a PR for omitting it.
- **Merge-time bookkeeping goes in a terminal `## Records` section, out of the decision body.** Backlog reconciliation (`Closes/Reshapes #N`), blocks-cleared, and the Step-6 vocabulary-impact outcome are housekeeping, not the decision — quarantine them in a terminal `## Records` so `## Decision`/`## Consequences` read as the decision alone. Omit the section when there's nothing to record.
- **Post-merge currency has one shape: a dated `## Amendments` note.** When a later change refines an *accepted* ADR (the decision itself still stands — this complements "never edit the decision text, supersede instead" above; an amendment refines mechanics/spelling, not the ruling), append a dated forward note — `- **#NNNN — <what> (YYYY-MM-DD).** …` — to a terminal `## Amendments` section (0107's form). **Never** prepend an ad-hoc `> **Update:** …` blockquote at the top of the file (0027's retired form); the top-of-file update blockquote is banned.
- **Linking to another ADR — resolve its filename by stable number from disk, never guess the slug from the target's title.** A target ADR's slug is **not derivable from its title** (0048 is `ship-it-merge-actor`, not `single-merge-authority`; 0053 is `control-plane-boundary`, not `control-plane-human-merge`; 0075 is `issueless-doc-pr-merge-seam`, not `conversation-authored-adr-exception`). The stable number `NNNN` is the only reliable key, so **read the real filename off disk** and use it verbatim — never re-apply the Step-2 title→slug heuristic to a *different* ADR you're linking. This is the recurring `review-doc` "links resolve" FAIL (#1777); `doc-links.yml` is the CI backstop, this is the authoring-time fix. Resolve every `[NNNN](NNNN-slug.md)` link's slug this way:
  ```bash
  ls .decisions/NNNN-*.md   # → .decisions/NNNN-real-slug.md — use exactly this filename in the link
  ```
- `status`: `accepted | proposed | superseded | deprecated` (or a richer linked phrase like `superseded by [NNNN](NNNN-slug.md)`). Default `accepted` unless the user says otherwise. Whatever you put in `status:` is what the on-demand `compact` map shows.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's front-matter `status: superseded by [NNNN](NNNN-slug.md)` plus a body line `Superseded by [NNNN](NNNN-slug.md).` The on-demand `compact` map reflects both from frontmatter — there is no index to touch. Resolve every `NNNN-slug.md` here off disk (`ls .decisions/NNNN-*.md`) per the cross-link rule above — the guessed slug is exactly where these supersede links go dead.
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead, or amend in part (below).
- **Amending in part: the status line only.** When your ADR changes part of a live `accepted` ADR while the rest still stands, set `status: amended-in-part by [NNNN](NNNN-slug.md)` on that older file and change **nothing else in it** — its decision text is immutable. Name the relationship in your own `## Context`. Precedents: 0023, 0028, 0031, 0035. Finding the ADRs that need this is the [§Contradiction sweep](#contradiction-sweep--never-decide-against-a-live-adr-silently), which is required on every ADR.
- **Always resolve the vocabulary-impact outcome** (Step 6 / [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source)): every ADR ends with *either* a term surfaced to `.glossary/TERMS.md` *or* an explicit recorded "no vocabulary impact." Never leave it unstated — the explicit "none" is a real outcome, not a skip.
- Your PR adds only the ADR file (plus the status-line edit on a file it supersedes or amends-in-part); there is no committed index. Optional local render of the on-demand compact map (nothing to stage): `./claude-plugins/kampus-pipeline/bin/pipeline-cli decisions-index compact` (the shim resolves the bin — in-repo, else installed, else pinned dlx reading the one pin in hooks/pin.sh; #3653).
