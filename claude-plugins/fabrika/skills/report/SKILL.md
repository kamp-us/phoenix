---
name: report
description: "File one follow-up GitHub issue the moment you spot work you will not do right now — a bug, a refactor, a design question, a missing test, a confusing convention. Fire it mid-task and autonomously, without asking permission and without finishing what you were doing first. Also trigger on \"/report\", \"file an issue\", \"report this\", \"open a follow-up\", \"track this for later\"."
---

# report

**Intake, not judgment.** You saw something while doing other work. Capture it faithfully and go —
a later `triage` run decides what it is and what it is worth, so this skill applies exactly one
label, `status:needs-triage`, and treats every classification question as somebody else's.

Capturing costs almost nothing, which is why there is no permission step: proposing first turns a
five-second capture into a conversation, and the observation that waits for an answer is the one
that dies.

## 1 — Write the observation

The title first — short (aim under ~70 characters), specific, type-neutral. *"Aborted requests in
the http worker surface as plain timeouts"* names what you saw; *"Bug in worker"* names nothing,
and *"BUG: fix aborts"* types and prescribes in three words.

Then six sections. They are the same six whether you found a crash, a smell, or a question — that
sameness is what lets you file without classifying first:

- **`## Summary`** — 2–3 plain sentences a triager grasps on a skim. Prose, no jargon. It leads the
  body; it never replaces what follows.
- **`## What I was doing`** — the task in flight when this surfaced. Which file, which command.
- **`## What I observed`** — the thing itself, factual and specific. Paste the error, name the
  function, quote the surprising line. Triage acts on this section; the others orient it.
- **`## Why it matters`** — the cost of leaving it, honest about uncertainty. "Might cause X" is a
  good sentence. Inflating to manufacture urgency and downplaying to be polite fail the same way:
  triage prices it wrong.
- **`## Pointers`** — repo-relative paths, function names, issue and PR numbers, ADR links.
- **`## Suggested next step (non-binding)`** — your best guess, labeled a guess. Blank beats
  misleading.

**Record what you saw, not what it is.** No type, no priority, no *critical* / *blocker* / *minor*.
A hand-typed classification is indistinguishable from a triaged one, so a guess here silently
corrupts the signal triage runs on. One observation, one issue — two things you noticed are two
filings.

You are done here when all six sections carry content, except the last, which may be empty. The
section names the verb checks for, and how it decides a section is empty, are its own section
(`fabrika wire doc-section --heading "report file" < <skill-base>/contract.md`).

## 2 — Check whether it is already filed

Report runs go concurrently, so what you just saw may have reached the board minutes ago. Run this
**after** the body is written and immediately before filing, so the window between checking and
creating stays small:

```bash
fabrika report dedup --query "http worker aborted request downstream plain timeout reason"
```

Which sources it reads and how the cap is applied are the verb's section
(`fabrika wire doc-section --heading "report dedup" < <skill-base>/contract.md`). Three outcomes, and
only one of them is about your observation:

- **`candidates`** — open each and judge it yourself. Shared vocabulary is not a shared observation.
  The list is capped, and the verb says on stderr when it truncated.
- **`none`** — both sources were read and nothing open matched. A real answer.
- **`indeterminate`** — your query carried too few distinctive keywords to discriminate, so nothing
  useful was compared. This is a non-check, not a clean one. Re-query with the specific terms.

A non-zero exit is UNKNOWN, never `none`. **When it is genuinely ambiguous, file it** — triage
closes a duplicate in seconds, and a lost observation is gone.

You are done here when the outcome has told you which of the next two steps you are taking, and
they are branches of one decision rather than two things to do in order:

- **`none`, an `indeterminate` you re-queried and cleared, or candidates none of which is your
  observation** → step 3, file it.
- **A candidate you have judged to be the same observation** → step 4, add what it lacks.
- **A non-zero exit, or an `indeterminate` a re-query did not clear** → step 3, file it. The check
  answered nothing, so it cannot be the thing that stops you; say in the filing that the duplicate
  check did not run, and let triage close a twin in seconds.

## 3 — File it — the branch where nothing already covers it

```bash
fabrika report file --title "Aborted requests in the http worker surface as plain timeouts" <<'EOF'
## Summary
…
EOF
```

**When the verb refuses, fix the input and run it again.** A refusal names one thing — an empty
section, a machine-local path in the body, a body that never reached stdin, a title that classifies
— and each is a thing to correct. **A refusal is never a signal to post some other way.** Retrying a
blocked command through a form that passes the body as a *file path* posts the path text instead of
the file's contents, which is how a machine-local path reaches a public artifact while the poster
reads success — the rule and its reasoning are one section
(`fabrika wire doc-section --heading "The body is a value, never a path" < <skill-base>/contract.md`).
Which exit carries which refusal is
`--heading "The shared exit taxonomy for the writing verbs"`, and what counts as a leak is
`--heading "The body-surface leak predicate"`.

Use `--redact` when a machine-local path is genuinely part of the evidence — reporting a leak
incident is the case it exists for. It masks each path down to its class and says so; it never
silently rewrites what you wrote.

You are done here when the verb exits 0 and prints the number and URL.

## 4 — Add what the existing issue lacks — the branch where step 2 found it

When step 2 found your observation already filed, do not file a twin. Add only what that issue does
not already carry, over the same guarded path:

```bash
fabrika report note --issue 4312 <<'EOF'
…
EOF
```

Done when the verb exits 0 and prints the comment id and URL. It runs the same guards as `file` over
a comment body, and its section says which
(`fabrika wire doc-section --heading "report note" < <skill-base>/contract.md`).

**When the correction belongs in the body rather than under it, amend — never rewrite.** GitHub
keeps no issue-body history, so a hand-rolled `gh api -X PATCH -f body=@file` that posts the path
instead of the file destroys the body it was correcting (#6708, #6736). `fabrika report amend
--issue <n>` appends your section under a separator and a dated heading it composes, leaves the
prior body verbatim, and proves both halves on the read-back
(`fabrika wire doc-section --heading "report amend" < <skill-base>/contract.md`).

## 5 — Report and return

One line: the number and URL the verb printed. Then **go back to the task you interrupted.** You are
not triaging what you filed, and you are not fixing it.
