# `/write-pattern` — derived CLI contract

**Skill:** [`write-pattern`](SKILL.md) · **Authoring brief:** [#4710](https://github.com/kamp-us/phoenix/issues/4710) · **Date:** 2026-08-10

The verbs sit under a `pattern` subcommand group in `packages/fabrika-cli/`, whose binary is
`fabrika`. The group name was verified free against
[`registry.ts`](../../../../packages/fabrika-cli/src/registry.ts) at authoring time — at the time of
writing the registered groups are `adr build epic eval hook ledger plan report review review-ui ship
spend status triage ui wire`, though that list grows most weeks, so read the file rather than this
sentence. The [CLI interface convention](../../docs/cli-interface-convention.md) governs all five;
where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** Every verb below is
implemented in `packages/fabrika-cli/`, and no fence in `SKILL.md` invokes anything else
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). v1's `canon`
skill and the four tools its brief names were read for their semantics and their scars — several are
designed out below — and none is called. The reason is the deletion test: a fabrika that calls v1 can
never be the thing that replaces it.

## Three questions deliberately not derived

Each is already answered by something with more authority. Computing a second answer to a
merge-gating question is strictly worse than computing none, which is the test that dropped the
pilot's `adr classify`.

**Markdown link resolution — the `doc-links` job owns it.** It walks every git-tracked `*.md`
repo-wide through `lychee --offline`, fails closed on zero scope (ADR 0092), and runs on both
`pull_request` and `push: main` so a break is charged to the commit that caused it
([`.github/workflows/doc-links.yml`](../../../../.github/workflows/doc-links.yml)). A pattern doc is
inside that scope already.

**Machine-local path leakage — the leak gate owns it.** `.patterns/` is a shared-artifact doc
surface to it (`DOC_DIRS` in
[`leak-guard.ts`](../../../../packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts)), so a
leaked path in a pattern doc already reds a merge. The skill states the expectation and computes no
second verdict. It deliberately does **not** direct `fabrika build check --surface prose`, whose
`prose` validators are these same two scans: that verb requires a session, a repository token and a
held lane claim (`requireSession` and `resolveTargetRepo` in its module), none of which a bare
authoring run has — and reaching for it would put another group's exit codes inside this skill's
terminal vocabulary, where `15` means something else entirely.

**Backticked bare repo-path resolution — declined, and this is the sharpest of the three.**
`pipeline-cli pointer-guard` solves precisely this problem and **deliberately excludes
`.patterns/**`**. Its own source states why, and the reason has not changed:

> `.patterns/**` is excluded too: besides the same drift it would surface, its prose cites
> *external* dependency source trees (`packages/effect/src/Effect.ts`, `packages/fate/src/server/live.ts`)
> that are not in-repo paths and are indistinguishable from a deleted in-repo package by resolution
> alone — an irreducible false-positive source.

A `pattern`-side copy would inherit that false-positive rate over the exact corpus it targets. So no
verb here judges whether a cited path resolves. `pattern drift` **uses** resolution, but only to
decide what it may follow, and an unresolved token is reported in its own count and never treated as
a finding — the avoidance inherited rather than the defect repeated.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `pattern corpus` | the library at a base ref: every doc, its index registration, its section, its last-touching commit | scan a tree, parse table rows, read git log — deciding whether a *missing* doc should exist is the skill's |
| `pattern drift` | whether the in-repo source a doc cites moved since the doc was last written | extract tokens, resolve, diff a commit range — judging whether a move *invalidates* the prose is the skill's |
| `pattern anchor` | whether the dependency version a doc declares still matches what the workspace pins | parse a fixed line, look up a map key, compare two strings — deciding what to rewrite is the skill's |
| `pattern new` | scaffold `.patterns/<slug>.md` from the canonical template | fixed text with substitutions; only the content is judgment |
| `pattern register` | insert the doc's row into `.patterns/index.md` under a named section | *which* section is judgment supplied as an argument; the fenced row edit and its read-back are mechanical |

**Considered and not derived.**

- **A heading-grammar check over a pattern doc.** The corpus has no shared skeleton — 83 docs, no
  frontmatter, headings that vary by layer — so a grammar check would encode this repo's habits as
  law and fail in the foreign repos fabrika ships into. `pattern new`'s template is a *starting
  shape*, not a validated one, which is why exit `4` is a deliberate gap below.
