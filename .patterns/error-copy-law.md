# The error-copy law — English source copy

The voice-and-clarity law for the **English source copy** of an error message: the words a
user reads when an operation fails. It governs *how the copy is written*, not *how the
message reaches the client* — that mechanism is already owned by two things this law is
**subordinate to** and never replaces:

- **The `wireMessages` registry** ([`apps/web/src/fate/wireMessages.ts`](../apps/web/src/fate/wireMessages.ts)) —
  the exhaustive `FateWireCode`→copy map (`WIRE_MESSAGES`) + per-surface `overrides`. It owns
  *which* copy a code resolves to and the exhaustive-by-construction guarantee (a new code with
  no message is a compile error, not a silent fallback). This law governs that each string in it
  reads well; it does not touch the registry's structure or its exhaustiveness guard.
- **The no-leak codec** ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md)) — `encodeWireError`
  is total and replaces every defect/un-annotated failure with the fixed internal message, so infra
  detail never reaches the wire. This law leans on that guard; it does not re-implement it. An
  authored `message` on an annotated domain error crosses to the client **verbatim**, so the
  copy-craft rules below are what stand between a good message and a bad one — the codec cannot
  make a verbose or blaming string better, only stop a *leak*.

Where an error is declared and how its wire code is annotated is [effect-errors.md](./effect-errors.md)
+ [fate-effect-wire-errors.md](./fate-effect-wire-errors.md); read those for the *mechanism*. Read
this doc for the *copy* — the words in the `message` field and in `WIRE_MESSAGES`.

## Out of scope: i18n / translation

This law governs **English source copy only**. kamp.us user-facing copy is authored in English as
the source language and shipped in Turkish (later other locales) through a translation layer — that
direction (the i18n mechanism, the EN→TR translation-quality craft, and the explicit re-litigation
of the current Turkish-first registries against `.glossary/LANGUAGE.md` §3) is charted separately in
[#3378](https://github.com/kamp-us/phoenix/issues/3378). This law does **not** translate copy,
migrate the existing Turkish strings in `WIRE_MESSAGES`, or settle the shipped register
(capitalization, formality) — those belong to #3378. It states only the craft invariants that hold
for the English source string regardless of how it is later translated or cased.

> The strings currently in `WIRE_MESSAGES` are Turkish — the pre-i18n reality #3378 addresses. Until
> that migration lands, this law is the going-forward authoring rule for new English source copy; it
> does not retroactively rewrite the existing catalog.

## The law

1. **Say what happened, then what to do.** Name the failed condition in the user's terms, and where
   the user can act, name the next step. "That title is too long — keep it under 120 characters"
   beats "Title validation failed." Where there is no user action (an internal failure), a calm
   retry line is the whole message — and that line is the codec's fixed internal arm, not something
   you author per-site.

2. **Second person, plain language.** Address the user directly; use the words a non-engineer uses.
   No error codes, tags, HTTP status, SQL, or infra nouns in the copy — the `FateWireCode` is the
   machine key, never the human sentence.

3. **State the condition, don't blame or alarm.** Neutral and calm. Don't scold ("You entered an
   invalid value") or catastrophize ("Fatal error!"). Describe what is true and what unblocks it.

4. **Omit needless words.** One line where one line will do; cut throat-clearing ("Unfortunately,
   it appears that…"), redundant qualifiers, and restated context. The lean-prose discipline of the
   writing-craft campaign ([#3379](https://github.com/kamp-us/phoenix/issues/3379)) applies to error
   copy as to any other English prose surface.

5. **No internal detail in an authored `message`.** An annotated domain error's `message` reaches
   the client verbatim, so it must carry zero infra detail (no exception text, no table/column, no
   file path). This is the copy-side half of the codec's no-leak contract: the codec scrubs
   *defects*, but an annotated `message` bypasses that scrub — the author is the guard there. Infra
   failures belong in the defect channel, where the codec supplies the fixed internal line
   ([fate-effect-wire-errors.md](./fate-effect-wire-errors.md) › "What not to do").

6. **One code, one canonical message.** A wire code's base copy is authored once in `WIRE_MESSAGES`;
   a surface reaches for an `override` only when its copy genuinely differs (the char-limit phrasings,
   the per-entity noun). Don't re-phrase the same condition differently across surfaces — the
   registry's single base message is the consistency lever this law relies on.

## What this law does not decide

- **Register** — capitalization, formal/informal address, sentence-vs-fragment — is a product/brand
  voice question owned by the #3378 i18n/voice chart, not settled here.
- **Which strings ship in which language**, and how translation is authored and gated — #3378.
- **The registry structure or the codec** — [fate-effect-wire-errors.md](./fate-effect-wire-errors.md);
  this law is subordinate to both.
