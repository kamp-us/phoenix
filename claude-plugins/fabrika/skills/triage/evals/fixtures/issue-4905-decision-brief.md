# Issue #4905 — `status:needs-triage`, open

**Title:** Decide whether the sözlük ever canonicalizes two başlıks that name the same thing

**Author:** usirin

**Body:**

## Summary
One question, and it is upstream of work in both directions: when two başlıks name the same thing,
does the sözlük get a canonicalizing move — a moderator pointing one başlık at another — or is a
başlık a literal string, so two spellings are two başlıks by design and duplication is not a defect?
The product cannot express either position today, and I could not find anywhere the question was
settled.

## What I was doing
Reading the sözlük term surface to see what a moderator can actually do to a başlık, while checking
something unrelated in the term read model.

## What I observed
There is no term-level operation anywhere. The sözlük mutation set in
`apps/web/worker/features/sozluk/mutations.ts` is seven definition mutations — `definition.add`,
`definition.vote`, `definition.retractVote`, `definition.react`, `definition.edit`,
`definition.delete`, `definition.restore` — and nothing keyed on a term: no create, no rename, no
alias, no merge. A başlık exists as a side effect of the first definition written under it
(`Sozluk.addDefinition` derives `termCreated = !existing`, and the row lands via
`persistTermSummary`). The `term_record` declaration in `packages/db-schema/src/index.ts` matches:
`slug` (primary key), `title`, `first_letter`, `definition_count`, `total_score`, `excerpt`,
`top_definition_id` and three timestamps — no column that could hold "this başlık is really that
one."

So the model holds no position, and nothing records one either: no ADR under `.decisions/` names
term merging, aliasing or duplication, and searching the board for `term merge` / `duplicate başlık`
/ `synonym` / `rename term` / `canonical term` across open and closed turns up nothing on the
subject.

Two options, both live:

**Option A — a başlık names a concept, so the corpus gets a canonicalizing move.** A moderator can
point one başlık at another; the retired title keeps its definitions' text while its page resolves
to the survivor. One concept, one page: whichever spelling a reader lands on, they end up where the
writing is, and attention stops splitting. The cost is a destructive moderator power exercised over
other people's context — a definition written under one title now reads under another — and somebody
has to adjudicate "same thing," which is exactly the call a small community argues about.

**Option B — a başlık is a literal string, and duplication is not a defect.** The sözlük never
rewrites what somebody typed: two spellings stay two başlıks permanently, and "these are the same"
is a reader's judgment, never a moderator's. Nothing destructive ever runs over the corpus and
nobody adjudicates sameness. The cost is that the corpus carries the split forever, with no signal
telling a reader which page the writing actually lives on.

## Why it matters
Neither direction is buildable until it is recorded. Under A the term model needs somewhere to hold
the pointer and the moderation surface needs the action — neither exists. Under B the answer to
every future "these two başlıks are duplicates" report is "working as intended," which is worth
writing down once instead of re-arguing per report. Picking it up as a build first and deciding
afterwards means doing it twice.

## Pointers
- `apps/web/worker/features/sozluk/mutations.ts` — the definition-only mutation set
- `packages/db-schema/src/index.ts` — `term_record`, the columns a başlık actually has
- Adjacent, and deliberately not treated as deciding this: ADR 0080 puts related/see-also on the
  semantic *discovery* axis (search recall, not corpus structure), and ADR 0122 rules usernames
  immutable for v1 — the same class of question asked about a different noun.

## Suggested next step (non-binding)
None, and no lean on purpose — this is a call, not a patch. Both options are cheap to state and
expensive to reverse once either has code behind it.

<sub>Filed by an agent · session 7a3c · claude-opus-5</sub>
