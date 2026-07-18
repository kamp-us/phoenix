---
name: diataxis
description: Classify a documentation page by its Diátaxis mode — tutorial, how-to, reference, or explanation — and flag type-mixing (a single page trying to serve more than one mode). Trigger on "what Diátaxis mode is this doc", "classify this doc", "is this page mixing modes", "run diataxis", "does this doc mix tutorial and reference", "which quadrant does this belong in", or whenever write-code is authoring a doc and needs to pick the right surface/shape, or review-doc is gating a prose PR and needs to check the page holds a single mode. This is a shared writing-craft procedure consumed by write-code (author in the right mode) and review-doc (verify the page didn't drift into a second mode). It classifies by the reader's need and the page's shape, never by language — the TR/EN language law is untouched (structure is mode; wording stays Turkish for product copy). It does not gate code comments (that lane is deslop-comments) and does not rewrite docs (that is a separate authoring task).
---

# diataxis

You classify a documentation page by **what the reader needs from it**, place it in one of
four modes, and flag when a page tries to be two modes at once. This is the writing-craft
lens phoenix uses so each doc surface holds a single shape — the failure this prevents is the
page that starts as a walkthrough, stops to define every option, then digresses into *why the
design is this way*, and so serves no reader well.

The four-mode model is the Diátaxis framework by Daniele Procida (diataxis.fr). The framework
itself — the two axes and the four quadrants — is an uncopyrightable method, so this skill
states it in its own words and **links out to diataxis.fr for the deep dive rather than
vendoring its prose** (no Diátaxis text is copied here, so no CC BY-SA NOTICE is owed; if a
future edit lifts Procida's phrasing verbatim, that file must carry a CC BY-SA 4.0 NOTICE per
the #3372 licensing mechanics). Read the source for the full treatment: [diataxis.fr](https://diataxis.fr).

## The two axes

A page's mode falls out of two independent questions about the reader at the moment they open
it:

- **Action ↔ Cognition** — does the page walk the reader through *doing* something (steps,
  commands, an ordered path), or does it inform their *thinking* (a description, a discussion)?
- **Acquisition ↔ Application** — is the reader *studying* (building a skill or a mental model,
  away from the real task), or *working* (at the keyboard, mid-task, needing the thing now)?

Cross the two and you get four modes. Nothing else: every documentation page serves exactly
one of these reader-needs at a time, and the value of the model is the discipline of picking
one.

## The four modes

| Mode | Reader is… | Serves | Shape | Phoenix surface |
| --- | --- | --- | --- | --- |
| **Tutorial** | learning, by doing | acquisition + action | a guided lesson the reader follows start-to-finish; you guarantee it works; concrete over complete | onboarding walkthroughs; a "build your first X" |
| **How-to guide** | working, on a goal | application + action | an ordered recipe to reach one real result; assumes competence; omits what a working reader already knows | `DEVELOPMENT.md` task recipes; a runbook; "how to add a worker" |
| **Reference** | working, needs a fact | application + cognition | a dry, complete, look-it-up description of the machinery; structured to match the code; no teaching, no opinion | `.glossary/`, an API/binding table, a command list |
| **Explanation** | studying, wants to understand | acquisition + cognition | a discussion that illuminates *why* — context, trade-offs, the roads not taken | `.decisions/` ADRs, `.patterns/` (the *why* of a shape) |

The one-line test for each:

- **Tutorial** — "follow me and you'll learn." Reader-outcome: a new skill. If it can fail
  when the reader follows it exactly, it isn't a finished tutorial.
- **How-to** — "here are the steps to *your* goal." Reader-outcome: a task done. If it teaches
  concepts the reader didn't ask about, it's leaking into tutorial/explanation.
- **Reference** — "here is what is true." Reader-outcome: a fact confirmed. If it argues a
  point or walks a sequence, it's leaking into explanation/how-to.
- **Explanation** — "here is why it is so." Reader-outcome: understanding. If it lists exact
  steps or exhaustive parameters, it's leaking into how-to/reference.

## Classification procedure

Given a page (or a section), classify it in this order — the questions are ordered so the
first "yes" wins:

1. **Does it prescribe an ordered sequence of actions the reader performs?** If no → it is
   **cognition** (go to step 4). If yes → it is **action** (go to step 2).
2. **Is the sequence a lesson the *author* chose to teach a skill (the reader is a learner,
   the destination is illustrative)?** → **Tutorial**.
3. Otherwise the sequence serves a goal the *reader* brought (they are competent, the
   destination is real) → **How-to guide**.
4. **Cognition: is the page there to be *looked up* — a described, structured account of what
   is, with no argument?** → **Reference**.
5. Otherwise it exists to make the reader *understand why* — context, reasoning, alternatives
   → **Explanation**.

Report the mode plus the one signal that decided it (e.g. "How-to — it's an ordered recipe to
a reader-brought goal, assumes the worker already knows what a DO is").

## Type-mixing — the flag

The framework's central discipline: **one page, one mode.** A page mixes types when it serves
more than one reader-need, and the fix is almost always to *split* it, not to blend it better.
The recurring smells, by host mode:

- **Tutorial that stops to explain.** A learning walkthrough that pauses to justify *why* a
  step is designed this way. The *why* belongs in a linked explanation; the tutorial links out
  and keeps moving.
- **Tutorial or how-to that becomes reference.** Steps interrupted by an exhaustive table of
  every option/flag. The exhaustive list is reference; link to it, don't inline it.
- **How-to that teaches.** A recipe that first explains the concepts a competent reader
  already has. Cut the lesson; a how-to assumes competence.
- **Reference that argues.** A look-it-up description that editorializes about trade-offs or
  the right choice. Move the opinion to an explanation; reference states what is true, dryly.
- **Explanation that prescribes.** A why-discussion that hardens into exact steps or a full
  parameter list. Extract the steps to a how-to and the parameters to reference; the
  explanation links to both.

To flag: name the page's **primary** (host) mode, then each **intruding** mode with the
specific passage that intrudes, and the split that resolves it (which content moves to which
surface). A page that holds a single mode gets a clean "single-mode: <mode>" — the absence of
a flag is a real result, not a non-answer.

## How the pipeline consumes this

- **write-code (authoring a doc):** before writing, classify the reader-need the doc must
  serve and pick the matching mode *and phoenix surface* (the table above maps modes to
  surfaces — an ADR is explanation, a `DEVELOPMENT.md` recipe is how-to, `.glossary/` is
  reference). Author to that one mode; when the material pulls toward a second mode, split it
  out to the surface that owns that mode and link, rather than blending.
- **review-doc (gating a prose PR):** run the classification on the changed page, then the
  type-mixing flag. A page that has drifted into a second mode is a doc-hygiene finding on top
  of the acceptance-criteria check — cite the host mode, the intruding passage, and the split.
  This does not replace review-doc's AC verification; it's a lens it applies to the prose.

## Scope boundaries

- **Docs, not code comments.** This classifies documentation *pages*. Inline code comments are
  a different lane owned by [`deslop-comments`](../deslop-comments/SKILL.md) — do not reach
  into it.
- **Classify, don't rewrite.** This skill *names* the mode and *flags* the mix. Rewriting a
  mixed doc into single-mode surfaces is a separate authoring task (a write-code job with its
  own issue), not something this procedure performs.
- **Language-agnostic.** Mode is a property of the reader's need and the page's shape, never
  its language. The TR/EN language law is untouched: product/user-facing copy stays Turkish,
  technical surfaces stay English, and this classification runs the same over both.
