---
name: report
description: File one follow-up GitHub issue the moment you spot work you will not do right now — a bug, a refactor, a design question, a missing test, a confusing convention. Fire it mid-task and autonomously, without asking permission and without finishing what you were doing first, because an observation that stays in the conversation dies there. Also trigger on "/report", "file an issue", "report this", "open a follow-up", "track this for later". Done when the issue exists carrying `status:needs-triage` and nothing else, and you are back on the task you interrupted.
---

# report

**Intake, not judgment.** You saw something while doing other work. Capture it faithfully and go —
a later `triage` run decides what it is and what it is worth, so this skill applies exactly one
label, `status:needs-triage`, and treats every classification question as somebody else's.

Capturing costs almost nothing, which is why there is no permission step: proposing first turns a
five-second capture into a conversation, and the observation that waits for an answer is the one
that dies.

## 1 — Write the observation

The title first — short, specific, type-neutral. *"Retry helper in the http worker swallows the
abort reason"* names what you saw; *"Bug in worker"* names nothing, and *"BUG: fix retry"* types
and prescribes in four words.

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

## 2 — Check whether it is already filed

Report runs go concurrently, so what you just saw may have reached the board minutes ago. Run this
**after** the body is written and immediately before filing, so the window between checking and
creating stays small:

```bash
fabrika-cli report dedup --query "the title plus a few distinguishing keywords"
```

Three outcomes, and only one of them is about your observation:

- **`candidates`** — open each and judge it yourself. Shared vocabulary is not a shared observation.
- **`none`** — both sources were read and nothing open matched. A real answer.
- **`indeterminate`** — your query carried no distinctive keywords, so nothing was compared. This is
  a non-check, not a clean one. Re-query with the specific terms.

A non-zero exit is UNKNOWN, never `none`. **When it is genuinely ambiguous, file it** — triage
closes a duplicate in seconds, and a lost observation is gone.

## 3 — File it

```bash
fabrika-cli report file --title "Retry helper in the http worker swallows the abort reason" <<'EOF'
## Summary
…
EOF
```

The body arrives on this verb's stdin and never becomes a filename. That is the design, not an
implementation detail: every issue-body leak in the record is one agent reaching for a *path* where
a body belonged — a file-referencing post form sends the literal path text instead of the file's
contents, so a machine-local path lands in a public artifact while the poster reads success
(#3086, #3173).

**When the verb refuses, fix the input and run it again.** A refusal names one thing — an empty
section, a machine-local path in the body, a missing queue label, a body that never reached stdin —
and each is a thing to correct. A refusal is never a signal to post some other way: that is the
path #3945 walked, where a blocked command was retried through a file-referencing form and landed
the exact leak the guard had just declined.

Use `--redact` when a machine-local path is genuinely part of the evidence — reporting a leak
incident is the case it exists for. It masks each path down to its class and says so; it never
silently rewrites what you wrote.

## 4 — Or add what the existing issue lacks

When step 2 found your observation already filed, do not file a twin. Add only what that issue does
not already carry:

```bash
fabrika-cli report note --issue 4705 <<'EOF'
…
EOF
```

Same stdin, same refusals, same reason for both.

## 5 — Report and return

One line: the issue number and its URL, as the verb printed them. Then **go back to the task you
interrupted.** You are not triaging what you filed, and you are not fixing it.
