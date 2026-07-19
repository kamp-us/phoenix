---
name: architecture-audit
description: Walk a codebase for architectural friction and file each deepening opportunity as a triageable GitHub issue — one issue per consolidated, deduped finding, entering the report→triage intake. Read-only on application code; the only mutation is filing issues. Uses a lens-diversified three-pass walk (Locality / Testability / Vocabulary), a smell-catalog coverage gate, cross-finding consolidation, and dedup-against-open-issues before filing. Trigger on "audit architecture", "find deepening opportunities", "find shallow modules", "find refactor candidates", "audit the codebase", "where should I refactor?", or "/architecture-audit".
---

# architecture-audit

Surface architectural friction in a codebase and route each **deepening opportunity** —
a refactor that turns a shallow module into a deep one — into the issue pipeline as raw
intake. The aim is testability and AI-navigability.

This skill is the in-repo, pipeline-native twin of the personal `audit-architecture`
workflow, **diverged in exactly one way that matters: its output is triageable GitHub
issues, never a repo or vault doc.** Each consolidated, deduped finding becomes **one
issue** filed through the existing `report` path — raw `status:needs-triage` intake,
type-blind, one finding = one issue — so the audit feeds the same `report → triage →
plan-epic → write-code` machinery every other observation does, instead of producing a
standalone artifact a human has to re-read and re-file. **This emits-issues contract is
ADR 0099** (the audit-emits-issues + 4th-surface decision); cite it and don't reintroduce
an audit-doc output.

This skill is **read-only on application code**. It runs lens passes with a tool-restricted
explorer and files issues; it never edits the audited code, never writes a doc into the
repo, and never drops into a grilling loop.

## All GitHub ops via `gh api` REST — never GraphQL

The kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue
queries. Every issue read and write goes through `gh api` REST. This is not a style
preference — GraphQL calls error out on this org.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api`
call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared
contract's **Target repo resolution**
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO`
if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the
behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## Vocabulary — read it from `.glossary/*`, don't carry your own

The audit speaks **one fixed vocabulary**, and that consistency is the point — it's what
makes findings comparable across runs and lets a follow-up session pick up where the audit
left off. Drift into "component / service / API / boundary" and the audit becomes another
flat code review.

Unlike the personal skill, this one does **not** carry its own `LANGUAGE.md`. The vocabulary
lives in the **committed repo glossary**, read fresh each run:

- **`.glossary/LANGUAGE.md`** — the **architecture vocabulary**: module, interface,
  implementation, depth, seam, adapter, leverage, locality, and the principles (the deletion
  test, "the interface is the test surface", "one adapter = hypothetical seam, two = real").
  Use these terms exactly in every finding.
- **`.glossary/TERMS.md`** — the **domain vocabulary**: the canonical product/domain nouns
  (sözlük, pano, künye, …). Name the module by its domain term — "the sözlük entry module",
  not "the FooBarHandler".

Read both before walking code:

```bash
# the committed architecture + domain vocabulary the audit speaks in
cat .glossary/LANGUAGE.md
cat .glossary/TERMS.md
```

If a glossary file is genuinely absent (a foreign install that hasn't adopted the glossary
surface yet), fall back to the architecture vocabulary as summarized in
[SMELLS.md](SMELLS.md)/[DEEPENING.md](DEEPENING.md) and note the gap in each filed finding's
Pointers — but in this repo the glossary is the source of truth; read it, don't re-derive it.

This skill **carries its own method docs**, which is method, not vocabulary:

- **[SMELLS.md](SMELLS.md)** — the smell-catalog coverage gate (the ten-smell finite list the
  audit checks against, so runs are comparable).
- **[DEEPENING.md](DEEPENING.md)** — the four-category dependency taxonomy a finding's
  suggested next step uses when proposing how to deepen something.

## Arguments

- **No argument** — codebase-level audit. Sample breadth-first across the repo's subsystems.
- **`<path-or-area>`** — scope the walk to a directory, package, or app
  (e.g. `apps/web/worker`, `packages/...`). Stay inside that scope; walk outward only when a
  finding genuinely depends on something across the seam.

## Process

### 1. Read the vocabulary and the recent decisions

Before walking code, read `.glossary/LANGUAGE.md` and `.glossary/TERMS.md` (above). Then skim
the decisions that should not be re-litigated, so the audit doesn't propose something already
decided against — scan the ADRs and read any touching the scope you're auditing. There is no
committed index (ADR 0126); the `NNNN-slug` filenames are the map, and each file's frontmatter
carries `id`/`title`/`status`:

```bash
ls .decisions/                                      # the map — one NNNN-slug.md per ADR
node packages/pipeline-cli/src/bin.ts decisions-index compact   # or: the compact id · title · status map
```

Treat a recorded decision as decided ground: don't surface a finding that contradicts a
settled ADR unless the friction is real enough to reopen it, and if so, say so explicitly in
the finding.

### 2. Walk the codebase via three lens-diversified passes

Spawn **three explorer subagents in a single tool-call block** so they run concurrently — the
parallelism comes from emitting multiple tool calls in one assistant message, not from
sequential calls. One pass per lens. Each pass walks the same code through a different framing
— this is the load-bearing variance-reduction technique. Prompt-diversification through lenses
produces broader candidate distributions than running the same prompt three times.

