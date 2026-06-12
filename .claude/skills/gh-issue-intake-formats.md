# GH Issue Intake — formats contract

The single shared contract the issue-intake skills cite. It defines the five
markdown formats that turn GitHub issues, comments, and sub-issues into an
agent-operable work pipeline:

1. The epic-body **`## Dependencies` grammar** — how an epic encodes its
   workflow topology (sequential phases, parallel groups, gating edges).
2. The **sub-issue body format** — one executable task, mirroring a task entry.
3. The **progress-comment format** — a per-issue work-log entry for the next agent.
4. The **epic handoff-note format** — distilled cross-task context posted to the epic.
5. The **review-code pass marker** — the recognizable first line of a PR comment
   that signals a verified, merge-ready PR for a downstream merge step to scan.

`plan-epic` writes formats 1, 2, and 4. `write-code` reads 1, 2, and 4 and writes
3 and 4. `review-code` reads 2 (the acceptance-criteria checklist is its gate) and
writes 5 on a passing verdict.

## Reading stance: convention, not parser spec

Every reader and writer of these formats is an LLM, not a regex. These grammars
are **conventions that make intent legible**, not a serialization a parser must
round-trip. Read them tolerantly:

- Recognize a section by its heading and shape, not by exact whitespace,
  punctuation, or attribute order.
- If a writer used a synonym, a slightly different bullet style, or added an
  extra field, infer the meaning rather than failing.
- Never reject an issue or block work because a format "didn't parse." If
  something is genuinely ambiguous, resolve it with judgment and note the
  assumption in a progress comment.

Conversely, when **writing**, follow the canonical shape below so the next
reader has the easiest possible job. Tolerant reading is not licence for sloppy
writing — it's the safety margin, not the target.

---

## 1. The `## Dependencies` grammar

An epic body ends with a pinned `## Dependencies` section that encodes the
epic's execution topology over its sub-issues: which children can run in
parallel, and which must wait for others to finish first.

**Topology only.** This section says *what gates what*. It does not carry retry
budgets, concurrency caps, code flags, model selection, or any orchestrator
runtime concern — those belong to whatever loop drives the pipeline, not to the
shared issue state. An epic that names topology and nothing else is correct.

### Vocabulary

- **Phase** — a `### Phase N` heading. Phases run in order: every issue in
  Phase 1 must be closed before any issue in Phase 2 starts. Phases are the
  sequential spine.
- **Parallel group** — the issues listed *within a single phase* have no
  ordering between them. They can be picked and worked concurrently.
- **Gating edge** — an explicit `requires:` annotation on an issue, naming
  other issues that must close before this one is eligible. Use this for a
  dependency that does not fall cleanly on a phase boundary (e.g. a child in a
  later phase that only needs *one* specific earlier child, not the whole prior
  phase).

Blockedness is **derived, never stored**: an issue is unblocked when its phase
predecessors are closed and every issue named in its `requires:` is closed.
There is no `status:blocked` label — `write-code` recomputes eligibility from
this section on every pick.

### Shape

```markdown
## Dependencies

### Phase 1
- #101 — label schema bootstrap
- #102 — formats contract doc

### Phase 2
- #103 — report skill
- #104 — triage skill (requires: #102)

### Phase 3
- #105 — plan-epic skill (requires: #102, #104)
```

References are GitHub issue numbers (`#NNN`); the trailing text after `—` is a
human-legible label, not load-bearing. A bare phase list with no `requires:`
lines is the common case — most topology is just "this phase, then that phase."

### Worked example (parallel group + sequential gate)

A four-child epic where Phase 1 has two children that run **in parallel**, and
Phase 2 has a child that is **sequentially gated** behind a specific Phase-1
child rather than the whole phase:

```markdown
## Dependencies

### Phase 1
- #210 — define the wire schema
- #211 — write the migration script

### Phase 2
- #212 — implement the encoder (requires: #210)
- #213 — end-to-end smoke test
```

Reading this:

- **Parallel group:** `#210` and `#211` are both in Phase 1 with no `requires:`
  between them, so they may be worked simultaneously.
- **Sequential gate:** `#212` carries `requires: #210` — it is eligible only
  once `#210` closes, even though `#211` (its phase-1 sibling) may still be open.
  It does *not* wait on `#211`.
- `#213` is in Phase 2 with no `requires:`, so it waits on **all** of Phase 1
  (the default phase-boundary gate), then runs alongside `#212`.

---

## 2. Sub-issue body format

A sub-issue is one executable task. Its body mirrors a task entry: enough for a
`write-code` agent to pick it up cold and know exactly what "done" means.

### Shape

```markdown
**Stories:** <story refs this task covers, if any>
**TDD:** yes | no

### What to build
<One or two paragraphs. Concrete scope: what changes, where, and why. Name the
modules/files when known. State explicitly what is *out* of scope if there's a
tempting adjacent thing not to do.>

### Acceptance criteria
- [ ] <criterion 1 — observable, checkable without reading the implementer's mind>
- [ ] <criterion 2>
- [ ] <criterion N>
```

### Field notes

- **Stories** — optional back-references to the originating epic's user stories
  or brief. Omit the line if there are none.
