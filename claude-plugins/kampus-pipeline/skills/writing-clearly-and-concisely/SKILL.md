---
name: writing-clearly-and-concisely
description: Use when writing or editing English prose a human will read — docs, README/DEVELOPMENT, ADR and pattern bodies, PR descriptions, commit messages, issue bodies, error copy, and surviving load-bearing code comments. Applies Strunk's Elements of Style (write clearly, cut ruthlessly) plus a catalog of AI writing tells to avoid. This is the prose-craft skill review-doc's prose check and write-code's doc path read before they judge or generate prose. Trigger on "make this clearer/tighter", "cut the fluff", "this reads like AI", "writing-clearly-and-concisely", or any prose-authoring task. NOT for non-English product/brand copy (Turkish stays Turkish, .glossary/LANGUAGE.md) and NOT a bulk pass over existing prose (that is a separate, scoped campaign).
---

# writing-clearly-and-concisely

Write English prose that a human reads without friction: clear, concrete, no wasted
words, and free of the patterns that mark text as machine-generated. Two bodies of
guidance — **what to do** (Strunk) and **what to avoid** (AI tells) — plus the phoenix
rules for where this applies.

This is a composite adapted from third-party sources; licensing and attribution live in
[`NOTICE.md`](NOTICE.md).

## When to use it

Any time you author or edit English prose for a human reader:

- Docs: README, DEVELOPMENT.md, `.decisions/` and `.patterns/` bodies, `.glossary/`.
- Pipeline artifacts: PR descriptions, issue bodies, epic plans, progress comments.
- Commit messages.
- Error copy and UI help text written in English (the source copy — translation is
  charted separately).
- Surviving load-bearing code comments (see scope below).

If you are writing sentences for a human to read, this skill applies.

## Scope

**In scope — English prose surfaces**, including the *surviving* load-bearing code
comments phoenix keeps: a local invariant at its enforcement site, a workaround plus its
forcing constraint, a `// See ADR NNNN` pointer, a pragma rationale. Where such a comment
stays, it should read clearly and carry no AI tells.

**`deslop-comments` keeps kill authority.** This skill governs *how a comment reads*, not
*whether it survives* — the cut/keep decision belongs to
[`deslop-comments`](../deslop-comments/SKILL.md). The two never fight: deslop decides what
stays, this skill sharpens what stays. **Pointers and invariants are never trimmed for
concision** — a `// See ADR 0155` line or a one-line invariant is already at its floor;
"omit needless words" never means deleting the load-bearing note.

**House idioms are exempt.** phoenix's own conventional phrasings — `§CP`, `Fixes #N`,
`fail-closed`, the `Completed / Decisions / Gotchas / Next` progress-comment headers, ADR
frontmatter, the glossary's defined terms — are established vocabulary, not slop. Do not
"improve" them.

**Out of scope:**

- **Applying this skill to existing prose in bulk** — the repo-wide cleanup is a separate,
  scoped campaign, not something to trigger opportunistically here.
- **Non-English product/brand copy** — Turkish product names and user-facing copy stay
  Turkish (CLAUDE.md; [`.glossary/LANGUAGE.md`](../../../../.glossary/LANGUAGE.md)). This
  skill is for the *English technical* register only.

## What to do — Strunk

William Strunk Jr.'s *The Elements of Style* (1918, public domain) is the base. The rules
that carry the most weight in technical prose:

- **Use the active voice.**
- **Put statements in positive form.**
- **Use definite, specific, concrete language.**
- **Omit needless words.**
- **Keep related words together.**
- **Place the emphatic words of a sentence at the end.**

Full text with examples lives in [`elements-of-style/`](elements-of-style/), split so you
load only what you need:

| Section | File |
|---------|------|
| Grammar, punctuation, comma rules | [`02-elementary-rules-of-usage.md`](elements-of-style/02-elementary-rules-of-usage.md) |
| Paragraphs, active voice, concision | [`03-elementary-principles-of-composition.md`](elements-of-style/03-elementary-principles-of-composition.md) |
| Headings, quotations, formatting | [`04-a-few-matters-of-form.md`](elements-of-style/04-a-few-matters-of-form.md) |
| Word choice, common errors | [`05-words-and-expressions-commonly-misused.md`](elements-of-style/05-words-and-expressions-commonly-misused.md) |

Most tasks need only `03-elementary-principles-of-composition.md` — active voice, positive
form, concrete language, omitting needless words.

## What to avoid — AI tells

LLM prose regresses to a statistical mean: puffed-up, formulaic, and instantly
recognizable. The catalog of tells — magic adverbs, "delve"/"leverage" vocabulary,
negative parallelism ("not X — it's Y"), em-dash addiction, bold-first bullets, signposted
conclusions, stakes inflation — is in
[`references/ai-writing-tropes.md`](references/ai-writing-tropes.md). One instance is
usually fine; the tell is **density**. Draft, then check the draft against the catalog and
rewrite what matches.

## Tight-context strategy

When context is tight, don't load everything: draft with judgment, then dispatch a
subagent with your draft plus the one relevant section
(`03-elementary-principles-of-composition.md` or `references/ai-writing-tropes.md`) to
copyedit and return the revision.

## Bottom line

Load the relevant section, apply the rules, and re-read the draft for AI tells before you
ship it. For most prose, `03-elementary-principles-of-composition.md` plus the tells
catalog cover what matters.
