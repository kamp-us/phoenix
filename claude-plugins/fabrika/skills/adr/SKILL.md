---
name: adr
description: Record one architecture decision as a `.decisions/NNNN-slug.md` file. Trigger on "/adr", "save this as an ADR", "record this decision", "ADR for X" — and reach for it too whenever a technical preference, convention, or invariant gets settled in conversation that future agents must respect, even when nobody asks for an ADR, because an unrecorded ruling is one the next session re-decides differently. Done when the file exists, the sweep landed on hits-resolved or read-by-hand, every ADR reference in it resolves as live, and the vocabulary impact is a named term or an explicit none.
---

# adr

One decision per file; the pull request adds nothing but that file plus the status-line edits it
implies, because discovery is the CLAUDE.md contract and there is no index. Examples run id `0240`.

## 1 — Claim the number

```bash
fabrika adr next
```

Unions the freshly fetched merged set with the ids open ADR PRs already claim, so a checkout sitting
at `0150` while origin is at `0151` cannot mint a duplicate.

**A non-zero exit is UNKNOWN, never "nothing reserved."** Re-run it. Falling back to the highest id
on disk mints the same number from two lanes at once.

**An empty `.decisions/` is not one of those cases — it answers `0001` and exits 0.** A repo adopting
fabrika has no records on day one, and that is a fact the verb reports, not a read it failed. Only a
directory it could not read at all refuses (exit 11). If `.decisions/` does not exist yet, create it
and re-run; a repo with no decision directory at all is a setup question for
[front-door](../front-door/SKILL.md).

## 2 — Write the decision

```bash
fabrika adr new 0240 only-landed-adrs-may-be-cited
```

Scaffolds the frontmatter and section skeleton; the slug is kebab-case, at most 5 words.

**The `title` carries the decision, not the topic** — `Every gate fails closed on zero scope`, never
`Gate scope handling`. **One clause**: where the ruling has a discriminating half, it belongs inside
that clause (`X, never Y`), never appended as a second clause after an em-dash. The corpus median is
14 words, a shape rather than a cap. It renders verbatim as this ADR's compact-map row, and the
`# NNNN — <Title>` H1 repeats it character for character. The `**What this decides:**` line beneath
is the plain-language gloss a non-author reads.

`## Decision` opens with one bolded declarative sentence, ahead of any mechanics. Where this ADR
constrains future work, close it with an austere `**Binding constraints.**` or `**Banned.**` list.

## 3 — Sweep the live ADRs this one might contradict

Two live `accepted` ADRs deciding opposite things on one question are worse than an open question:
each reads as authoritative, neither hints the other exists. Write down what this ADR settles **as
questions** — *"may an open issue exist without a milestone?"* — not as a summary; you cannot sweep
for a question you cannot phrase. Then rank the uncited live-accepted ADRs your domain touches:

```bash
fabrika adr sweep --new 0240
```

None of its three outcomes is a clearance:

- **`shortlist`** — open the entries and judge each once. It ranks lexical adjacency, caps at 8, and
  **re-ranks as you add citations**, so the tail refills and chasing a clean result is the trap.
- **`no-overlap`** — nothing mechanically adjacent was left to open, **never** that there is no
  contradiction: an ADR disagreeing with yours about what a label *means*, sharing no distinctive
  vocabulary, never appears at all. Read the domain by hand.
- **`indeterminate`** — the run carries no information: your draft yielded no distinctive term — one
  every live-accepted ADR carries is not distinctive — or the corpus is too small to rank rarity
  against. Distinctiveness is a property of your draft against the corpus, not of what it overlaps,
  so a draft whose vocabulary is entirely its own is maximally distinctive and lands on `no-overlap`
  instead. Say which fired, and read by hand regardless.

Resolve each real hit in step 4 — supersede where this ADR replaces it outright, amend-in-part where
the rest still stands. Where you only refine your own earlier ADR's mechanics and its ruling holds,
append a dated `- **#NNNN — <what changed> (YYYY-MM-DD).**` line under its `## Amendments` instead.

## 4 — Resolve every reference, then edit the status lines

```bash
fabrika adr resolve 0164 0023 0126
```

Answers against a freshly fetched base ref, printing `live`, `landed`, `in-flight` or `absent` with
the real filename. Pass every citation, supersede link and amend target in one call.

**Cite only `live`.** `landed` means present but `proposed`, `superseded` or `retired`, and citing
one as settled law applies a decision that was already withdrawn. `in-flight` may never merge, so a
citation to one can pass every gate and still be dead on arrival. **A non-zero exit is UNKNOWN,
never `absent`.** **Use the filename it prints** — a remembered slug is usually the wrong one.

```bash
fabrika adr supersede 0126 --by 0240
```

Where the rest of that ADR still stands, `fabrika adr amend-in-part 0023 --by 0240` instead.
Either verb touches the `status:` line and nothing else — an accepted ADR's decision text is
immutable, so name the relationship in your own `## Context` rather than editing theirs.

## 5 — Record the vocabulary impact

An ADR is a primary coining site, and a term coined here drifts silently unless it is routed. Land
on **exactly one** outcome; the explicit "none" separates *considered it* from *forgot to*:

- **A term is coined or redefined** → name it and route it to `.glossary/TERMS.md`: the row in this
  PR when the definition is short and unambiguous, otherwise `/glossary`.
- **Nothing is coined** → add a terminal `## Records` section and write `no vocabulary impact`.

## 6 — Check, then report

```bash
fabrika adr resolve 0240
```

Your own id, one last time: `absent` means nobody claimed it while you wrote; `in-flight` means
another lane opened its PR first, so renumber now.

**Whether this PR needs a control-plane approval is `cp-classify`'s answer, not yours** — it routes
on CODEOWNERS, and how a repo owns `.decisions/` decides it
([control-plane classification](../../docs/control-plane-classification.md)). **That gate is the
authority: do not predict it, and never reword the ADR to change its verdict.** A wrong
control-plane call costs one approval; a wrong ordinary call reaches `main` with none. If you think
it misfired, say so on the pull request.

Report the path and the vocabulary outcome; do not summarize the body.