**Use a tool-restricted explorer subagent** (no `Edit`/`Write`/`NotebookEdit`) so the
read-only contract is structural, not vibes-based. Don't substitute a more capable agent type
"because it's faster" — the tool restriction *is* the safety contract.

**Three lenses — use these exact framings (lens-as-instruction, NOT lens-as-persona;** a
persona prefix like "you are a senior testability auditor" costs measurable accuracy on
recall tasks — frame as "focus this pass on X" instead):

> **Lens A — Locality.** "Focus this pass on **locality of change**. Where do related concepts
> live apart? Where would a single user-visible change require edits in N files? Where does
> fixing a bug in concept X require also touching unrelated code? Treat scattered ownership of
> one idea as the primary friction signal."

> **Lens B — Testability.** "Focus this pass on **testability through interfaces**. Where do
> tests assert against internal seams (private helpers, intermediate state) instead of the
> module's external interface? Where are pure functions extracted *only* for testability,
> leaving the call-site coupling untested? Where can the module *not* be exercised through its
> interface from a test? The interface is the test surface — flag anywhere that's violated."

> **Lens C — Vocabulary.** "Focus this pass on **vocabulary fidelity**. Where do names lie
> about what code does (function says one thing, body does another)? Where do canonical domain
> terms from `.glossary/TERMS.md` not appear in the code that handles them? Where do internal
> type/symbol names diverge from the user-facing or domain-facing names? Treat naming friction
> as a signal of conceptual gaps, not surface polish."

**Each lens-pass brief must include:**

- **Domain vocab** from `.glossary/TERMS.md` — canonical names for domain concepts.
- **Architecture vocab** from `.glossary/LANGUAGE.md` — module / interface / depth / seam /
  adapter / leverage / locality.
- **The deletion test** as the primary heuristic for finding shallow modules: would deleting
  the module concentrate complexity (it was earning its keep) or just move it (it was a
  pass-through)? "Concentrates" is the signal you want.
- **Decided ground** from `.decisions/` — settled ADRs touching the scope, so the pass doesn't
  re-suggest them.
- The scope (the path/area argument, if any).
- **The lens framing itself** (one of A/B/C above).

### 3. Aggregate the three lens reports — preserve divergent findings

Read all three lens reports and synthesize a single finding list with this discipline:

- **Cluster paraphrases of the same critique** across lenses into one finding, noting which
  lenses raised it.
- **Preserve divergent findings.** If only one lens raised something, **keep it — do not vote
  it down.** Annotate it as raised by 1-of-3 lenses. This is the most important rule of this
  step: naive consensus voting drops exactly the rare valuable findings each lens uniquely
  surfaces (the popularity trap). The audit has no oracle, so a single-lens finding is
  legitimate complementary information.
- **Cluster size is a confidence signal, not a filter.** 2–3-lens findings are higher
  confidence; singletons are still findings.
- **Resolve contradictions explicitly.** If one lens calls a surface deep and another calls it
  a magic-string seam, they're answering different questions about the same code — surface the
  contradiction in the finding's Problem, don't paper it over.

### 4. Coverage gate — run the smell catalog

Read [SMELLS.md](SMELLS.md) and emit one row per smell, in order, marking each `✓ checked`,
`— N/A`, or `✗ found`. This is a **coverage gate, not a candidate generator**: smells the lens
passes already raised land as `✗ found → finding N`; a smell the lenses missed but you find
gets promoted into the finding set (attribution `smell-gate`); a smell that genuinely doesn't
apply gets `— N/A` with a one-line reason. The catalog rows should match across runs even when
the findings don't — that's the comparability the gate buys. **Never hardcode the row count** —
read SMELLS.md and emit a row per smell.

### 5. Consolidate, dedup against open issues, then file one issue per finding (ADR 0099)

This is the divergence from the personal skill, and the whole point of the skill: **the output
is GitHub issues, one per consolidated finding, not a doc.**

**Consolidate first.** Collapse the aggregated findings into the final set: one issue per
*distinct* architectural problem. If two lens findings and a smell-gate row all describe the
same duplicated contract, that is **one** finding → **one** issue, with all attributions noted.
Don't file three issues for one problem; don't bundle three unrelated problems into one issue
(triage can split a bundle, but clean intake saves it the work).

**Dedup against open issues — mandatory, and last.** Before filing each finding, re-query for
an already-open issue covering the same observation. The audit is re-runnable and concurrent
report agents exist, so the same friction may already be filed:

```bash
# (a) the live needs-triage queue — read-after-write consistent, catches a just-filed twin
gh api "repos/$REPO/issues?state=open&labels=status:needs-triage&per_page=100" \
  --jq '.[] | "#\(.number) \(.title)"'
# (b) the search index — covers older open issues that already left the queue
#     join keywords with + (raw spaces produce a malformed query URL)
gh api "search/issues?q=repo:$REPO+is:issue+is:open+<keywords>" \
  --jq '.items[] | "#\(.number) \(.title)"'
```

