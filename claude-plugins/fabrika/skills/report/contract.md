# `/report` — derived CLI contract

**Skill:** [`report`](SKILL.md) · **Authoring brief:** [#4705](https://github.com/kamp-us/phoenix/issues/4705) · **Date:** 2026-08-01

These verbs live in `packages/fabrika-cli/`, binary `fabrika-cli`, grouped under a `report`
subcommand — the package the [`/adr` contract](../adr/contract.md) mints and
[#4725](https://github.com/kamp-us/phoenix/issues/4725) builds. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs all three; where this
spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika-cli` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). Every verb
below is implemented from scratch here. v1's tools were read for their semantics and their scars —
each Grounding section names what the corresponding v1 tool gets wrong and what this spec does
instead — but no clause defers to one, and none is invoked.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `report dedup` | rank the open issues that may already cover an observation | two REST reads, tokenize, score, sort — deciding whether a candidate *is* your observation stays in the skill |
| `report file` | compose, guard and create the intake issue, then read back what landed | the template, the footer, the leak predicate, the label and the read-back are all mechanical; what goes in the sections is judgment |
| `report note` | add a note to an existing issue over the same guarded path | as above, minus composition — the guard and the read-back are the deterministic part |

**Considered and deliberately not derived.** Each is a real proposal someone could make again, so it
is recorded rather than left to be re-litigated:

- **A `report compose` preview verb**, emitting the composed body without filing. It would put the
  composed body in the caller's hands — which means a shell variable or a file, and a file is the
  surface every leak in this skill's incident record occurred on. `report file` composes in-process,
  so the composed body exists only inside the process that posts it.
- **A label-vocabulary preflight verb.** Its answer is needed in exactly one place, inside
  `report file`, so it is a precondition rather than a verb; minting it would be a wrapper whose
  only behaviour is relaying an upstream answer, which ADR 0238 bans.
- **A standalone redactor verb.** Same test: a transform with one caller is that caller's
  precondition. It is the `--redact` flag on the two writing verbs.

**Nothing here recomputes a merge-gated answer.** The repo's committed-file leak gate decides
whether a *file in a diff* carries a machine-local path, at the merge gate, and that gate is the
authority on that question. An issue or comment body posted at runtime is never in a diff, so no
gate covers it — the predicate below is the ungated surface, not a second verdict on a gated one.

## Shared conventions

Every verb below obeys these; they are stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else. Scope lines, refusal
  reasons and progress go to stderr.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote's `owner/name`) is the target repository; with none
  resolvable the verb exits 1 rather than guessing. `--json` swaps the line grammar for one JSON
  object with the named keys given per verb.
- **Reserved exit codes.** `0` = the answer is on stdout. `1` = usage error, or the verb failed to
  run. `127` = the verb never ran. `3` and up are each verb's own proven outcomes.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit;
  a caller reads the status before the bytes.
- **GitHub reads and writes go through `gh api` REST, never GraphQL** — the org's Projects-classic
  integration breaks GraphQL issue queries — and every list read pages.

### The body is a value, never a path

The two writing verbs take the body **on stdin only**. There is deliberately **no `--body` flag, no
`--body-file`, and no temp file**: a flag that accepts a path turns the body into a string the verb
could post verbatim, which is precisely how the incidents below happened. A shell redirect
(`< some-file`) is fine and expected — the *shell* reads the file, so what reaches the verb is
already the bytes, and no path ever exists inside the process.

**An empty stdin is a refusal, not an empty body.** A pipe that failed to read is byte-identical to
one that was genuinely empty unless the reader distinguishes them, so the read here does: a
transient read failure is exit `1` (the verb could not run), an empty-but-successfully-read stdin is
exit `3` (a proven refusal). The read must also terminate rather than hang when the verb is invoked
on a terminal with nothing piped in.

### The body-surface leak predicate

Shared by `report file` and `report note`. A machine-local path in a body posted to a public issue
is a leak. Four generic shapes, and **no name list** — every shape is structural, so a new operator,
a renamed tool directory or a different machine needs no edit:

1. **Home-relative** — a path beginning with the home marker `~` followed by a separator. An issue
   body has no legitimate use for one: the `## Pointers` section is repo-relative by contract. Two
   carve-outs, both pinned to a shape rather than a membership list — the claude CLI's public,
   machine-agnostic config leaves `~/.claude.json` and `~/.claude/settings.json`, which are
   byte-identical on every machine and name nothing operator-specific. Because each carve-out pins
   the exact leaf, a deeper descent or a longer name still matches.
2. **Absolute home root** — an absolute path under an OS home root: `/Users/<account>` on macOS,
   `/home/<account>` on Linux.
3. **Temp and scratch roots** — `/tmp/…`, `/private/tmp/…`, `/private/var/…`, `/var/folders/…`. No
   carve-out: a public issue body has no legitimate bare temp path.
4. **A body that *is* a path** — the body's first non-whitespace run is an `@`-prefixed path
   (`@/…`). This is the composed body having never arrived at all, so it carries its own message and
   is **not** redactable: the fix is to send the body, not to mask the placeholder.

Shapes 1–3 are redactable. `--redact` masks each match down to its class marker and keeps the
evidential shape — a temp-root hit becomes `/tmp/<redacted>`, a home-relative hit `~/<redacted>` —
so the body still reads as evidence that a path of that kind was there. Every redaction is reported
on stderr with its line number; the verb never rewrites a body silently.

---

## `report dedup`

**Invocation**

```
fabrika-cli report dedup --query "retry helper swallows the abort reason" [--label <name>] [--limit <n>] [--exclude <n>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--query` | string | yes | — | the observation text — the title plus a few distinguishing keywords — to check for an already-open issue |
| `--label` | string | no | `status:needs-triage` | the intake-queue label whose open issues form the read-after-write half of the check |
| `--limit` | integer | no | `20` | the maximum number of candidates to print |
| `--exclude` | integer | no | none | an issue number to omit from the results — the issue being deduped, so it never flags itself |
| `--repo` | string | no | resolved (see Shared conventions) | the repository to search |
| `--json` | boolean | no | `false` | emit the full result object instead of the line grammar |

**Output** — the first line is the outcome token alone: `candidates`, `none`, or `indeterminate`.
On `candidates`, one **tab-separated** line per entry follows — `<number>`, `<source>`, `<score>`,
`<title>` — ranked by score descending, then by number descending, capped at `--limit`. `<source>`
is `queue`, `search`, or `both`; `both` is the strongest duplicate signal.

**All three outcomes are answers, and all three exit 0.** `none` is a proven negative — both sources
were read and neither matched — and it is a printed token rather than empty stdout, because empty
stdout is byte-identical to a verb that never ran. `indeterminate` is the degenerate case:
`--query` yielded no usable keywords, so nothing was compared. It is **not** a clean check, and the
skill is required to treat it as one that did not happen.

With `--json`, one object with keys `outcome` (the token), `candidates` (array of
`{number, source, score, title}`, empty unless `outcome` is `candidates`), `reason` (the
explanatory string for `none` and `indeterminate`, else `null`), `tokens` (the keywords actually
used), `queueCount` and `searchCount`.

**Matching.** `--query` is lowercased and split on any run of non-letter, non-number characters over
the **full Unicode letter class**, not ASCII — Turkish is a product-copy language in this repo, and
an ASCII-only split shreds a Turkish stem into sub-threshold fragments and drops it entirely.
Tokens shorter than 3 characters and stopwords in **both** repo languages are dropped; the
remainder is deduped in first-seen order and capped at 12, because GitHub's search AND-joins its
terms and an over-long query matches nothing. A query token matches a title token on an exact hit or
a shared prefix of at least 5 characters, which is what lets an agglutinative Turkish inflection
match a bare stem without a morphological analyzer while staying off short English derivational
overlaps. A queue row is kept only when its title overlaps (score > 0); a search row already matched
server-side on title *or* body, so it is kept regardless.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | an outcome token was produced on stdout |
| `1` | usage error, the target repo could not be resolved, or the verb failed to run |
| `3` | the intake queue could not be read, so the outcome is UNKNOWN |
| `4` | the search index could not be read, so the outcome is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `report dedup: cannot read the <label> queue in <repo>: <reason> — the outcome is UNKNOWN, never "none".` | 3 | refusal |
| `report dedup: cannot read the search index for <repo>: <reason> — the outcome is UNKNOWN, never "none".` | 4 | refusal |
| `report dedup: --query is empty.` | 1 | usage error |
| `report dedup: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.` | 1 | refusal |

**Scope** — this verb **supplies an input; it does not judge**, so an empty result is a fact rather
than a failed read, and it says so here once. The two halves are read for different reasons: the
label queue is read-after-write consistent and catches an issue filed seconds ago, while the search
index is eventually consistent — it lags fresh issues but reaches older open issues that have
already left the queue. An empty intake queue is a normal state, so `none` at exit 0 is an answer;
a queue or index that could not be read is exit 3 or 4 with **nothing** on stdout. The scope line
goes to stderr on every run, naming both source counts and the tokens actually used, so a caller can
see which half produced the answer and whether the query degenerated.

**Examples**

```
$ fabrika-cli report dedup --query "retry helper swallows the abort reason in the http worker"
candidates
4312	both	4	Abort reason lost when the worker retry helper re-wraps the request
4088	search	2	http worker retries do not propagate cancellation
```

```
$ fabrika-cli report dedup --query "sozluk definition editor loses focus after an entry is saved"
none
```

```
$ fabrika-cli report dedup --query "it is not working"
indeterminate
$ echo $?
0
```

```
$ fabrika-cli report dedup --query "retry helper abort reason" --repo kamp-us/nonexistent
report dedup: cannot read the status:needs-triage queue in kamp-us/nonexistent: HTTP 404 — the outcome is UNKNOWN, never "none".
$ echo $?
3
```

**Grounding**

- ADR 0181 — this check is **advisory, not an oracle**. It never gates a filing, which is why every
  outcome exits 0: a duplicate is cheap for triage to close, and a lost observation is gone. The
  skill files on ambiguity.
- v1's `intake-dedup check` prints one line per candidate and nothing else, so **its stdout is empty
  when it finds no duplicate** — indistinguishable from a verb that never ran — and the count that
  would disambiguate goes to stderr. Read it as the reason the outcome token exists here.
- v1 also exits 0 with empty stdout when the query tokenizes to nothing, writing
  `no usable keywords — nothing to check` to stderr. A degenerate non-check then reads to a caller
  exactly like a clean one. `indeterminate` is that case promoted to an answer.
- #3255 — an ASCII-only tokenizer shredded a Turkish stem into sub-threshold fragments and dropped
  it, so the search half silently ran on fewer keywords than the caller supplied. The Unicode split,
  the two-language stoplist and the stem-prefix relaxation are all that incident.
- #4208 / #4219 — a proven outcome never shares an exit code with a failure to invoke, which is why
  an unreadable source is 3 or 4 and never a printed `none`.

---

## `report file`

Composes the intake issue from the sections on stdin, guards it, creates it, and reads back what
landed. One transaction: every step below is a precondition or a postcondition of *this observation
is now an issue in the intake queue*, and splitting them would hand a caller the chance to skip one.

**Invocation**

```
fabrika-cli report file --title "Retry helper in the http worker swallows the abort reason" [--redact] [--label <name>] [--repo <owner/name>] [--json]
```

The six authored sections arrive on **stdin** as markdown.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--title` | string | yes | — | the issue title: a short, specific, type-neutral summary of the observation |
| `--redact` | boolean | no | `false` | mask each machine-local path in the body down to its class marker and file the masked body, instead of refusing |
| `--label` | string | no | `status:needs-triage` | the single intake-queue label the new issue carries |
| `--repo` | string | no | resolved (see Shared conventions) | the repository to file into |
| `--json` | boolean | no | `false` | emit the full filing record instead of the line grammar |
| stdin | markdown | yes | — | the six authored sections, in order |

**The body template is this verb's, and this block is its single home** — the skill names the six
sections and supplies their content; their exact spelling and order live here, so there is no second
copy to drift against:

```markdown
## Summary
## What I was doing
## What I observed
## Why it matters
## Pointers
## Suggested next step (non-binding)
```

All six must be present, in this order, each with non-empty content — except
`## Suggested next step (non-binding)`, which may be empty, because a blank guess is better than a
misleading one and the skill says so. A missing or misspelled heading is exit 4 naming the one that
is wrong.

**The footer is appended by this verb**, after the sections and a blank line:

```markdown
---
<sub>Filed by an agent · session `<id>` · model `<name>` · branch `<ref>` · <ISO-8601 UTC></sub>
```

Every field after the marker is best-effort and is **omitted silently** when the environment does
not expose it — no `unknown`, no dangling label. The literal `Filed by an agent` marker is always
present, because it is the signal a later triage run reads to decide whether an issue may be
auto-closed, and a sparse footer is still a present footer.

**Footer privacy is this verb's precondition, not the caller's.** It carries machine and session
context only: no email address, no author name, no filesystem path. It does not read git
`user.email` or `user.name`. A branch name is a ref rather than a path, and is the only
repo-shaped field.

**Output** — one **tab-separated** line: `<number>`, `<url>`. The number is bare, with no `#` sigil
and no prose prefix, so `cut -f1` yields something a caller can interpolate without stripping
anything. With `--json`, one object with keys `number`, `url`, `label`, `redactions` (array of
`{line, class}`, empty when none) and `bodyBytes`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the issue was created, read back clean, and its number and URL are on stdout |
| `1` | usage error (an empty `--title`), an unresolvable repo, a failed stdin read, or the verb failed to run |
| `3` | stdin was read and held nothing — refusing to file a bodyless issue |
| `4` | a required section is missing, out of order, or empty |
| `5` | the body carries a machine-local path and `--redact` was not given |
| `6` | `--label` does not exist in `--repo` — the issue would be filed outside the intake queue |
| `7` | the issue was created but the read-back does not match — a partial landing, not a success |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `report file: stdin was read and held 0 bytes — refusing to file a bodyless issue.` | 3 | refusal |
| `report file: could not read stdin: <reason> — the body is UNKNOWN, never empty.` | 1 | refusal |
| `report file: section "<heading>" is missing.` | 4 | refusal |
| `report file: section "<heading>" is empty.` | 4 | refusal |
| `report file: sections are out of order — "<heading>" follows "<heading>".` | 4 | refusal |
| `report file: the body carries <n> machine-local path(s) — refusing to post them to a public issue.` (then one indented `line <n>, <class>` per hit) | 5 | refusal |
| `report file: the body is a bare "@" path reference — the composed body never arrived. Send it on stdin; --redact does not apply.` | 5 | refusal |
| `report file: <repo> has no "<label>" label — the issue would be filed outside the intake queue. Create the label, then re-run.` | 6 | refusal |
| `report file: created #<n> but the read-back is wrong: <what differs>. The issue exists and needs fixing by hand.` | 7 | refusal |
| `report file: --title is empty — refusing to file an untitled report.` | 1 | usage error |

**Scope** — a judging verb on two questions, both fail-closed: *does this body carry a
machine-local path*, and *does the intake label exist in the target repo*. The leak scan's scope is
the whole composed body including the footer, scanned after composition so nothing the verb itself
appends can escape it. The label check's scope is the target repo's label set, read fresh. Zero
scope is unreachable rather than tolerated: an empty stdin is exit 3 before either check runs, so
neither can ever report clean over nothing. The scope line on stderr names the byte count read, the
sections seen, and the label checked.

**The read-back is what makes exit 7 possible, and it is not optional.** After the create, the verb
re-reads the issue and asserts three things: it exists, it carries `--label` and only that label,
and its body is byte-identical to what was composed. A create call's own response is the server
echoing the request; a fresh read is the only evidence the issue is in the queue. On a mismatch the
verb exits 7 with the number, so the partial landing is visible instead of reported as success.

**Examples**

```
$ fabrika-cli report file --title "Retry helper in the http worker swallows the abort reason" <<'EOF'
## Summary
The retry helper drops the abort reason when it re-wraps a failed request, so a cancelled call
surfaces downstream as a generic timeout.

## What I was doing
Tracing a flaky integration test in the web worker's http layer.

## What I observed
`withRetry` constructs a fresh AbortError and discards `cause`.

## Why it matters
Every cancellation reads as a timeout, so the retry budget is spent on calls the caller already
abandoned. Might also be why the flake only shows under load.

## Pointers
apps/web/worker/http/retry.ts

## Suggested next step (non-binding)
Maybe thread `cause` through the re-wrap.
EOF
4732	https://github.com/kamp-us/phoenix/issues/4732
```

```
$ printf '' | fabrika-cli report file --title "Retry helper swallows the abort reason"
report file: stdin was read and held 0 bytes — refusing to file a bodyless issue.
$ echo $?
3
```

```
$ fabrika-cli report file --title "PR body shipped a literal body-file reference" < incident.md
report file: the body carries 1 machine-local path(s) — refusing to post them to a public issue.
  line 12, temp root
$ echo $?
5
```

```
$ fabrika-cli report file --title "PR body shipped a literal body-file reference" --redact < incident.md
report file: redacted 1 machine-local path — line 12, temp root
4733	https://github.com/kamp-us/phoenix/issues/4733
```

```
$ fabrika-cli report file --title "Retry helper swallows the abort reason" --repo kamp-us/fresh-adopter < body.md
report file: kamp-us/fresh-adopter has no "status:needs-triage" label — the issue would be filed outside the intake queue. Create the label, then re-run.
$ echo $?
6
```

**Grounding**

- **#3086** — a PR body shipped a literal, unexpanded body-file reference: the machine-local path
  landed in a public artifact and the description was empty, so the leak and the missing body were
  one mistake. Shape 4 of the predicate is that exact byte pattern, refused as its own case because
  its fix is to send the body rather than to mask a placeholder.
- **#3173** — a raw file-referencing post produced the same literal path *and* a self-reported PASS
  over a body that never landed. Both halves are answered here: the predicate refuses the body, and
  the read-back refuses the false success. v1 already has this read-back discipline and applies it
  to verdict posts, while its intake create decodes the create call's own response and never
  re-reads the issue — so a create that lands without its label reports success. That asymmetry is
  the scar; exit 7 is it designed out.
- **#3945** — a blocked posting command was retried through the file-referencing form the contract
  forbids, so a permission refusal funnelled an agent into the leak-prone shape. The verb's half of
  the fix is that its refusals name one correctable thing each; the skill carries the other half,
  because no verb can stop a caller from abandoning it.
- **#3924** — a stdin read that swallows a transient failure to empty makes an unread pipe
  byte-identical to an empty one, and twelve v1 tools decide over no evidence on exactly that. Exit
  3 is the empty-but-read case and exit 1 the failed read; they are never the same answer.
- **#2002** — the body never becomes a named path, so two concurrent runs have no shared file to
  interleave and no variable to reuse stale. The hazard has no surface rather than a warning against
  it, which is why there is no `--body-file` flag to add later.
- **ADR 0159** — the `Filed by an agent` marker is the never-auto-close signal. GitHub authorship
  cannot serve it: every pipeline-filed issue goes through one shared login, so authorship reads the
  same for a hand-typed issue and an agent-filed one.
- **v1's report skill never checks that the queue label exists.** Its `vocabulary-preflight` tool is
  consumed by `doctor`, `homing-guard` and `pitch-guard` and by nothing on the filing path, so a
  repo missing the label files an issue that silently never enters the queue. Exit 6 folds that
  check into the one place it is needed.
- **v1's `tracker create-issue` prints `tracker: created #<n> — <url>`** — prose on a machine
  channel — so callers regex the number back out of it and mangle the reference. The line here is
  tab-separated with a bare number for that reason.

---

## `report note`

Adds a note to an existing issue over the same guarded path. **This verb exists because the skill
tells its caller to comment on a duplicate rather than file a twin** — and a skill that says that
without providing a guarded path sends the caller to a hand-rolled posting call, which is the exact
call #3945 and #3173 each made. Both of those incidents were comment posts, not issue creates.

**Invocation**

```
fabrika-cli report note --issue 4705 [--redact] [--repo <owner/name>] [--json]
```

The note arrives on **stdin** as markdown.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue number to add the note to |
| `--redact` | boolean | no | `false` | mask each machine-local path in the note down to its class marker and post the masked note, instead of refusing |
| `--repo` | string | no | resolved (see Shared conventions) | the repository the issue lives in |
| `--json` | boolean | no | `false` | emit the full note record instead of the line grammar |
| stdin | markdown | yes | — | the note body |

**No section template applies.** A note is free prose — what the existing issue lacks — so this verb
validates nothing about its structure and appends no footer. Stated explicitly because the sibling
verb does both, and an implementer would otherwise have to guess whether the six sections bind here.

**Output** — one **tab-separated** line: `<comment-id>`, `<url>`. With `--json`, one object with
keys `id`, `url`, `issue`, `redactions` and `bodyBytes`.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the note was posted, read back clean, and its id and URL are on stdout |
| `1` | usage error, an unresolvable repo, a failed stdin read, or the verb failed to run |
| `3` | stdin was read and held nothing — refusing to post an empty note |
| `4` | the note carries a machine-local path and `--redact` was not given |
| `5` | `--issue` names no issue in `--repo` |
| `6` | the note was posted but the read-back does not match — a partial landing, not a success |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `report note: stdin was read and held 0 bytes — refusing to post an empty note.` | 3 | refusal |
| `report note: could not read stdin: <reason> — the note is UNKNOWN, never empty.` | 1 | refusal |
| `report note: the note carries <n> machine-local path(s) — refusing to post them to a public issue.` (then one indented `line <n>, <class>` per hit) | 4 | refusal |
| `report note: the note is a bare "@" path reference — the composed note never arrived. Send it on stdin; --redact does not apply.` | 4 | refusal |
| `report note: <repo> has no issue #<n>.` | 5 | refusal |
| `report note: posted comment <id> on #<n> but the read-back is wrong: <what differs>. The comment exists and needs fixing by hand.` | 6 | refusal |

A **closed** issue is not a refusal — a note on a closed issue is sometimes exactly right — but the
verb says so on stderr (`report note: #<n> is closed.`) so the caller is never surprised by where
the note landed.

**Scope** — a judging verb on one question, fail-closed: *does this note carry a machine-local
path*. Its scope is the whole note as read from stdin. Zero scope is unreachable: an empty stdin is
exit 3 before the scan runs, so the guard can never report clean over nothing. The scope line on
stderr names the byte count read and the target issue.

**The read-back applies here too.** After posting, the verb re-fetches the comment and asserts its
body is byte-identical to what was sent. #3173 is precisely a posted comment whose landed body was
not what the poster believed it had sent, reported upward as a success — so a post that is not
verified is not finished.

**Examples**

```
$ fabrika-cli report note --issue 4312 <<'EOF'
Also reproduces on the streaming path, not just the buffered one — same discarded `cause`.
EOF
5154891644	https://github.com/kamp-us/phoenix/issues/4312#issuecomment-5154891644
```

```
$ printf '' | fabrika-cli report note --issue 4312
report note: stdin was read and held 0 bytes — refusing to post an empty note.
$ echo $?
3
```

```
$ fabrika-cli report note --issue 99999 <<'EOF'
…
EOF
report note: kamp-us/phoenix has no issue #99999.
$ echo $?
5
```

**Grounding**

- **#3945 and #3173 were both comment posts.** A guarded issue-create path with an unguarded
  comment path leaves the seam where both incidents actually happened wide open, which is this
  verb's whole reason to exist.
- **#3173's read-back half** applies identically to a note: a landed body that is not what was sent,
  reported as a success, is the failure mode. Exit 6 is that made mechanical.
- **#3924** — the same stdin distinction as `report file`: a failed read and an empty pipe are
  different answers with different exit codes.
- v1's `tracker create-comment` prints `tracker: commented on #<n> (ref <id>).` — prose on a machine
  channel, the same scar as its create sibling, and the reason this line is tab-separated with a
  bare id.