- **A stale-marker scan** (v1's `verify-pattern-doc.sh` check 3 flagged `as of`, `currently`, `at the
  time`). Honest prose uses those words constantly and the check ships no allowance, so it is noise
  with a verdict attached. Whether a hedge is stale is a judgment about the sentence, and it stays in
  the skill.
- **A generated-region rewrite of `.patterns/index.md`**, on the `wire/index-doc.ts` model. That file
  is hand-curated, carries per-row commentary, and is edited by lanes this verb cannot see;
  regenerating it would destroy work. `register` inserts one fenced row instead.

## Shared conventions

Every verb below obeys these; they are stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else. Scope lines, refusal
  reasons and progress go to stderr. Every multi-record stdout line opens with a **record-type
  field**, so a caller never has to infer a line's kind from its position.
- **The outcome token is the first field after the record type, and every outcome exits `0`.**
  `corpus`, `drift` and `anchor` lead each line with a record-type field, so their outcome token is
  the second field of the first line; `register` emits one line and leads with its outcome. `corpus`,
  `drift` and `anchor` each answer with one token from a closed set. A caller must never read its own
  informative answer as a failed run — which is exactly the mistake v1's `adr-sweep` makes by exiting
  `1` on the one case it was asked to produce (#4723).
- **Two different reads, deliberately.** `corpus`, `drift` and `anchor` read the corpus **at a
  resolved `--base`**, because the question they answer is what this repository already holds.
  `new` and `register` write the **working tree**. A doc created by `new` is therefore invisible to
  `corpus` until it is committed; that is correct and is why `register` never consults `corpus`.
- **Common inputs.** `--dir <path>` (default `.patterns`) is the doc directory. `--base <ref>`
  (default `origin/main`) is the base ref, **fetched before it is read**. `--json` swaps the line
  grammar for one JSON object with the named keys given per verb, on **stdout**.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit.
  This is not merely a convention here: the shipped `refuse()` helper hardcodes an empty stdout and
  `answer()` hardcodes exit `0`, so **a non-zero exit carrying a machine payload on stdout is not
  constructible** through the sanctioned constructors. Every verb below is designed inside that
  constraint rather than against it.
- **No verb here reads stdin or touches GitHub, and the group needs no token.** The one network
  call any of them makes is the `--base` fetch above; `new` and `register` make none at all. An
  offline checkout therefore cannot answer `corpus`, `drift` or `anchor` — they exit `11`, UNKNOWN,
  which is the correct answer rather than a stale one read off the working tree.
- **Separator.** Multi-field lines are tab-separated.
- **Fixture examples reproduce against a base ref that carries the fixtures.** The examples below
  name fixtures committed in this skill's tree, and the read-at-`--base` rule applies to them like
  anything else: run against an older base, `pattern drift` answers `unborn` and `pattern anchor`
  exits `12`. That is the verbs working, not the examples rotting — and it is the same property that
  makes the answers trustworthy in the first place.

### The shared exit matrix

This table owns `code → meaning` for the group. Per-verb tables below enumerate only that verb's own
proven outcomes and the trigger that produces each; **the universal codes `0`, `1`, `2` and `127` are
stated here exactly once and every verb can also return them.** One fact, one home — a shared matrix
restated per verb is a shared matrix that can drift from itself.

| Code | Constant | Meaning |
|---|---|---|
| `0` | — | the answer was produced on stdout |
| `1` | — | usage error, or the verb failed to run |
| `2` | — | no implementation could be resolved — the binary was found, the verbs were not |
| `127` | — | the verb never ran at all (unresolved binary) |
| `8` | `WRITE_UNKNOWN` | the write itself failed, so the outcome is UNKNOWN — deliberately not `1` |
| `9` | `READBACK_MISMATCH` | the write landed and the read-back does not match; the artifact exists and needs a human |
| `10` | `OFF_VOCABULARY` | a value is outside a closed set this group validates against |
| `11` | `PRECONDITION_UNKNOWN` | a precondition read failed, so nothing was written and no outcome is proven |
| `12` | `DOC_ABSENT` | proven: the named slug has no doc file |
| `13` | `ALREADY_EXISTS` | proven: the target path already exists — refused, never overwritten |
| `14` | `MULTI_LINE_DIFF` | the edit would have changed a line beyond the one row — aborted before writing |
| `15` | `INDEX_UNPARSEABLE` | proven: the index is absent, or holds no parseable table |
| `16` | `SECTION_AMBIGUOUS` | proven: the named section matches more than one heading — the index needs disambiguating, not the flag |

**The seats map to register.** `pattern` declares exactly these four shared seats, and this is the
map the alignment registry needs — an implementer should not have to infer it:
`{WRITE_UNKNOWN: 8, READBACK_MISMATCH: 9, OFF_VOCABULARY: 10, PRECONDITION_UNKNOWN: 11}`. The
constants are imported from `build/codes.ts` rather than from `report/codes.ts` directly because
`build` re-exports the base's values unchanged and already carries `OFF_VOCABULARY`, which `report`
seats as `CLASSIFIED`; the value is the base's either way, so the alignment holds.

**Alignment.** `pattern` aligns to the `report` base, importing `WRITE_UNKNOWN`,
`READBACK_MISMATCH`, `OFF_VOCABULARY` and `PRECONDITION_UNKNOWN` from `build/codes.ts` rather than
restating numerals, so a drift is unrepresentable rather than merely detectable. The alignment buys
something real, though not what an earlier draft claimed: this skill does **not** drive
`fabrika build check`. What it shares with `build` is the failure *vocabulary* — a failed write, a
mismatched read-back, an off-vocabulary value, a precondition that could not be read — and those
four facts mean the same thing wherever they are proven. A conductor sweeping a doc lane across both
groups reads one meaning per code, and a code that meant two things across a sweep is the defect the
courtesy exists to prevent. The rule the
group follows is `ledger`'s: **import a code when two groups prove the same fact; allocate freely
when they do not.** Registering a `pattern/codes.ts` obliges a matching row in the exit-code
alignment registry and its module map — a group listed nowhere is drift, and the alignment test reds
until both rows exist.

**Deliberate gaps, each with its reason** — a gap that carries information rather than reading as an
oversight:

| Code | Why this group does not seat it |
|---|---|
| `3` `EMPTY_STDIN` | no verb here reads stdin |
| `4` `BAD_SECTIONS` | no verb here validates a document's heading grammar — see *Considered and not derived* |
| `5` `LEAKED_PATH` | the leak gate is the authority over `.patterns/`; this group computes no second verdict |
| `6` `BARE_AT_PATH` | follows from `3` — nothing here composes a body from authored input |
| `7` `ZERO_SCOPE` | **the important one.** No verb here judges over a corpus, so none has a vacuous pass to prevent. An empty or absent `.patterns/` is a *fact* this group reports at exit `0`, and refusing there would leave a repo adopting fabrika unable to write its first pattern doc on the documented path — the first-run dead-end the portability rules forbid, and the same correction #5254 applied to `adr next`. Where a question genuinely cannot be answered, the group says so in **vocabulary** — `unanchored`, `unknown` — never by falling silent. |

**Private codes are group-local.** `12`–`16` mean what this table says within `pattern` and carry no
cross-group obligation; `build` seats `12` as `NOT_A_WORKTREE` and `review` seats it as `STALE_HEAD`,
and those are three namespaces rather than one collision.

---

## `pattern corpus`

**Invocation**

```
fabrika pattern corpus [--dir <path>] [--base <ref>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--dir` | string | no | `.patterns` | the directory of flat `<slug>.md` pattern docs to read |
| `--base` | string | no | `origin/main` | the base ref to fetch and read the corpus from |
| `--json` | boolean | no | `false` | emit the corpus as one JSON object instead of the line grammar |

**Output** — machine channel. The first line is the header; `doc` and `dangling` lines follow.

```
corpus	<library|none|absent>	<docs>	<unregistered>	<unknown>	<dangling>
doc	<slug>	<registered|unregistered|unknown>	<section>	<last-sha>	<last-date>
```

`doc` lines are ordered by slug, ascending, byte-wise. `<section>` is the exact heading text the
doc's row sits under, or `-` when the registration state is not `registered`. `<last-sha>` is the
full 40-character sha of the last commit touching that doc's path at or before `--base`, and
`<last-date>` its author date as `YYYY-MM-DD`.

A `dangling` line is emitted for each index row whose **first cell** links a target that is not a doc
in `--dir` — the inverse defect of an unregistered doc. **This is not a link check and does not
overlap the link gate:** a target that fails to resolve at all is the gate's business, and a target
that resolves perfectly well — an ADR, a doc in a subdirectory, a file outside `--dir` — is still
dangling *here*, because the question is membership of this corpus, not reachability. Rows are
emitted in document order.

```
dangling	<link-target>	<section>
```

**The three outcome tokens are facts, and two of them are the adopting-repo case.**

- **`absent`** — `--dir` is not present in the tree at the resolved `--base`. This repo has no
  pattern library yet. Zero `doc` lines follow.
- **`none`** — `--dir` is present and holds no `*.md` file other than `index.md`. The library exists
  and is empty. Zero `doc` lines follow.
- **`library`** — at least one doc.

**Registration is three-valued, and the third value is what keeps a false negative out.**
`registered` means an index table row's first cell links this doc's filename. `unregistered` means
the index was parsed and no row does. **`unknown` means registration could not be determined at all**
— the index is absent, or holds no markdown table — and it is reported for every doc with a note on
stderr. Rendering an unknowable registration as `unregistered` would report a defect this verb never
proved, and would send a caller to add rows to a file that cannot hold them.

**Row parsing is positional, never a region scan.** A doc counts as registered only when a
**markdown table row's first cell** links its filename. A mention anywhere else in the index — a
sentence of prose, a reading-order note, a second cell — is not a registration. v1's check was
`grep -n "$NAME.md" index.md`: unanchored, whole-file, and with `.` as a regex any-char, so prose
passed as a row. Scanning a region and inferring position is the same defect front-door's disposition
parser had to fix.

With `--json`, one object with keys `outcome`, `docs`, `unregistered`, `unknown`, `dangling`,
`entries` (an array of `{slug, registration, section, lastSha, lastDate}`, empty unless `outcome` is
`library`), `danglingRows` (an array of `{target, section}`), `baseRef` and `baseSha`.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | `--base` could not be fetched, or the tree could not be read — the corpus is UNKNOWN, never `none` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `pattern corpus: cannot fetch <ref>: <reason> — the corpus is UNKNOWN, never "none".` | 11 | refusal |
| `pattern corpus: cannot read <dir> at <ref>: <reason> — UNKNOWN, never "absent".` | 11 | refusal |
| `pattern corpus: cannot read the history of <path>: <reason> — UNKNOWN, never a missing commit.` | 11 | refusal |

**Scope** — every `*.md` file directly under `--dir` at the fetched `--base`, excluding `index.md`,
which is the registry rather than a member of the corpus. (v1's `list-pattern-docs.sh` listed
`index.md` as a pattern doc.) The scope line goes to stderr on every run, naming the base sha, the
directory and the counts.

**Zero scope is an answer here, and the read is what makes that safe.** The corpus is listed out of
the object database at the resolved base sha, and that read **fails outright when the directory is
not in the tree**. So an empty listing is a directory that exists and holds nothing, not a directory
nobody could find — which is precisely the distinction `decisions-index next` does not make when it
computes `max + 1` over an empty entry set and hands a mis-rooted checkout `0001`.

**Examples**

```
$ fabrika pattern corpus --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/empty-library
corpus	none	0	0	0	0
$ echo $?
0
```

```
$ fabrika pattern corpus --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/no-library
corpus	absent	0	0	0	0
$ echo $?
0
```

```
$ fabrika pattern corpus --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/empty-library --json
{"outcome":"none","docs":0,"unregistered":0,"unknown":0,"dangling":0,"entries":[],"danglingRows":[],"baseRef":"origin/main","baseSha":"<sha>"}
```

**`no-library` is deliberately not a committed directory** — it is the absent path, and a fixture
that existed could not demonstrate the outcome that fires when one does not.

`doc` lines carry a commit sha and an author date, which are a function of a repository's history
rather than of this spec, so **no example prints them** — an example value that looks verifiable and
is not is worse than no example (ADR 0247). The grammar above is the contract; the two derivable
outcomes are shown byte for byte.

**Grounding**

- v1's `list-pattern-docs.sh` carries two scars this verb designs out: it emits its refusals on
  **stdout**, so a caller parsing stdout as the doc list ingests the error text as a filename; and it
  applies no `index.md` exclusion, so the registry lists as a member of the corpus.
- `decisions-index next` computes `max + 1` over its entry set with no proof that the set came from a
  real corpus, so a mis-rooted run answers `0001` and invites an author to overwrite the first
  record. This verb proves the directory by the read itself.
- #5254 — an empty corpus is a fact for a verb that supplies, not a refusal. ADR 0092's zero-scope red
  binds a **gate**, whose empty scan means it checked nothing; it does not bind a verb whose whole
  answer is what the library holds.
- front-door's disposition parser — parse by cell position, never scan a region and infer position.
  The unregistered/`unknown` split is the same lesson as its `unprobeable` presence state: a state
  that cannot be determined gets its own name rather than being rendered as the negative.

---

## `pattern drift`

Answers whether the **in-repo source a doc cites** moved since the doc was last written.

**Invocation**

```
fabrika pattern drift worker-queue-retry [--dir <path>] [--base <ref>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<slug>` | positional string | yes | — | the doc's basename without `.md` |
| `--dir` | string | no | `.patterns` | the directory the doc lives in |
| `--base` | string | no | `origin/main` | the base ref to fetch, resolve the anchor commit against, and diff to |
| `--json` | boolean | no | `false` | emit the result as one JSON object instead of the line grammar |

**Derivation** — the computation, in full. Two implementers who read this section follow the same
paths and count the same commits; nothing below is left to judgment.

1. **The subject.** `<dir>/<slug>.md`. If it is absent from both the working tree and the tree at the
   resolved `--base`, exit `12`. If it is present in the working tree and absent at `--base`, the
   outcome is `unborn` — it has never been committed, so there is no anchor to measure from. An
   uncommitted doc is the bootstrap case, not an empty diff; v1's script gets this right and it is
   kept.
2. **Candidate tokens.** From the doc's text at `--base`, take every **backticked span** and every
   **markdown link target**. A candidate is one whitespace-free token.
3. **Filter to unambiguous repo-root-relative paths.** A candidate is dropped when it contains any of
   `* ? { } [ ] ! ( ) < > $ |`, when it carries a `<scheme>:` prefix, or when it does not begin with a
   **repo top-level segment**. The segment set is not hardcoded: it is **every top-level entry in the
   tree at the resolved `--base`**, so the verb works in a repo whose layout is not this one. A bare
   basename and an app-relative fragment are ambiguous shorthand and are left alone — precision over
   recall, at the stated cost of missing a partial pointer.
4. **Partition by resolution at `--base`.** A candidate that names a path present in the tree is
   **in-repo**; one that does not is **unresolved**. `<cited>` counts step 3's survivors, `<in-repo>`
   and `<unresolved>` the two parts.
5. **The anchor commit.** The last commit touching `<dir>/<slug>.md` at or before the resolved
   `--base`.
6. **The moved set.** For each in-repo path, the commits touching it in the range
   *(anchor commit, base sha]*. A path with at least one such commit is **moved**.
7. **Outcome.** `drifted` when the moved set is non-empty. `current` when `<in-repo>` is at least 1
   and the moved set is empty. `unanchored` when `<in-repo>` is 0. `unborn` per step 1.

**An unresolved candidate is never drift, and never a finding.** Pattern prose legitimately cites
external dependency source trees, and such a path is indistinguishable from a deleted in-repo path by
resolution alone. It is counted, named on stderr, and excluded from steps 6 and 7. This verb inherits
`pointer-guard`'s avoidance rather than repeating the false positive it was written to escape.

**`unanchored` is not a clearance.** It says the doc cites nothing this verb can follow, so drift here
is **unanswerable** — read the source by hand. Reporting it as `current` would be a clean pass over
nothing, which is the shape ADR 0092 exists to forbid; the group expresses that in vocabulary rather
than in an exit code, because a verb that refused would break the pipe its answer crosses.

**Output** — machine channel.

```
drift	<drifted|current|unanchored|unborn>	<anchor-sha>	<cited>	<in-repo>	<unresolved>	<moved>
path	<repo-path>	<commits>	<last-sha>	<last-date>
```

`<anchor-sha>` is the full sha from step 5, or `-` on `unborn` and on `unanchored` — on
`unanchored` no in-repo path was followed, so the anchor commit bounded nothing and printing it
would imply a range that was never walked. One `path` line per **moved** path
only, ordered by path ascending; an unmoved in-repo path is counted in the header and not listed,
because the header's `<in-repo>` count is what makes the omission readable. `<commits>` is that
path's commit count in the range.

With `--json`, one object with keys `outcome`, `anchorSha`, `cited`, `inRepo`, `unresolved`, `moved`,
`paths` (an array of `{path, commits, lastSha, lastDate}`, empty unless `outcome` is `drifted`),
`unresolvedPaths` (an array of the step-4 leftovers, so a caller can see what was skipped rather than
trusting a count), `baseRef` and `baseSha`.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | `--base` could not be fetched, the tree could not be read, or a git history read failed — the outcome is UNKNOWN |
| `12` | `<slug>` names no doc in the working tree or at `--base` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `pattern drift: cannot fetch <ref>: <reason> — the outcome is UNKNOWN, never "current".` | 11 | refusal |
| `pattern drift: cannot read the history of <path>: <reason> — the outcome is UNKNOWN, never "current".` | 11 | refusal |
| `pattern drift: no doc for slug "<slug>" under <dir>, in the working tree or at <ref>.` | 12 | refusal |
| `pattern drift: slug "<slug>" is not kebab-case (lowercase letters, digits and single hyphens).` | 1 | usage error |

**Scope** — the in-repo paths the subject doc itself cites, resolved at the fetched `--base`, over the
commit range from the doc's anchor commit to the base sha. The scope line goes to stderr naming the
base sha, the anchor sha, all three counts, and **each unresolved candidate by name**, so a caller can
see exactly what the answer does not cover.

**A pathspec that matches nothing can never read as a clean answer here**, because the paths are
derived from the doc and resolved before they are used, and a doc whose paths all fail to resolve
lands on `unanchored`. v1's script takes its source directories as caller-supplied arguments and runs
`git diff --name-status <last>..HEAD -- "$@"`, which exits `0` with empty output both when nothing
changed and when the pathspec matched nothing — so a typo reads as "nothing drifted", over a path set
the doc was never consulted about.

**Examples**

```
$ fabrika pattern drift worker-queue-retry --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/unanchored-doc
drift	unanchored	-	0	0	0	0
$ echo $?
0
```

```
$ fabrika pattern drift worker-queue-retry --json --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/unanchored-doc
{"outcome":"unanchored","anchorSha":"-","cited":0,"inRepo":0,"unresolved":0,"moved":0,"paths":[],"unresolvedPaths":[],"baseRef":"origin/main","baseSha":"<sha>"}
```

```
$ fabrika pattern drift no-such-doc
pattern drift: no doc for slug "no-such-doc" under .patterns, in the working tree or at origin/main.
$ echo $?
12
```

The `drifted` and `current` outcomes print a commit sha, an author date and commit counts — all
functions of a repository's history rather than of this spec — so **no example prints them**, and the
line grammar above is the contract for those two (ADR 0247). `baseSha` is shown as `<sha>` for the
same reason; every other field in the JSON example is derivable from the fixture.

**Grounding**

- v1's `pattern-doc-drift.sh` carries four scars, all designed out above: it resolves the anchor with
  `git log -1` against the **local** `HEAD` rather than a fetched base ref; it takes the source
  directories as **caller-supplied arguments**, so the answer is only as good as the caller's memory
  of what the doc describes; its `git diff` exits `0` with empty output on a pathspec that matched
  nothing, so zero scope reads as a clean answer (ADR 0092); and its clean case prints **empty
  stdout**, byte-identical to a verb that never ran.
- `pointer-guard`'s `.patterns/**` exclusion — the false-positive class that makes step 4's partition
  necessary rather than fussy, quoted at the head of this spec.
- #2627 — `.patterns/` has **no drift mechanism today**, and the anchor model (a prose line, new
  frontmatter, or a per-pattern-kind split) is an **open, unruled decision** on a control-plane
  surface. This verb answers only the question it can answer from what the corpus already carries:
  git history over the paths a doc itself cites. It settles nothing about #2627 and must not be read
  as having done so.
- #4723 — a verb that exits non-zero on its own informative case makes a caller read a useful answer
  as a failure. All four outcomes here exit `0`.

---

## `pattern anchor`

Answers whether the **dependency version a doc declares** still matches what the workspace pins. The
git half and the dependency half go stale independently, which is why this is a separate verb rather
than a mode of `drift`.

**Invocation**

```
fabrika pattern anchor worker-queue-retry [--dir <path>] [--manifest <path>] [--base <ref>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<slug>` | positional string | yes | — | the doc's basename without `.md` |
| `--dir` | string | no | `.patterns` | the directory the doc lives in |
| `--manifest` | string | no | `pnpm-workspace.yaml` | the workspace manifest whose `catalog:` map holds the live pins |
| `--base` | string | no | `origin/main` | the base ref to fetch and read both the doc and the manifest from |
| `--json` | boolean | no | `false` | emit the result as one JSON object instead of the line grammar |

**Derivation** — in full.

1. **Anchor declarations.** From the doc's text at `--base`, every line matching, exactly:

   ```
   ^> Derived from `(?<token>[^`]+)` — re-verify on pin bump\.$
   ```

   The em-dash is literal.

   **A line that opens `> Derived from ` and does not match in full is a `malformed` declaration, not
   a non-declaration.** This is the load-bearing half of the rule. Measured against this repo at
   authoring time, 24 lines match the strict grammar and **9 more do not** — they carry the shape
   `> Derived from the in-repo source (...) + ` then a backticked `<pkg>@<version>` then
   ` where the lib is implicated ...`. Treating those as absent would answer `unanchored` — *"this
   doc claims no dependency anchor"* — for nine docs that visibly claim one, which is a fail-open
   false negative over a quarter of the anchored corpus. Counting them as malformed makes the verb
   say *"something here declares an anchor I could not parse"*, which is true and actionable. It is
   the same discipline `pattern drift` applies to an unresolved path: never silently drop what you
   could not follow.
2. **Split the token.** `<token>` splits at its **last** `@` into `<package>` and `<version>`.
   Splitting at the last rather than the first is what makes a scoped package work: `@nkzw/fate@1.3.1`
   yields `@nkzw/fate` and `1.3.1`, where a first-`@` split would yield an empty package name. A token
   with no `@`, or whose split yields an empty half, is reported `malformed` and counted, never
   guessed at.
3. **Resolve the pin.** Look `<package>` up as a key of the manifest's top-level `catalog:` map, read
   as a block map of scalar pins. A key that is absent is `unpinned`.

   **A catalog that is there and could not be read is exit `11`, never `unpinned`.** Three shapes are
   outside what this reader comprehends — a flow map (`catalog: {…}`), a nested sub-map under a key,
   and a named-catalog `catalogs:` block — and each of them parses as YAML, so none can be told apart
   from a real read by parse success alone. Answering anyway produced two confident wrong answers:
   the flow map and `catalogs:` both read as *no catalog at all* (`unpinned` for every declaration),
   and the sub-map pinned its key to the empty string, which compares unequal to every declared
   version and reported `moved` against a pin nobody wrote (#5361). All three refuse instead.
4. **Compare.** `<version>` against the pinned value, **byte for byte**, with no semver
   interpretation. A doc's anchor records the version its author actually read; accepting a range
   would silently bless a version nobody checked, which is the whole failure the line exists to catch.
5. **Outcome**, by this precedence: `unborn` if the doc is present in the working tree and absent at
   `--base`; else `moved` if any declaration moved; else **`malformed`** if any failed to
   parse; else `unpinned` if any package is absent from the manifest; else `matched` if there is at
   least one declaration; else `unanchored`.

   **`malformed` is its own outcome and does not fold into `unpinned`.** They ask opposite things of
   a caller: `unpinned` says this repo no longer carries the dependency, which is a question about
   whether the doc still applies at all; `malformed` says the anchor line is mistyped, which is a
   one-line repair. Folding the second into the first points a typo at the same remedy as a dropped
   dependency.

   **`unanchored` therefore fires only when the doc carries no `> Derived from ` line at all** — not
   merely when none parsed. That is what keeps step 1's near-miss case from reading as clean.

**`unborn` mirrors `pattern drift` deliberately.** Both verbs take the same positional `<slug>` and
the skill runs them back to back, so one tree state must not produce two different verdicts: a
freshly-written, uncommitted doc is `unborn` on both, at exit `0`. Only a slug with no doc in the
working tree *and* none at `--base` is exit `12`.

**Output** — machine channel.

```
anchor	<matched|moved|malformed|unpinned|unanchored|unborn>	<declared>	<moved>	<unpinned>	<malformed>
pkg	<package>	<declared-version>	<pinned-version>	<matched|moved|unpinned|malformed>
```

**`<declared>` counts every `> Derived from ` line, malformed ones included**, so it is always
`<moved> + <unpinned> + <malformed> + <matched>` and a reader can check the header against itself.
Counting only the well-formed ones would hide the very lines this verb exists to surface.

One `pkg` line per declaration, in the order they appear in the doc. `<pinned-version>` is `-` when
the package is not a catalog key. On a `malformed` declaration **both version fields are `-` and
`<package>` carries the line's text after `> Derived from `, with tabs and newlines stripped and
clamped to 120 characters** — the line is malformed precisely because no `<pkg>@<version>` token can
be split out of it, so there is nothing narrower to print and a truncated echo is what lets a reader
find the line.

**`unanchored` is a fact, not a fault.** Most pattern docs describe in-repo shapes and are anchored to
no dependency at all — a minority of this repo's docs carry a declaration (22 of 83 at the time of
writing, though both numbers move, so count them rather than quoting this sentence). It is reported so a caller
can tell "this doc claims no dependency anchor" from "this doc's anchor is fine", and it is never
reported as `matched`.

With `--json`, one object with keys `outcome`, `declared`, `moved`, `unpinned`, `malformed`,
`packages` (an array of `{package, declaredVersion, pinnedVersion, state}`, empty on `unanchored`),
`manifest`, `baseRef` and `baseSha`.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | `--base` could not be fetched, or the doc could not be read — the outcome is UNKNOWN |
| `12` | `<slug>` names no doc in the working tree or at `--base` |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `pattern anchor: cannot fetch <ref>: <reason> — the outcome is UNKNOWN, never "matched".` | 11 | refusal |
| `pattern anchor: cannot read <manifest> at <ref>: <reason> — every pin is UNKNOWN, never "unpinned".` | 11 | refusal |
| `pattern anchor: cannot read the catalog in <manifest> at <ref>: <reason> — every pin is UNKNOWN, never "unpinned".` | 11 | refusal |
| `pattern anchor: no doc for slug "<slug>" under <dir>, in the working tree or at <ref>.` | 12 | refusal |
| `pattern anchor: slug "<slug>" is not kebab-case (lowercase letters, digits and single hyphens).` | 1 | usage error |

**A manifest that reads but whose catalog this verb could not read is UNKNOWN too** (exit `11`), for
the same reason — including the three comprehensible-YAML shapes in step 3. A manifest that carries
**no `catalog:` key at all** is the degrade path instead: every declaration reports `unpinned` at exit
`0` with the absence named on stderr, because a repo that pins nothing centrally is a fact about that
repo rather than a failed read. The two are not interchangeable: the degrade line names an absence,
so it is never printed for a manifest that does carry a catalog.

**An unreadable manifest is UNKNOWN and never `unpinned`.** The two are one keystroke apart in
consequence: `unpinned` says the repo does not carry this dependency, and a failed read says nothing
at all. Fusing them is the same defect the `7`/`11` split exists to prevent — a 404 is a verdict, a
5xx is a verdict about nothing. A manifest that is genuinely **absent** is the degrade path the
skill's required-files table declares: every declaration reports `unpinned` at exit `0`, with the
absence named on stderr.

**Scope** — every anchor declaration in the subject doc, resolved against the `catalog:` map of
`--manifest` at the fetched `--base`. The scope line goes to stderr naming the base sha, the manifest
path and the four counts.

**Examples**

Both run against fixtures committed in this skill's tree and reproduce byte for byte; the stderr
scope line is not shown. The fixture manifest pins `acme-queue: 4.2.0` and carries no
`@acme/retry` key.

```
$ fabrika pattern anchor worker-queue-retry --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored --manifest claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored/workspace.yaml
anchor	moved	2	1	1	0
pkg	acme-queue	4.1.0	4.2.0	moved
pkg	@acme/retry	2.0.0	-	unpinned
$ echo $?
0
```

```
$ fabrika pattern anchor plain-doc --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored --manifest claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored/workspace.yaml
anchor	unanchored	0	0	0	0
$ echo $?
0
```

```
$ fabrika pattern anchor worker-queue-retry --json --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored --manifest claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored/workspace.yaml
{"outcome":"moved","declared":2,"moved":1,"unpinned":1,"malformed":0,"packages":[{"package":"acme-queue","declaredVersion":"4.1.0","pinnedVersion":"4.2.0","state":"moved"},{"package":"@acme/retry","declaredVersion":"2.0.0","pinnedVersion":null,"state":"unpinned"}],"manifest":"claude-plugins/fabrika/skills/write-pattern/evals/fixtures/anchored/workspace.yaml","baseRef":"origin/main","baseSha":"<sha>"}
```

**Grounding**

- The declaration grammar is the one **the corpus already carries** — a minority of the docs, in
  exactly this shape; count them at read time rather than trusting a number written here. This verb reads what is there; it does not propose frontmatter or any other anchor model,
  because that choice is #2627's and is unruled.
- #2627 — the anchor model is an open control-plane decision. Matching the existing prose line is the
  conservative floor: it is falsifiable today and it commits nothing.
- The byte-for-byte comparison is deliberate. Every dependency in this repo is pinned to one exact
  version through the workspace catalog, so a range comparison would have nothing to buy and a real
  failure mode to hide.

---

## `pattern new`

**Invocation**

```
fabrika pattern new worker-queue-retry [--dir <path>] [--title <text>] [--anchor <pkg@version>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<slug>` | positional string | yes | — | the kebab-case basename the doc takes, without `.md` |
| `--dir` | string | no | `.patterns` | the directory to write the doc into, created when absent |
| `--title` | string | no | derived from the slug | the H1 text. The derivation: replace each `-` with a space, then upper-case the first character and leave every other character as it is. `worker-queue-retry` becomes `Worker queue retry`; `fate-effect-server` becomes `Fate effect server`. No acronym or digit special-casing — a doc wanting one passes `--title` |
| `--anchor` | string | no | none | a `<pkg>@<version>` this doc is derived from; adds the anchor line `pattern anchor` reads. Validated by `pattern anchor`'s step-2 rule — split at the **last** `@`, both halves non-empty — so the writer and the reader accept exactly the same strings |
| `--json` | boolean | no | `false` | emit the write record instead of the bare path |

**Output** — one line, the path written, newline-terminated. With `--json`, one object with keys
`path`, `slug`, `title`, and `anchored` — the latter the `<pkg>@<version>` string when `--anchor`
was given, and `null` when it was not.

The file's bytes are the canonical template, and **this block is that template's single home** — the
skill carries no copy to drift against:

```markdown
# <Title>

<One sentence: what shape this describes, and where in the tree it applies.>

## The shape

<The pattern itself, with a fenced example lifted from a test or a real call site.>

## When this applies

<The two or more places it is used, by path, and the boundary where it stops applying.>

## Why it is not obvious

<What a reader would otherwise invent, and why that version is worse.>
```

With `--anchor`, one more line is appended, and its bytes are exactly the grammar `pattern anchor`
parses: a blockquote marker, `Derived from `, the backticked `<pkg>@<version>`, then
` — re-verify on pin bump.`

**The three body headings mirror the admission bar** the skill applies in step 2 — used in 2+ places,
non-obvious, a future agent would invent worse — so a doc that cannot fill them is a doc that did not
clear the bar. **This is a starting shape and not a validated grammar**: nothing here or at any gate
checks a pattern doc's headings, an existing doc keeps whatever shape it has, and exit `4` is a
deliberate gap for that reason. The corpus is 83 docs with no shared skeleton, and imposing one
retroactively would fail in every repo that is not this one.

**Exit status**

| Code | Trigger |
|---|---|
| `8` | the file could not be written, so whether anything landed is UNKNOWN |
| `11` | the target-path existence check itself failed, so whether `<path>` exists is UNKNOWN — never read as absent, and never `13`, which is proven |
| `13` | the target path already exists — refused, never overwritten |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `pattern new: <path> already exists — refusing to overwrite.` | 13 | refusal |
| `pattern new: cannot check <path>: <reason> — nothing was written.` | 11 | refusal |
| `pattern new: slug "<slug>" is not kebab-case (lowercase letters, digits and single hyphens).` | 1 | usage error |
| `pattern new: --anchor "<value>" is not <pkg>@<version>.` | 1 | usage error |
| `pattern new: cannot write <path>: <reason> — whether anything landed is UNKNOWN.` | 8 | refusal |

**Scope** — not a judging verb. It writes exactly one file and never edits another; the index row is
`pattern register`'s, and separating them is what lets a doc land in a repo whose index is missing.
It does not check whether a doc already covers the subject; that is `pattern corpus` and the
skill's judgment.

**Examples**

```
$ fabrika pattern new worker-queue-retry
.patterns/worker-queue-retry.md
```

```
$ fabrika pattern new worker-queue-retry
pattern new: .patterns/worker-queue-retry.md already exists — refusing to overwrite.
$ echo $?
13
```

```
$ fabrika pattern new worker-queue-retry --json
{"path":".patterns/worker-queue-retry.md","slug":"worker-queue-retry","title":"Worker queue retry","anchored":null}
```

```
$ fabrika pattern new worker-queue-retry --anchor acme-queue@4.2.0 --json
{"path":".patterns/worker-queue-retry.md","slug":"worker-queue-retry","title":"Worker queue retry","anchored":"acme-queue@4.2.0"}
```

**Grounding**

- The template lives here rather than in `SKILL.md` because a template in two places is a template
  that drifts, and the skill's job is the judgment the template cannot carry — the same split
  `adr new` takes.
- Creating `--dir` when it is absent is the bootstrap half of the required-files table: a repo
  adopting fabrika has no `.patterns/`, and its first pattern doc has to be writable on the documented
  path. Refusing there is the first-run dead-end the portability rules forbid.
- The `--anchor` line's bytes are pinned to `pattern anchor`'s grammar in one place, so the writer and
  the reader of that line cannot disagree.

---

## `pattern register`

**Invocation**

```
fabrika pattern register worker-queue-retry --section "Index — Effect domain layer" --topic "..." --read-when "..." [--dir <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<slug>` | positional string | yes | — | the doc whose row is inserted, without `.md` |
| `--section` | string | yes | — | the exact heading text, without leading `#`, of the index section the row goes under |
| `--topic` | string | yes | — | the row's second cell: what the doc covers |
| `--read-when` | string | yes | — | the row's third cell: when a reader should open it |
| `--dir` | string | no | `.patterns` | the directory holding the docs and `index.md` |
| `--json` | boolean | no | `false` | emit the edit record instead of the line grammar |

**Output** — one tab-separated line: the outcome token, the path edited, and the section.

```
<inserted|already>	<path>	<section>
```

With `--json`, one object with keys `outcome`, `path`, `slug`, `section` and `row`.

**The row's bytes**, with each cell's tabs and newlines stripped and its pipes escaped as `\|`:

```
| [<slug>.md](./<slug>.md) | <topic> | <read-when> |
```

**Mechanics, in order.**

1. Read `<dir>/index.md` **from the working tree** — this verb edits the tree, so it must read what
   it is about to write. If it is absent, or holds no markdown table under any heading, exit `15`.
2. Refuse to write a row pointing at nothing: if `<dir>/<slug>.md` does not exist in the working
   tree, exit `12`.
3. Locate the section: a heading line whose text, after stripping leading `#` characters and
   surrounding whitespace, equals `--section` exactly. Not found exits `10` and **names every section
   heading that does exist**, in document order and without truncating, so the caller's next
   invocation is a correction rather than a guess. Found more than once exits `16` — a different fact
   with a different remedy, since the flag is right and the index is what needs disambiguating.
4. If any table row anywhere in the index already links `<slug>.md` in its first cell, write nothing
   and answer `already` at exit `0`. Registering twice is a no-op, not an error.
5. Insert the row immediately after the last table row under that heading and before the next heading.
6. **Prove the diff before writing.** The new text must differ from the original by exactly one added
   line and nothing else — no removed line, no modified line. Otherwise exit `14` and write nothing.
7. Write, then read the file back and re-parse it. The row must be present under the named section and
   parse to the same three cells. Otherwise exit `9`.

**The diff fence is the load-bearing step, and it exists because of who else edits this file.**
`.patterns/index.md` is hand-curated, carries prose between its tables, and is edited by lanes this
verb cannot see. An insertion that reflowed a table, normalized a pipe or rewrote a neighbouring row
would destroy work with no diff small enough for a reviewer to notice. Exit `14` is that rule made
mechanical rather than remembered, and it is the deterministic test the implementation owes.

**Exit status**

| Code | Trigger |
|---|---|
| `8` | the write failed, so whether anything landed is UNKNOWN |
| `9` | the write landed and the read-back does not carry the row as written |
| `10` | `--section` names no heading in the index |
| `16` | `--section` matches more than one heading in the index |
| `12` | `<dir>/<slug>.md` does not exist — refusing to write a row pointing at nothing |
| `14` | the edit would have changed a line beyond the inserted row — aborted, nothing written |
| `15` | the index is absent, or holds no parseable markdown table |
| `11` | `<dir>/index.md` (step 1) or `<dir>/<slug>.md` (step 2) could not be read at all, so the precondition is UNKNOWN — never `15` or `12`, which are proven facts |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `pattern register: <dir>/index.md is absent — the doc at <dir>/<slug>.md is written and unregistered; front-door bootstraps the index.` | 15 | refusal |
| `pattern register: <dir>/index.md holds no parseable markdown table — the doc at <dir>/<slug>.md is written and unregistered; front-door bootstraps the index.` | 15 | refusal |
| `pattern register: no doc at <dir>/<slug>.md — refusing to register a row pointing at nothing.` | 12 | refusal |
| `pattern register: cannot check <dir>/index.md: <reason> — nothing was written.` | 11 | refusal |
| `pattern register: cannot read <dir>/index.md: <reason> — nothing was written.` | 11 | refusal |
| `pattern register: cannot check <dir>/<slug>.md: <reason> — nothing was written.` | 11 | refusal |
| `pattern register: slug "<slug>" is not kebab-case (lowercase letters, digits and single hyphens).` | 1 | usage error |
| `pattern register: no section "<section>" in <dir>/index.md (present: <a>, <b>, …).` | 10 | refusal |
| `pattern register: "<section>" matches <n> headings in <dir>/index.md — ambiguous, nothing written.` | 16 | refusal |
| `pattern register: insertion would have changed <n> line(s) beyond the new row — aborted, nothing written.` | 14 | refusal |
| `pattern register: cannot write <path>: <reason> — whether anything landed is UNKNOWN.` | 8 | refusal |
| `pattern register: <path> was written and the read-back does not carry the row — the file needs a human.` | 9 | refusal |

**Scope** — not a judging verb. It reads and writes exactly one file, `<dir>/index.md`, and reads one
more, `<dir>/<slug>.md`, to prove the row's target exists.

**Examples**

```
$ fabrika pattern register worker-queue-retry --section "Index — Effect domain layer" --topic "Retry and backoff on the worker queue" --read-when "Adding a queue consumer, or changing a retry policy"
inserted	.patterns/index.md	Index — Effect domain layer
```

Run against the three-section fixture, so the `present:` list is exact and derivable. It is **every**
section carrying a table, in document order, comma-separated — it never truncates, because a caller
correcting a flag needs the whole set:

```
$ fabrika pattern register cache-invalidation --section "Nonexistent Section" --topic "x" --read-when "y" --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/three-sections
pattern register: no section "Nonexistent Section" in claude-plugins/fabrika/skills/write-pattern/evals/fixtures/three-sections/index.md (present: Index — services, Index — edge, Index — observability).
$ echo $?
10
```

```
$ fabrika pattern register cache-invalidation --section "Index — services" --topic "Cache keys and invalidation order" --read-when "Touching a cached read" --dir claude-plugins/fabrika/skills/write-pattern/evals/fixtures/three-sections
already	claude-plugins/fabrika/skills/write-pattern/evals/fixtures/three-sections/index.md	Index — services
$ echo $?
0
```

**Grounding**

- v1's `verify-pattern-doc.sh` checks registration with `grep -n "$NAME.md" index.md` — unanchored,
  whole-file, and with `.` matching any character, so a mention in prose passes as a registration.
  This verb requires a table row's **first cell**, which is the same positional-parse discipline
  front-door's disposition reader had to adopt after a region scan reported a word that was not there.
- The one-line diff fence is `adr supersede`'s, for the same reason: an edit to a file whose other
  content is not yours must prove it touched only what it claimed.
- The read-back is the `report` group's `9`: a write that landed and does not match is an artifact
  that exists and needs a human, and it is neither a success nor a failed write.
- #1777 — a row pointing at a file that does not exist is a dead link that a link gate will red later
  and a reader will hit sooner. Exit `12` is why the target is proven first.

---

## Required repo files

The works-here checklist is stated once, in [`SKILL.md`](SKILL.md)'s `## Required repo files`
table — the three-column shape with a bolded disposition in the third cell that one reader parses
across every fabrika skill. It is not restated here; a second copy is a second thing to drift.

Two rows bind implementation directly and are named again only as pointers: `id:patterns-dir` is why
`pattern new` creates `--dir` when it is absent, and `id:patterns-index` is why `pattern register`
exits `15` with the doc already written rather than refusing the whole run.

## Namespaces and gates — what this group does not join

`write-pattern` emits **no verdict marker and joins no gate vocabulary.** It is an authoring skill,
not a gate: it produces an edit and the doc gate reviews it like any other. Concretely, and checked
against the shipped code rather than assumed:

- `write-pattern` is not a member of the verdict-marker namespace set, the ship-gate namespace set,
  or the review class names — and it should not become one. Widening those to admit an authoring
  skill would let it emit a verdict about work it performed.
- A `.patterns/*.md` diff classifies as the **doc** surface, so a pull request from this skill gates
  on the doc review namespace. `.patterns/` is **not** a governance root, unlike `.decisions/`, so a
  pattern-doc pull request does not carry the governance namespace an ADR does.
- The two questions this contract deliberately does not answer are answered for a `.patterns/` diff
  by the repo's own link and leak gates, named at the head of this spec. No verb here re-answers them
  and this skill invokes nothing to do so.

Stated here to close the question rather than leave it to be rediscovered: no verb in this group
needs a repository token, and none writes to any board surface.