Both commands guard different failure modes — don't drop either: (a) is read-after-write
consistent and catches an issue filed seconds ago; (b) runs against GitHub's eventually-
consistent index and covers older open issues already triaged out of the queue. **If an open
issue already covers a finding, don't file a twin** — add anything it lacks as a comment there
and move on. When results are genuinely ambiguous, file: a duplicate is cheap for triage to
close, a lost finding is gone.

**File via the `report` path.** Each surviving finding is filed exactly as
[`../report/SKILL.md`](../report/SKILL.md) files a raw observation: the type-blind five-section
body, the metadata footer, and **only** the `status:needs-triage` label — no type, no priority.
This skill is read-side of the same intake; it never classifies or prioritizes (that's triage's
call). Map the finding into the report template:

- **What I was doing** — "Architecture audit of `<scope>`, <lens(es)> pass."
- **What I observed** — the architectural friction, in `.glossary/LANGUAGE.md` vocab, with the
  file/symbol references and the smell-catalog smell it matches. The load-bearing section.
- **Why it matters** — the cost, framed in **locality** and **leverage**: what scattered, what
  the interface fails to hide, how tests are blocked. Honest about uncertainty.
- **Pointers** — repo-relative file paths (e.g. `apps/web/worker/...`), the domain term from
  `.glossary/TERMS.md`, the lens attribution (e.g. `Vocabulary only (1 of 3 — divergent,
  preserved)`), the smell number, and any settled ADR the finding touches.
- **Suggested next step (non-binding)** — the deepening direction, classified by the
  [DEEPENING.md](DEEPENING.md) dependency category (so the eventual implementer knows the test
  seam), explicitly labeled a guess, never a mandate.

```bash
# one finding, one issue — only status:needs-triage, exactly like report. The
# `tracker create-issue` verb owns this intake-create envelope (ADR 0190;
# `packages/pipeline-cli/src/tools/tracker/`) and enters the needs-triage queue by default;
# don't hand-roll the `gh api repos/$REPO/issues` create — the adoption lint (#3254) flags it.
BODY_FILE="$(mktemp /tmp/arch-audit-body.XXXXXX)"   # per-run temp file (concurrent runs share /tmp)
# … write the five sections + footer into "$BODY_FILE" …
BODY="$(cat "$BODY_FILE")"
pipeline-cli tracker create-issue \
  --title "<short, type-neutral finding summary (≤ ~70 chars)>" \
  --body "$BODY"
```

Use the `report` footer helper for the metadata block so it stays free of PII and local paths
([`../report/footer.sh`](../report/footer.sh)); `report`'s footer-privacy rule (no email or
person-tied username, no user-local home/absolute paths, repo-relative pointers only) is
non-negotiable here too — see [`../report/SKILL.md`](../report/SKILL.md) §Footer privacy.

### 6. Close

After filing, report back in one line: the count of findings filed and their issue numbers/URLs
(`gh api` returns `.number` and `.html_url`), plus any finding you *didn't* file because an open
issue already covered it (with that issue number). Then stop. Do **not** triage, prioritize, or
fix what you just filed, and do **not** write an audit doc — the issues are the artifact.

## Hard rules

- **Output is issues, never a doc (ADR 0099).** One issue per consolidated, deduped finding,
  filed as raw `status:needs-triage` intake via the `report` path. No repo audit doc, no vault
  doc, no inline ADR.
- **Vocabulary comes from `.glossary/*`.** Architecture terms from `.glossary/LANGUAGE.md`,
  domain terms from `.glossary/TERMS.md`. No "component / service / API / boundary". The skill
  does not carry its own copy of the vocabulary.
- **Read-only on application code.** The lens passes use a tool-restricted explorer (no
  Edit/Write/NotebookEdit) so the contract is structural; the orchestrator must likewise avoid
  any Edit/Write or repo-mutating Bash. The only mutation this skill performs is filing issues.
- **Repo-agnostic.** Every `gh api` call targets `$REPO`; no hardcoded repo in code or trigger
  text.
- **Type-blind, priority-blind on file.** Apply only `status:needs-triage`. Classifying or
  prioritizing here poisons the triage queue.
- **Three lenses, parallel, instruction-framed.** Not one lens, not serial, not persona-style.
  The variance reduction comes from prompt diversity.
- **Preserve divergent findings.** Single-lens findings survive into the filed set; cluster
  size is a confidence signal, not a filter.
- **The smell catalog is a coverage gate, not a candidate list** — verify the lens passes
  covered the canonical surface, don't use it as the primary discovery mechanism.
- **Dedup before filing.** The re-query (step 5) is mandatory and runs last, immediately before
  each create.
- **No embedded grilling.** Stop after filing. If a finding is worth drilling into, that's a
  separate `/grill-me`, one command away.

## Conventions

This skill is one of a suite that turns GitHub issues into an agent-operable pipeline; the
shared formats, label semantics, and target-repo resolution live in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), and the raw-intake filing
mechanics it reuses live in [`../report/SKILL.md`](../report/SKILL.md). The emits-issues +
4th-surface decision is ADR 0099; the repo-as-config portability guarantee is ADR 0062.
