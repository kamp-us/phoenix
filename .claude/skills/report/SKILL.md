---
name: report
description: File a follow-up GitHub issue the moment you spot work you won't do right now — a bug, a refactor, a design question, an investigation, missing tests, a confusing convention. Trigger autonomously, mid-task, without asking permission, whenever you notice something worth tracking but tangential to what you're doing. Also trigger on "file an issue", "report this", "open a follow-up", "track this for later", "/report".
---

# report

You spotted something while doing other work. Capturing it must cost you almost nothing — file it and get back to your task. This skill is the seam between "I noticed X" and a triageable GitHub issue, so observations don't die in the conversation.

File autonomously. Do **not** propose-first or ask for permission — the whole point is zero interruption to your main task. The issue you file is raw intake; a separate `triage` skill classifies and prioritizes it later. Your job is to capture context faithfully, not to judge it.

## What you are NOT doing

- **No type.** Don't decide if it's a bug / feature / chore / decision / investigation / epic. That's triage's call.
- **No priority, no severity.** Don't apply `p0`/`p1`/`p2` or describe something as critical/blocker/minor in a way that pre-empts triage.
- **No solution lock-in.** Your "suggested next step" is a non-binding hint, explicitly the reporter's guess, not a mandate.

You apply exactly one label: `status:needs-triage`. Nothing else. Typing or prioritizing here would poison the triage queue — a hand-applied type looks identical to a triaged one, and triage can no longer trust the signal.

## The 5-section body template

The body is **type-blind** by design: the same five sections fit a bug, a refactor, a question, or an investigation, so you never have to classify to file. Use these exact section headings:

```markdown
## What I was doing
<The task in flight when this surfaced. One or two sentences. Concrete: what file, what feature, what command.>

## What I observed
<The thing itself. Be specific and factual. Paste the error, name the function, quote the surprising line. This is the load-bearing section — triage acts on it.>

## Why it matters
<The cost of leaving it. Who or what is affected, and roughly how. Honest about uncertainty — "might cause X" is fine. Don't inflate to manufacture urgency; don't downplay to be polite.>

## Pointers
<Where to look: file paths (repo-relative, e.g. `apps/web/worker/...`), function names, related issue/PR numbers, ADR/pattern doc links. Give the next reader a running start.>

## Suggested next step (non-binding)
<Your best guess at a first move, clearly labeled a guess. "Maybe extract the retry logic into a helper" — not "Extract the retry logic." Triage and the implementer are free to ignore this. Leave it blank if you genuinely have no idea; an empty hint is better than a misleading one.>
```

Keep it tight. A faithful three-line observation beats a padded essay — triage needs signal, not volume.

## The metadata footer

Below the five sections, append a footer carrying the machine context of the session that filed the report, so triage and future debugging can trace which run produced it. Fields are **best-effort**: include what's available, omit silently what isn't (don't write "unknown" or leave dangling labels).

Gather the context with the helper, which reads it from the environment and git:

```bash
.claude/skills/report/footer.sh
```

It prints a ready-to-append markdown block like:

```markdown
---
<sub>Filed by an agent · session `abc123…` · model `claude-opus-4-8` · branch `umut/some-branch` · 2026-06-12T08:14:01Z</sub>
```

Include at least **session id (when available), model, branch, and timestamp**. If the helper can't find a field it drops it from the line.

### Footer privacy — non-negotiable

The footer is machine context, never personal context.

- **No PII.** No email addresses, no usernames tied to a person, no author identity. `git config user.email` and `user.name` are off-limits — that's why the helper never reads them.
- **No user-local absolute paths.** Never `/Users/...`, `~/.claude`, `~/.usirin`, or any home-directory path. Paths in the body's Pointers section must be repo-relative. The footer carries no paths at all.

If you ever assemble the footer by hand instead of via the helper, apply the same rule: machine/session context only, and scrub anything that could identify a person or leak a local filesystem layout.

## Filing the issue

All GitHub operations go through `gh api` REST. **Never GraphQL** — the kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue queries.

1. Write the title: a short, specific, type-neutral summary of the observation (≤ ~70 chars). Good: "Retry helper in http worker swallows the abort reason". Bad: "Bug in worker" or "BUG: fix retry".
2. Build the body: the five sections, then a blank line, then the footer block from `footer.sh`.
3. File it, applying only `status:needs-triage`:

```bash
gh api repos/kamp-us/phoenix/issues \
  -f title="<title>" \
  -f body="$BODY" \
  -f "labels[]=status:needs-triage"
```

Write the body to a temp file and read it into `$BODY` (e.g. `BODY="$(cat /tmp/report-body.md)"`) so multi-line markdown and backticks survive the shell intact.

4. Report back to the user in one line: the issue number and URL (`gh api` returns them as `.number` and `.html_url`). Then return to your original task — don't expand into triaging or fixing what you just filed.

## Conventions

This skill is one of a suite that turns GitHub issues into an agent-operable pipeline; the shared formats and label semantics are documented in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) (the report template here is its own type-blind thing, but the label dimensions and progress/handoff formats live there).

- One observation, one issue. If you noticed two genuinely separate things, file two — don't bundle. (Triage can split bundles, but clean intake saves it the work.)
- Don't file duplicates carelessly: a quick `gh issue list --search "<keyword>"` before filing is worth it if the observation feels like something you might have already seen. Not a hard gate — when in doubt, file; a duplicate is cheap for triage to close, a lost observation is gone.