- **TDD** — `yes` means the task is test-first (a behavior with a verifiable
  contract); `no` means config, docs, scaffolding, or an operational step where
  test-first doesn't apply. The flag is advice to `write-code`, not a gate.
- **What to build** — the spec. Prose, not a checklist. Acceptance criteria say
  *whether* it's done; this section says *what to do*.

### Invariant: at least one acceptance criterion

**Every sub-issue body MUST contain at least one acceptance criterion.** A task
with zero acceptance criteria is malformed — there is no way for `write-code` to
know when to stop or for `review-code` to verify it. If you cannot state a
single checkable criterion, the task is not yet specified well enough to file;
sharpen it until you can, or fold it into a sibling that is. This is the hard
floor: **≥ 1 acceptance criterion, always.**

The checklist is the contract `review-code` verifies one box at a time before a
PR may merge. Write each criterion so a separate agent with no attachment to the
implementation can confirm or deny it from the outside.

---

## 3. Progress-comment format

While working an issue, an agent logs progress as **comments on that issue**.
Each comment is a self-contained work-log entry: what moved, what was decided,
what bit, and what the next agent needs to know. This is the issue-comment port
of a per-task progress log — optimized for the *next* agent's efficiency, not
for narrative.

### Shape

```markdown
**Completed:** <what got done this session — behaviors, files, the commit/PR if any>

**Decisions:** <choices made and why — the ones a reviewer or successor would
otherwise have to reverse-engineer>

**Gotchas:** <traps hit, surprising constraints, things that look wrong but aren't>

**Next:** <what the next agent should do, or what's still open>
```

### Field notes

- Keep it scannable. Bullets over paragraphs. Every line should help the next
  invocation make a faster, better decision.
- Omit a heading if it has nothing under it — an entry that's purely "Completed"
  and "Next" is fine. Don't pad with filler.
- Record decisions at the point of making them, not retroactively. A decision
  buried in a diff is a decision the next agent will re-litigate.
- This is the per-issue ledger. Cross-task context that the *epic* needs goes in
  a handoff note (format 4), not here.

---

## 4. Epic handoff-note format

When an agent **finishes a sub-issue**, it posts a distilled handoff note as a
comment **on the parent epic**. Where the progress comments (format 3) are the
fine-grained ledger on the child issue, the handoff note is the coarse,
cross-task signal the epic needs: what this child produced that *other children
depend on or should know about*. The epic's comment stream becomes the
agent-to-agent relay for the whole workflow.

### Shape

```markdown
### Handoff: #NNN — <child title>

**Done:** <one-line outcome — what now exists/works that didn't before>

**Affects siblings:** <what downstream/parallel children should now assume —
new modules, changed contracts, conventions established, decisions recorded>

**Watch out:** <anything a sibling could trip on — a shared file touched, an
assumption invalidated, a partial state left behind>
```

### Field notes

- Distill, don't dump. The full detail lives in the child issue's progress
  comments and its PR; the handoff note is the *summary a sibling reads instead
  of spelunking the child*.
- "Affects siblings" is the load-bearing field. If finishing this child changed
  what a later phase should do, say so here — that's exactly the context the
  `## Dependencies` graph routes work along.
- If a child completed in pure isolation with zero sibling impact, a one-line
  "Done" handoff is honest and complete. Don't manufacture cross-task context
  that isn't there.

---

## 5. review-code pass marker

When `review-code` verifies every acceptance criterion and a native approving
review can't be posted (e.g. org branch rules forbid reviewing your own PR), it
falls back to a **pass comment whose first line is a recognizable marker**. That
marker is a downstream contract: an authorized merge step scans PR comments for
it to find verified, merge-ready PRs unambiguously.

### Shape

The recognizable **first line** of the PR comment is exactly:

```markdown
review-code: PASS — merge-ready
```

The rest of the comment body carries the per-criterion evidence table (the
verdict). What's load-bearing for the scanner is only that first marker line; the
table below it is for the human and the implementer.

### Field notes

- **First line, recognizable.** The marker leads the comment so a scan can match
  it without parsing the whole body. Recognize it tolerantly by shape
  (`review-code: PASS` … `merge-ready`), not by exact dashes or spacing.
- **Pass only.** This marker means *every criterion verified, PR merge-ready*. A
  fail verdict carries no such marker — there is nothing for the merge step to
  find, which is the point.
- **Signals, never merges.** The marker is an approval signal a separate
  authorized step acts on. `review-code` writing it does **not** merge; merging
  is a deliberate downstream act (see review-code/SKILL.md §"Authority limit").
- The native approving review (`event=APPROVE`) is the preferred signal when it's
  available; this marker is the comment-based fallback that carries the same
  meaning where a formal review can't be posted.

---

## Relationship between the formats

| Format | Lives on | Written by | Read by |
|---|---|---|---|
| `## Dependencies` grammar | epic body | plan-epic | write-code |
| Sub-issue body | each sub-issue | plan-epic | write-code, review-code |
| Progress comment | the worked issue | write-code | write-code (successor) |
| Epic handoff note | parent epic | write-code | write-code (siblings) |
| review-code pass marker | the PR | review-code | authorized merge step |

The sub-issue's acceptance-criteria checklist (format 2) is the spine of
verification: `review-code` checks every box before merge, and the
≥ 1-criterion invariant guarantees there is always something to check.
