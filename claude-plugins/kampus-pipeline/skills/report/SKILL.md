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

## Lead with a plain-language summary

Before the structured sections, open the body with a **plain-language, human-first
summary — 2–3 sentences a reader grasps on a skim**: what you observed and why it's worth
tracking, in prose, no jargon. It **precedes, never replaces**, the structured body below —
a triager skimming the queue reads it first (the human-first-summary mandate from
[#3374](https://github.com/kamp-us/phoenix/issues/3374)). Give it the heading `## Summary`.

## The 5-section body template

The body is **type-blind** by design: the same five sections fit a bug, a refactor, a question, or an investigation, so you never have to classify to file. Under the `## Summary` lead above, use these exact section headings:

```markdown
## Summary
<2–3 plain-language sentences a reader grasps on a skim: what you observed and why it's worth tracking. The human-first lead, before the structured sections below.>

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
claude-plugins/kampus-pipeline/skills/report/footer.sh
```

It prints a ready-to-append markdown block. Which fields appear varies by run — the helper includes only what the environment actually exposes and silently drops the rest, so a real footer might look like this (here `session` and `model` weren't available, so they're omitted — no dangling labels, no "unknown"):

```markdown
---
<sub>Filed by an agent · branch `<prefix>/some-branch` · 2026-06-12T08:14:01Z</sub>
```

Aim for **session id, model, branch, and timestamp** — but all are best-effort. Model and session often come from env vars that are unset, so don't be surprised when they drop; whatever the helper can resolve is what you get.

### Footer privacy — non-negotiable

The footer is machine context, never personal context.

- **No PII.** No email addresses, no usernames tied to a person, no author identity. `git config user.email` and `user.name` are off-limits — that's why the helper never reads them.
- **No user-local absolute paths.** Never `/Users/...`, `~/.claude`, `~/.usirin`, or any home-directory path. Paths in the body's Pointers section must be repo-relative. The footer carries no paths at all.

If you ever assemble the footer by hand instead of via the helper, apply the same rule: machine/session context only, and scrub anything that could identify a person or leak a local filesystem layout.

## Filing the issue

All GitHub operations go through `gh api` REST. **Never GraphQL** — the kamp-us org runs a legacy Projects-classic integration that breaks GraphQL issue queries.

**Resolve the target repo once, up front.** This skill is repo-agnostic — every `gh api` call targets `$REPO`, not a hardcoded repo. Resolve it at the top of your run per the shared contract's **Target repo resolution** ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md)): `$CLAUDE_PIPELINE_REPO` if set, else the current repository. In phoenix this defaults to `kamp-us/phoenix`, so the behavior is unchanged with no config (ADR 0062 §1).

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

1. Write the title: a short, specific, type-neutral summary of the observation (≤ ~70 chars). Good: "Retry helper in http worker swallows the abort reason". Bad: "Bug in worker" or "BUG: fix retry".
2. Build the body: the `## Summary` lead, then the five sections, then a blank line, then the footer block from `footer.sh`.
3. **Re-query for an existing issue — always, and last.** Report agents run
   concurrently (several people run them at once), so the same observation may have
   been filed minutes ago. Run this check *after* composing the body, as the final
   action before the create call — composing first keeps the window between check
   and create as small as possible. Run the shared **intake-dedup tool** (ADR 0181):
   one tested implementation of the "is there already an open issue for this?" query,
   fed your title plus a few keywords:

   ```bash
   node packages/pipeline-cli/src/bin.ts intake-dedup check \
     --query "<the title + a few distinguishing keywords>"
   ```

   It prints one `#<n>\t<title>` line per candidate duplicate to stdout (empty output
   ⇒ no likely match) and the candidate count on stderr. Under the hood it runs the
   same two sources this check always used and fuses them — the label list is
   read-after-write consistent and catches an issue filed seconds ago, while the
   search runs against GitHub's eventually-consistent index (fresh issues can lag out
   of it) but covers older open issues that already left the queue. Keyword joining
   and query-shape are the tool's job now — you pass free text, not a hand-built
   `q=` string. It resolves the target repo itself per ADR 0062 §1 (`$CLAUDE_PIPELINE_REPO`
   → `$GITHUB_REPOSITORY` → the current repo), so it needs no `$REPO`.

   If an existing issue covers the same observation, don't file a twin — add anything
   you know that it lacks as a comment there, and return to your task.
4. File it, applying only `status:needs-triage`.

Stream the composed body **straight into the create call over stdin** — there is no named temp file to collide on and no shell variable to reuse stale, so two concurrent `report` runs cannot interleave bodies (the cross-filing hazard is structurally unrepresentable, not merely warned against — #2002). `-F body=@-` reads the `body` field verbatim from stdin, and the **quoted** heredoc (`<<'EOF'`) passes the markdown through untouched — so multi-line markdown, backticks, and nested fences survive intact, the "backticks survive the shell" guarantee with no round-trip through a variable:

```bash
# The five sections + a blank line + the footer.sh block, piped straight into the
# REST create over stdin. No mktemp, no $BODY_FILE, no `$(cat …)` — nothing shared to
# collide on. `-F body=@-` consumes the whole stream as the body field; `-f title`/
# `-f labels[]` stay ordinary POST fields. The quoted `<<'EOF'` heredoc means the shell
# never touches the markdown, so backticks and nested ``` fences file intact.
{
  cat <<'EOF'
## Summary
…

## What I was doing
…

## What I observed
…

## Why it matters
…

## Pointers
…

## Suggested next step (non-binding)
…
EOF
  echo   # blank line before the footer block
  claude-plugins/kampus-pipeline/skills/report/footer.sh   # emits its own `---` + <sub>… line
} | gh api repos/$REPO/issues \
  -f title="<title>" \
  -F body=@- \
  -f "labels[]=status:needs-triage"
```

The body never lands on disk under a shared name and never round-trips through a variable, so the two named failure paths this hardening closes — "simplify" to a fixed `/tmp/report-body.md`, or reuse one `$BODY_FILE` across two creates — have no surface to occur on: there is no file path to fix and no variable to reuse.

5. Report back to the user in one line: the issue number and URL (`gh api` returns them as `.number` and `.html_url`). Then return to your original task — don't expand into triaging or fixing what you just filed.

## Conventions

This skill is one of a suite that turns GitHub issues into an agent-operable pipeline; the shared formats and label semantics are documented in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) (the report template here is its own type-blind thing, but the label dimensions and progress/handoff formats live there).

- One observation, one issue. If you noticed two genuinely separate things, file two — don't bundle. (Triage can split bundles, but clean intake saves it the work.)
- The pre-filing re-query (step 3 above) is mandatory, but it's a search, not an oracle: when the results are genuinely ambiguous, file — a duplicate is cheap for triage to close, a lost observation is gone. (Use the `intake-dedup` tool shown in step 3 — it queries via `gh api` REST, never `gh issue list --search`, which goes through GraphQL that this org breaks.)
