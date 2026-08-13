# `/glossary` — derived CLI contract

**Skill:** [`glossary`](SKILL.md) · **Authoring brief:** [#4711](https://github.com/kamp-us/phoenix/issues/4711) · **Date:** 2026-08-10

The group is `glossary`, in `packages/fabrika-cli/`, invoked as `fabrika glossary <verb> …`. The
[CLI interface convention](../../docs/cli-interface-convention.md) governs all six; where this spec
and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill.** Every verb below is
implemented in `packages/fabrika-cli/`, and no fence in `SKILL.md` invokes anything else
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). v1's
`glossary-drift` tool and the v1 skill's three shell scripts were read for their semantics and their
scars — every scar named in a Grounding block below came from that reading — and none is called.

**Three questions were considered and deliberately not derived**, because each already has an
authority and a second answer could contradict it on a merge-gating question:

- **Machine-local paths in the register.** `leak-guard scan` runs on every changed markdown file at
  `.github/workflows/leak-guard.yml`, on `pull_request` **and** `merge_group`; `TERMS.md` is a doc
  surface by suffix. That gate is the authority. A fabrika copy could answer `clean` while the gate
  reds — the `adr classify` test, applied unchanged. Exit seats `5` and `6` are held empty for this
  reason rather than left unallocated.
- **Dead internal links in the register.** `.github/workflows/doc-links.yml` runs `lychee --offline`
  over every git-tracked `*.md`, on `pull_request` and `push: main`, fail-closed on zero scope.
  Repo-wide and merge-blocking; the same reasoning applies.
- **Control-plane classification.** Decided at the merge gate, never predicted here.

**Why a drift verb *is* derived, when a v1 tool computes something similar.** `pipeline-cli
glossary-drift` is **not** a gate: `.github/workflows/glossary-drift.yml` carries only `schedule`
(weekly) and `workflow_dispatch` triggers, no `pull_request`, is absent from `ci-required.yml`, and
its own header states it is off the blocking path by construction (ADR 0128 rejected extending the
gate). Nothing is enforced, so nothing is contradicted, and ADR 0238 asks fabrika to implement its
own.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `glossary init` | create an empty register with its header, so a fresh repo is not a dead end | the file's *shape* is fixed text; nothing about it is a decision |
| `glossary drift` | the surfaces that moved since a register last changed, and the candidate coinages in them | diff a range, extract phrases, subtract declared keys — arithmetic; only *whether a candidate earns a row* is judgement |
| `glossary lookup` | whether a term is already declared, and what overlaps it | string normalization and set membership against a parsed corpus; *whether two colliding terms are the same term* stays in the skill |
| `glossary sections` | the live section names of a register | parse headings; the enum is data, and reading it is not a decision |
| `glossary add` | insert or replace one row, alphabetically placed, byte-preserving elsewhere | placement, escaping and the diff-shape assertion are mechanical; the definition's content is entirely judgement |
| `glossary check` | row-shape, duplicate-key, ordering and citation-liveness defects in a register | each defect is a decidable predicate over the file; what to *do* about one is the skill's |

**Considered and not derived.** A verb to decide which register a term belongs to. It is the skill's
central judgement (domain noun vs architecture vocabulary), and a verb that guessed it would be
consulted exactly where it is least reliable. Recorded here so it is not re-proposed as a gap.

## Shared conventions

Every verb below obeys these; they are stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else. Scope lines, refusal
  reasons and progress go to stderr.
- **Common inputs.** `--register <terms|language|both>` selects the register; it is a closed enum and
  an off-enum value is exit `10`. `--dir <path>` (default `.glossary`) is the register directory.
  `--json` swaps the line grammar for the JSON shape given per verb, on stdout.
- **Register filenames** are `TERMS.md` and `LANGUAGE.md` under `--dir`. `both` means TERMS first,
  then LANGUAGE, in that order everywhere.
- **`--register both` is per-register, and one absent file never fails the other.** This is the
  single most load-bearing clause in the group, because a repo with only `TERMS.md` is the normal
  adopting case and both `lookup` and `check` default to `both`. The rule: **each selected register
  is resolved independently.** A register whose file is absent contributes `bootstrap` — it is not an
  error, and the other register still answers. A register whose file is present but *unreadable* is
  exit `11` for the whole run, because an unreadable file is UNKNOWN and a partial answer would be
  read as complete. So: absent degrades, unreadable refuses. Every verb's stderr scope line names
  each selected register and which of the three it was, so a caller can never mistake a
  single-register answer for a two-register one.
- **Precedence between `4` and the empty cases.** A register with **no term table at all** holds zero
  rows — that is `bootstrap` (absent file) or the verb's zero-row behaviour (present file), never
  `4`. Exit `4` fires only on a table that **exists and is malformed**: a header row without a
  separator, or rows whose cell count the parser cannot resolve. The fixture's `LANGUAGE.md` is the
  worked case — non-empty prose, no table — and it is zero rows, not `4`.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit. A
  proven negative — "absent", "clean", "no drift" — is an **answer on exit 0 with a positive state
  token**, never a non-zero exit. This is not a preference: `refuse()` in
  [`src/verb.ts`](../../../../packages/fabrika-cli/src/verb.ts) hardcodes empty stdout and `answer()`
  hardcodes code `0`, so a non-zero exit carrying a machine payload is not constructible with the
  shipped helpers.
- **Repo-root resolution.** The register belongs to the *target repo*, so every verb resolves it with
  `discoverRepoRoot(process.cwd())` from
  [`src/delegate/root.ts`](../../../../packages/fabrika-cli/src/delegate/root.ts) and reads through
  [`src/io/fs.ts`](../../../../packages/fabrika-cli/src/io/fs.ts), whose doctrine — "I could not read
  this" is a failure, never an empty value — is the one this group needs most. No verb here reads
  plugin-shipped content, so the `PLUGIN_MANIFEST` walk in `src/status/roster.ts` is deliberately not
  used.
- **No verb in this group reaches GitHub or the network.** Every read is the local tree: the register
  files, the commit range, and the decision records under `--decisions`. The group therefore has no
  rate-limit code, no token input, and no REST/GraphQL question to answer — the
  [§11 rule](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql) binds fabrika's
  GitHub-touching groups and this one simply is not among them. Stated rather than left silent, so a
  reader does not go looking for the network surface.

### Term normalization — one function, used by every verb

`normalizeKey(cell)` maps a first-cell string to its comparison key. Two implementers must compute
the same key, so this is exact:

1. Strip a leading and trailing run of backticks, `*` and `_`.
2. Lowercase with `String.prototype.toLocaleLowerCase()` — **Unicode-aware, not `[a-z]`-restricted**,
   so `Sözlük` and `sözlük` are one key and `Geçit` is not silently dropped.
3. Replace every run of `-`, `_` or whitespace with a single space.
4. Trim.

**What it deliberately does not do:** it does not split on `(`, `/` or `,`. The whole cell is one
key. `sözlük (sozluk)` is a single term whose key is `sözlük (sozluk)`, and `tag` is a different term
from `Database (tag)`. Splitting a parenthetical into an alias is the defect that produced three
false duplicates when it was last attempted (#4206) — a parenthetical in this corpus is a
disambiguating qualifier, not a synonym.

**Overlap** — used only by `lookup` — is defined against the normalized keys: key `a` overlaps key
`b` when `a !== b` and one contains the other **as a whole-word span** (the match must begin at a
word boundary and end at one). `front door` overlaps `front door detection`; it does not overlap
`storefront doorway`.

### Exit codes

`glossary` is an **aligned** group: it ships `packages/fabrika-cli/src/glossary/codes.ts` and
**imports** each shared meaning from `packages/fabrika-cli/src/report/codes.ts` rather than restating
a numeral, which is what makes a drift there unrepresentable. It must be registered in
`ALIGNED_GROUPS` in
[`src/exit-code-alignment.ts`](../../../../packages/fabrika-cli/src/exit-code-alignment.ts) and in
the `TABLES` map of its unit test, or the coverage guard reds the moment the group is registered.

| Code | Meaning | Source |
|---|---|---|
| `0` | the answer is on stdout | reserved |
| `1` | usage error, or the verb failed to run | reserved |
| `126` | no implementation could be resolved | reserved |
| `127` | the verb never ran | reserved |
| `3` | `EMPTY_STDIN` — stdin was read and held nothing | import from `report` (`EMPTY_STDIN`) |
| `4` | `BAD_SECTIONS` — the register was read and a structure this verb needs (its term table, or its headings) is unusable | import from `report` (`BAD_SECTIONS`) |
| `5` | held empty — see below | leak detection is the merge gate's |
| `6` | held empty — see below | as above |
| `7` | `ZERO_SCOPE` — a judging verb scanned nothing it could judge | import from `report` (`NO_TARGET`) |
| `8` | `WRITE_UNKNOWN` — the register write failed; the outcome is UNKNOWN | import from `report` (`WRITE_UNKNOWN`) |
| `9` | `READBACK_MISMATCH` — the write landed and the re-read differs from intent | import from `report` (`READBACK_MISMATCH`) |
| `10` | `OFF_VOCABULARY` — a closed-enum flag carried an off-enum value | import from `report` (`CLASSIFIED`) |
| `11` | `PRECONDITION_UNKNOWN` — a precondition read failed; nothing was written | import from `report` (`PRECONDITION_UNKNOWN`) |
| `12` | `TERM_COLLISION` — the term is already declared; `add` refused | group-local |
| `13` | `SECTION_ABSENT` — the named section is not in the register | group-local |
| `14` | `ROW_SHAPE_INVALID` — the composed row cannot be a well-formed table row | group-local |
| `15` | `EDIT_BEYOND_ROW` — the write would have changed a line outside the target row | group-local |

Every verb can additionally return `0`, `1`, `126` and `127`; the per-verb tables below enumerate only
that verb's own proven outcomes from `3` up, so no fact has two homes.

**The seats map.** None of the shipped seat sets fits: `BUILD_SEATS` carries `LEAKED_PATH` and
`BARE_AT_PATH`, which this group deliberately does not claim. The implementation declares
`GLOSSARY_SEATS` — `BUILD_SEATS` minus those two — and registers `glossary` under it in
`ALIGNED_GROUPS`.

**`5` and `6` are held empty, not free**, so a later author does not re-seat a different meaning on a
number the base already owns. Only **`5`** carries the `DELIBERATE_GAP` export, because
`exit-code-alignment.ts` matches that one exact name (`GAP_EXPORT`) and a second export of it is a
TypeScript error while a renamed one reads as an allocation and reds as a collision. `6` is held by
this paragraph and by `codes.ts` simply never allocating it — a gap the guard sees as unclaimed,
which is the correct reading. Do not invent `DELIBERATE_GAP_2`.

---

## `glossary init`

Creates a register file that does not exist. Without it `bootstrap` is a state the skill can reach
and never leave: `add` requires a `--section` matched against live headings, and a file that is not
there has none. This verb is the reason a repo adopting fabrika on day one can run this skill at all
(#4776).

**Invocation**

```
fabrika glossary init --register terms [--dir <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--register` | enum `terms\|language` | yes | — | which register to create; `both` is refused, so the two are never created by one ambiguous call |
| `--dir` | string | no | `.glossary` | the directory to create the register in; created if absent |
| `--json` | boolean | no | `false` | emit the creation record instead of the line grammar |

**Output** — machine channel. One **tab-separated** line: `<action>`, `<path>` — where `action` is
`created`. With `--json`, one object with keys `action`, `path`, `register`.

The file's bytes are this template, and **this block is its single home**:

```markdown
# <repo> domain vocabulary (TERMS)

The repo-owned vocabulary spine. One row per term: the canonical definition, and where a name has
drifted, what the term is **not**. When the code and this file disagree, the code is authoritative
and this file is the doc to fix.
```

For `--register language` the H1 reads `# <repo> architecture vocabulary (LANGUAGE)` and the body
sentence names the architecture vocabulary instead. `<repo>` is the target repo root's directory
name. **No section is scaffolded** — an empty section invites filler, and `add --create-section`
writes the first one with the row that justifies it.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the file was created and its path is on stdout |
| `8` | the write failed; the outcome is UNKNOWN |
| `9` | the file was written and the read-back does not match the template |
| `10` | `--register both` was given, or a closed-enum flag carried an off-enum value |
| `12` | the register already exists — refused, never overwritten |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary init: <path> already exists — refusing to overwrite a register.` | 12 | refusal |
| `glossary init: --register both is not creatable — create each register explicitly.` | 10 | usage error |
| `glossary init: cannot write <path>: <reason> — the outcome is UNKNOWN.` | 8 | refusal |
| `glossary init: wrote <path> and the read-back does not match the template.` | 9 | refusal |

**Scope** — not a judging verb. It creates exactly one file and never edits an existing one.

**Examples**

```
$ fabrika glossary init --register terms --dir /tmp/fresh/.glossary
created	/tmp/fresh/.glossary/TERMS.md
```

```
$ fabrika glossary init --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
glossary init: claude-plugins/fabrika/skills/glossary/evals/fixtures/registers/TERMS.md already exists — refusing to overwrite a register.
$ echo $?
12
```

**Grounding**

- #4776 — working in a foreign repo is a release criterion. Without this verb the documented
  bootstrap path terminates in `add` exit `13` with no section to name, which is a first-run dead end
  rather than a fail-loud.
- The refusal-on-existing rule is `adr new`'s exit `3` idiom, reseated on this group's `12`: a
  register is the one artifact whose accidental overwrite destroys the most work.

---

## `glossary drift`

**Invocation**

```
fabrika glossary drift [--register <terms|language|both>] [--dir <path>] [--paths <a,b>] [--limit <n>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--register` | enum `terms\|language\|both` | no | `terms` | which register's last change bounds the diff and supplies the declared keys |
| `--dir` | string | no | `.glossary` | the directory holding the registers |
| `--paths` | string | no | every tracked path in the repo root | comma-separated pathspecs to diff; the default is the whole tree, never a fixed layout |
| `--limit` | integer | no | `40` | how many candidates to emit, highest-ranked first |
| `--json` | boolean | no | `false` | emit the drift result as one JSON object on stdout |

**Output** — machine channel. The first line is the outcome token alone: `drift`, `clean` or
`bootstrap`. On `drift`, one **tab-separated** line per candidate follows: `<phrase>`, `<hits>`,
`<first-surface>`.

`hits` is the number of distinct commits in the range whose subject or body contains the phrase.
Order is `hits` descending, ties broken by the phrase ascending byte-wise; `--limit` then takes the
first `n`. `first-surface` is the repo-relative path of the first file, in `git diff --name-only`
order, changed by the earliest commit contributing a hit.

With `--json`, one object with keys `outcome`, `candidates` (array of `{phrase, hits, firstSurface}`,
empty unless `outcome` is `drift`), `reason` (string or `null`), `sinceCommit`, `scannedCommits`,
`declaredKeys`.

**Candidate extraction** — deterministic, and stated in full so two implementers agree:

1. **The range.** `sinceCommit` is the newest commit that touched the resolved register file. The
   range is `sinceCommit..HEAD`.
2. **The text.** For each commit in the range, its subject and body.
3. **Phrases.** Every double-quoted or backticked span, plus every 2-word and 3-word n-gram of the
   subject line. Tokens are split on runs of characters outside Unicode letter, digit, `-` and `_`.
4. **Filter.** Drop any phrase whose every token is a stopword, and any phrase containing a token
   shorter than 3 characters that is not itself a declared key.
5. **Suppression.** Drop a phrase whose `normalizeKey` **equals** a declared key of the selected
   register(s). Suppression is **equality on the normalized key, never substring containment in
   either direction.**

**Stopwords** — exactly the list in
[`src/adr/sweep.ts`](../../../../packages/fabrika-cli/src/adr/sweep.ts), imported rather than
restated, so the two term-extraction surfaces cannot drift apart. **That list is module-private
today (`const STOPWORDS`), so this contract requires the implementer to `export` it** and import the
set here — a one-line change to a shipped module, and the alternative is a second copy of a list that
then drifts.

**Import the set and nothing else.** `sweep.ts` also exports `tokenize`, which splits on
`[^a-z0-9]+` after lowercasing — the ASCII-only behaviour this verb's Grounding names as the reason
every Turkish product noun was invisible to v1. Reusing it would re-import the exact defect step 3
exists to fix. Step 3's Unicode split is this group's own.

**Scope** — every commit in `sinceCommit..HEAD` touching `--paths`, and the declared keys of the
selected register(s). The scope line goes to stderr on every run, naming `sinceCommit`, the commit
count and the declared-key count.

**The three outcomes, disjoint by construction.**

- **`bootstrap`** — `--dir` was read, and it holds no register file for the selected register, or one
  that parses to zero rows. Both are facts about an adopting repo, not failed reads (#4776 makes
  working in a foreign repo a release criterion). A `--dir` that could not be read at all is
  UNKNOWN, and that is exit `11` — the distinction is the directory, not the file.
- **`clean`** — the range was computed and every candidate was suppressed or filtered.
- **`drift`** — at least one candidate survived.

**The `reason` string is fixed text, byte for byte**, because a caller may grep it:

| Outcome | `reason` |
|---|---|
| `bootstrap`, file absent | `no register at <path> — this repo has not adopted one yet, which is bootstrap, not empty drift` |
| `bootstrap`, file empty | `the register at <path> parsed to 0 rows — bootstrap, not empty drift` |
| `clean` | `swept <n> commit(s) since <sha>; every candidate was already declared — this is a clean sweep, not an unread range` |
| `drift` | `null` |

The same sentence reaches stderr as `glossary drift: <reason>.`

**Exit status**

| Code | Trigger |
|---|---|
| `0` | an outcome token was produced on stdout |
| `4` | the register was read but its table structure is unparseable, so the declared set is UNKNOWN |
| `7` | `--paths` was given and matched zero tracked files, so the diff scanned nothing |
| `10` | `--register` carried a value off its closed enum |
| `11` | `--dir` could not be read, or the commit range could not be computed |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary drift: cannot read <dir>: <reason> — the declared set is UNKNOWN, never "0 declared".` | 11 | refusal |
| `glossary drift: --paths <value> matched 0 tracked files — refusing to report a clean sweep of nothing (ADR 0092).` | 7 | refusal |
| `glossary drift: cannot resolve the commit that last changed <path>: <reason> — the range is UNKNOWN, never "never committed".` | 11 | refusal |
| `glossary drift: <path> has no parseable term table — the declared set is UNKNOWN.` | 4 | refusal |
| `glossary drift: --register "<value>" is not one of terms, language, both.` | 10 | usage error |

**Examples**

The two outcomes whose every printed byte is derivable from this spec — an absent register, and a
register that exists with nothing outstanding against it:

```
$ fabrika glossary drift --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/empty
bootstrap
$ echo $?
0
```

```
$ fabrika glossary drift --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers --paths claude-plugins/fabrika/skills/glossary/evals/fixtures
clean
$ echo $?
0
```

The pathspec names a directory that exists and is tracked. **A `--paths` that matches nothing is exit
`7`, not `clean`** — a pathspec pointed at a layout the repo does not have is precisely how v1
reported "no drift" forever, and answering `clean` there would rebuild that defect on the flag after
removing it from the default:

```
$ fabrika glossary drift --paths no/such/dir
glossary drift: --paths no/such/dir matched 0 tracked files — refusing to report a clean sweep of nothing (ADR 0092).
$ echo $?
7
```

With `--json`, the same `clean` run carries the pinned `reason` and the counts the outcome is only
readable against:

```
$ fabrika glossary drift --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers --paths claude-plugins/fabrika/skills/glossary/evals/fixtures --json
{"outcome":"clean","candidates":[],"reason":"swept 0 commit(s) since 0000000000000000000000000000000000000000; every candidate was already declared — this is a clean sweep, not an unread range","sinceCommit":"0000000000000000000000000000000000000000","scannedCommits":0,"declaredKeys":5}
```

`declaredKeys` is `5` because the fixture register's six rows normalize to five distinct keys — the
planted `pano` duplicate collapses, which is the point of counting keys rather than rows.
`sinceCommit` is shown as the all-zero sha only to keep this example free of a real commit id, and a
live run prints the sha that last touched the register.

A `drift` run's `hits` and `first-surface` are computed over the commit range
`sinceCommit..HEAD`, which moves with the repository. **The following two data lines are sample
data, not a reproducible run** — the line *grammar* is the contract, the values are not, and pinning
a number here would be the defect ADR
[0247](../../../../.decisions/0247-a-spec-example-value-is-derivable-or-absent.md) names, where a
reader treats an unverifiable number as a contract:

```
drift
capture ledger	3	src/capture/ledger.ts
retry budget	2	src/net/retry.ts
```

```
$ fabrika glossary drift --dir /nonexistent
glossary drift: cannot read /nonexistent: ENOENT — the declared set is UNKNOWN, never "0 declared".
$ echo $?
11
```

The message names the **directory**, because that is where the distinction lives: a `--dir` that
cannot be read is UNKNOWN, while a `--dir` that reads and holds no register file is `bootstrap` on
exit `0`. A message naming the file would blur the two states this verb exists to keep apart.

Note the two absences are different answers: a `--dir` that cannot be read is exit `11`, while a
readable directory holding no register file is `bootstrap` on exit `0`.

**Grounding**

- v1's `glossary-drift.sh` laundered a failed `git log` into a confident verdict: it captured the
  commit into `LAST` without checking the status, then read an empty `LAST` as "never committed" and
  exited 4 (BOOTSTRAP). A shallow clone — `actions/checkout`'s default depth — reproduces that on a
  register that *is* committed, sending a caller to regenerate a populated file. Here an unresolvable
  range is exit `11` and `bootstrap` is reachable only from a file that was read.
- v1's script also printed nothing at all on a clean sweep, making "no drift" byte-identical to a run
  that died early; the `clean` token and its pinned `reason` exist for that.
- v1 defaulted the diff to the literal pathspec `apps packages`, so any repo with a different layout
  got a permanently empty diff that read as "no drift" (#4776). `--paths` defaults to the whole tree.
- The v1 CLI tool's tokenizer was `/\b[a-z][a-z-]+\b/g`, which excludes uppercase and all non-ASCII —
  so every Turkish product noun the glossary exists for was structurally invisible (#4481). Step 3
  splits on Unicode letter classes instead.
- The same tool suppressed a candidate when a declared term contained it **or** it contained a
  declared term. Against a 226-row register most short candidates contain some declared key, which
  inverts the stated recall bias; measured precision across four fires was about 10% (#4481). Step 5
  is equality on the normalized key.
- ADR 0128 — glossary maintenance stays off the fail-closed per-PR gate. This verb reports; it never
  reds a merge.

---

## `glossary lookup`

**Invocation**

```
fabrika glossary lookup "front door" [--register <terms|language|both>] [--dir <path>] [--json]
```

One or more terms may be given; each produces one line, in argument order. One read serves them all.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<term>...` | positional string, repeatable | yes | — | the terms to resolve against the register(s) |
| `--register` | enum `terms\|language\|both` | no | `both` | which register(s) to resolve against |
| `--dir` | string | no | `.glossary` | the directory holding the registers |
| `--json` | boolean | no | `false` | emit a JSON array instead of the line grammar |

**Output** — machine channel. One **tab-separated** line per term: `<state>`, `<register>`,
`<section>`, `<matched>`.

| `state` | `register` | `section` | `matched` |
|---|---|---|---|
| `declared` | `terms` or `language` | the section heading text, verbatim | the declared first cell, verbatim |
| `collision` | the register of the first overlapping key | that key's section | every overlapping declared cell, comma-separated, in file order |
| `absent` | `-` | `-` | `-` |

With `--json`, a **JSON array** — one object per term, in argument order, with keys `term`,
`normalized`, `state`, `register`, `section`, `matched` (array). An array rather than JSON-lines, so
one term and many terms parse identically.

**`declared` beats `collision` beats `absent`.** A term whose normalized key equals a declared key is
`declared` even when it also overlaps others. With `--register both`, TERMS is searched before
LANGUAGE and the first `declared` wins; a term declared in **both** registers is still reported once,
as `declared` in TERMS, and is a defect `glossary check` reports separately — one term, one register
(#4465).

**All three states are answers on exit 0.** `absent` means *proven absent against a register that was
read* — never what a failed read prints.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | a state line was produced for every term given |
| `4` | a selected register has no parseable term table, so membership is UNKNOWN |
| `10` | `--register` carried a value off its closed enum |
| `11` | a selected register could not be read, so every state is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary lookup: cannot read <path>: <reason> — every state is UNKNOWN, never "absent".` | 11 | refusal |
| `glossary lookup: <path> has no parseable term table — membership is UNKNOWN, never "absent".` | 4 | refusal |
| `glossary lookup: --register "<value>" is not one of terms, language, both.` | 10 | usage error |
| `glossary lookup: no term given.` | 1 | usage error |

**Scope** — every parsed row of the selected register(s). A register that exists and holds zero rows
is a fact and answers `absent` for every term, for the same reason `drift` answers `bootstrap`; the
scope line names the row count per register so a caller can tell that from a populated corpus.

**Examples**

Every example resolves against the committed fixture register, never the host repo's live one, so
each printed cell reproduces:

```
$ fabrika glossary lookup "pano" --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
declared	terms	Core / shape	pano
```

`pano` is declared twice in that fixture; TERMS is searched in file order and the first hit wins, so
the `Core / shape` row is reported. The duplication itself is `glossary check`'s finding, not
`lookup`'s.

```
$ fabrika glossary lookup "tag" --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
collision	terms	Indexing	Database (tag)
```

The parenthetical is a qualifier, so `tag` is not `declared` — it is reported as overlapping and the
skill judges whether the two are one term.

```
$ fabrika glossary lookup "de-po" "capture ledger" --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
declared	terms	Products (domains)	depo
absent	-	-	-
```

`de-po` matches the declared `depo` because normalization folds hyphens away before comparing.

**Grounding**

- #4206 — `glossary-drift` had no duplicate-term check and a same-anchor coining collision landed
  silently; `pitch` and `appetite` were each defined twice (#4205). Triage verified that reusing v1's
  alias-splitting produced three false positives (`tag` vs `Database (tag)`, four `(eval-harness)`
  rows, two `(crew-role kind)` rows), which is why the whole cell is one key here.
- #4481 — v1's `normalize` folded case and whitespace but not hyphens, so a declared `front-door`
  never suppressed `front door`.
- ADR 0246 — a term with two live senses is disambiguated by namespace and keeps its name, so a
  collision is a question for the skill, not something a verb resolves.

---

## `glossary sections`

**Invocation**

```
fabrika glossary sections [--register <terms|language|both>] [--dir <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--register` | enum `terms\|language\|both` | no | `terms` | which register's sections to list |
| `--dir` | string | no | `.glossary` | the directory holding the registers |
| `--json` | boolean | no | `false` | emit a JSON array instead of the line grammar |

**Output** — machine channel. One **tab-separated** line per section, in file order: `<register>`,
`<section>`, `<rows>`. With `--json`, an array of `{register, section, rows}`.

**A heading is a line matching `^##[ \t]+\S`** — the space after the hashes is required by the
markdown spec and is load-bearing here. `TERMS.md` contains a line beginning `#3227).` inside a
prose paragraph; a scan for `^#` reports it as a phantom section. A section's rows are the table rows
between its heading and the next heading of level 1 or 2, excluding the header row and the
`---` separator row, and prose paragraphs between the heading and the table are skipped rather than
treated as rows.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | one line per section was produced, or the register is empty (see Scope) |
| `4` | the register is non-empty, holds no `^##[ \t]+\S` heading, **and** carries table rows — content that exists under no section |
| `10` | `--register` carried a value off its closed enum |
| `11` | the register could not be read |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary sections: cannot read <path>: <reason> — the section list is UNKNOWN, never empty.` | 11 | refusal |
| `glossary sections: <path> carries <n> table row(s) under no "## " heading — the section list is UNKNOWN.` | 4 | refusal |
| `glossary sections: --register "<value>" is not one of terms, language, both.` | 10 | usage error |

**Scope** — the selected register file(s). A file that **does not exist, or exists and is empty of
headings**, prints the single line `-\tbootstrap\t0` and exits `0`: an adopting repo has no sections
yet, and that is an answer. The scope line on stderr names the file and its byte length.

**There is no exit-0-with-empty-stdout path.** A zero-byte register still prints the `bootstrap`
line, because an answer that prints nothing is byte-identical to a verb that never ran (interface
rule 2). Exit `4` is reserved for a file that is non-empty, holds no `^##[ \t]+\S` heading, **and**
carries table rows — content the verb can see but cannot place under any section.

**Examples**

```
$ fabrika glossary sections --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
terms	Core / shape	2
terms	Products (domains)	3
terms	Indexing	1
```

```
$ fabrika glossary sections --register terms --dir /tmp/fresh-repo/.glossary
-	bootstrap	0
$ echo $?
0
```

**Grounding**

- The phantom-heading case is real in this repo's own register, not hypothetical: `.glossary/TERMS.md`
  carries a paragraph line starting `#3227).` and a `^#` scan counts it as a section.
- A register's sections are data that grows with the repo, so the skill reads them rather than
  carrying a list that rots — the same reason the verb index is derived from the registry rather than
  hand-maintained (interface convention rule 1).

---

## `glossary add`

**Invocation**

```
fabrika glossary add "front door" --register terms --section "fabrika skill nouns" --definition-file -
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<term>` | positional string | yes | — | the term, written into the row's first cell verbatim |
| `--register` | enum `terms\|language` | yes | — | which register to write; `both` is refused, since a term has one register |
| `--section` | string | yes | — | the section heading to insert under, matched verbatim against the live headings |
| `--definition-file` | string | yes | — | the file holding the definition cell, or `-` for stdin |
| `--not-file` | string | no | none | a file holding the `Not` cell; omitted means an empty third cell |
| `--replace` | boolean | no | `false` | rewrite the existing row for this term instead of refusing on collision |
| `--create-section` | boolean | no | `false` | create `--section` at the end of the register when it does not exist, instead of refusing with `13` |
| `--dir` | string | no | `.glossary` | the directory holding the registers |
| `--json` | boolean | no | `false` | emit the edit record instead of the line grammar |

**Output** — machine channel. One **tab-separated** line: `<action>`, `<path>`, `<section>`,
`<line>` — where `action` is `added` or `replaced` and `line` is the 1-based line number the row now
occupies. With `--json`, one object with keys `action`, `path`, `section`, `line`, `term`,
`normalized`.

**Placement.** The row is inserted so the section's rows are in ascending `normalizeKey` order,
compared with `Intl.Collator("en", {sensitivity: "base"})`. Where the section's existing rows are
**not** already sorted, the row is placed at the first position that keeps it ordered relative to its
immediate neighbours, and a note goes to stderr naming the section as unsorted — the verb never
re-sorts rows it was not asked to write.

**Cell escaping.** A literal `|` in any cell is written as `\|`, and every newline is replaced with a
single space, because a table row is one line. A definition that is empty after this normalization is
exit `14`.

**`--create-section` appends a new section** — a blank line, the `## <section>` heading, the
`| Term | Definition | Not |` header, the `|---|---|---|` separator, and the row — at the end of the
register, and reports `added`. It is the only path that writes more than one line, so the invariant
below admits exactly that five-line block when the flag is given and the section is genuinely
absent. Sections are never reordered.

**The one-row invariant, enforced in code.** The verb reads the file, composes the new text, and
asserts before writing that the result differs from the original in exactly one added line (`added`)
or one changed line (`replaced`) and nowhere else — or, under `--create-section`, in exactly the
five appended lines above and nowhere else. Any other diff shape aborts the write with exit
`15` and nothing is written. This is the deterministic test the implementation owes, and it is what
makes "change only the affected rows, do not re-sort the file" a mechanism rather than a hope.

**Read-back.** After writing, the file is re-read and the row at the reported line is parsed back. If
its three cells do not match what was composed, the verb exits `9` — the write landed and the result
is not what was intended, which is a different fact from a write that failed (`8`).

**Exit status**

| Code | Trigger |
|---|---|
| `0` | the row was written and the result is on stdout |
| `3` | `--definition-file -` was given and stdin held nothing |
| `4` | the register has no parseable table under `--section` |
| `8` | the write failed; the register's state is UNKNOWN |
| `9` | the write landed and the read-back does not match what was composed |
| `10` | `--register both` was given, or a closed-enum flag carried an off-enum value |
| `11` | a precondition read failed — the register, or `--definition-file`, could not be read; nothing was written |
| `12` | the term is already declared and `--replace` was not given |
| `13` | `--section` names no heading in the register |
| `14` | the composed row cannot be a well-formed table row |
| `15` | the write would have changed a line outside the target row — aborted, nothing written |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary add: <term> is already declared in <register> under "<section>" — pass --replace to rewrite it.` | 12 | refusal |
| `glossary add: "<section>" is not a section of <path> — run "fabrika glossary sections" for the live list.` | 13 | refusal |
| `glossary add: the definition is empty after normalization — refusing to write a blank row.` | 14 | refusal |
| `glossary add: stdin held nothing.` | 3 | refusal |
| `glossary add: --register both is not writable — a term belongs to one register.` | 10 | usage error |
| `glossary add: cannot read <path>: <reason> — nothing was written.` | 11 | refusal |
| `glossary add: cannot write <path>: <reason> — the register's state is UNKNOWN, re-read it before retrying.` | 8 | refusal |
| `glossary add: wrote <path> and the read-back differs at line <n> — the register may be inconsistent.` | 9 | refusal |
| `glossary add: the edit would have changed <n> line(s) beyond the target row — aborted, nothing written.` | 15 | refusal |
| `glossary add: <path> has no parseable table under "<section>" — the insertion point is UNKNOWN, nothing written.` | 4 | refusal |
| `glossary add: cannot read --definition-file <path>: <reason> — nothing was written.` | 11 | refusal |
| `glossary add: --replace was given and <term> is not declared in <register> — refusing to rewrite a row that does not exist.` | 12 | refusal |

**Precedence among the refusals, so two implementers order them the same way.** Checks run:
`--register both` (`10`) → the register reads (`11`) → `--section` exists (`13`) → that section holds
a parseable table (`4`) → the definition source reads and is non-empty (`11`, then `3`) → the
composed row is well formed (`14`) → the collision test (`12`) → the write (`8`) → the one-row
assertion (`15`) → the read-back (`9`). So a bad `--section` reports `13`, never `4`; `4` fires only
when the section heading exists and its table does not.

**`--replace` on an absent term is exit `12`, not a silent add.** The flag asks to rewrite a specific
row; if that row is not there, the caller's belief about the register is wrong and adding anyway
would hide it.

**Scope** — not a judging verb. It reads one register and writes one row in it.

**Examples**

Both run against the committed fixture register, so the section, the ordering and the resulting line
number all reproduce. `capture ledger` sorts before `depo`, so it lands as the first row of the
`Products (domains)` table:

```
$ printf 'The append-only record of one capture run.' | fabrika glossary add "capture ledger" --register terms --section "Products (domains)" --definition-file - --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
added	claude-plugins/fabrika/skills/glossary/evals/fixtures/registers/TERMS.md	Products (domains)	18
```

Line `18` is derivable from the committed fixture: `## Products (domains)` is line 14, line 15 is
blank, the column row is 16, the separator 17, and the section's three data rows are `depo` (18),
`pano` (19), `sozluk` (20). `capture ledger` sorts before `depo`, so it takes that first data-row
position — line 18 — and the three rows below shift down by one. Against any other corpus the number
is whatever that corpus makes it, which is why the example pins a fixture rather than the live
register.

```
$ printf 'x' | fabrika glossary add "pano" --register terms --section "Core / shape" --definition-file - --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
glossary add: pano is already declared in terms under "Core / shape" — pass --replace to rewrite it.
$ echo $?
12
```

With `--replace`, the same invocation rewrites that row and reports the action:

```
$ printf 'The board product.' | fabrika glossary add "pano" --register terms --section "Core / shape" --definition-file - --replace --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers
replaced	claude-plugins/fabrika/skills/glossary/evals/fixtures/registers/TERMS.md	Core / shape	11
```

**Grounding**

- v1's CLI trusted the response of the write it made and never re-read the artifact; the read-back
  and exit `9` exist so "wrote it" and "it is there" stay separate facts.
- The one-row assertion is the `adr supersede` idiom (its exit `6`), reseated here on this group's
  `15`. A group allocates its own seat for a shared refusal rather than importing a sibling's private
  number.
- #4727 — the `control-plane` row defined itself by a retired model and its `Not` column excluded the
  sanctioned path. `--replace` exists because a register that can only be appended to accumulates
  wrong answers.

---

## `glossary check`

**Invocation**

```
fabrika glossary check [--register <terms|language|both>] [--dir <path>] [--decisions <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--register` | enum `terms\|language\|both` | no | `both` | which register(s) to check |
| `--dir` | string | no | `.glossary` | the directory holding the registers |
| `--decisions` | string | no | `.decisions` | the decision-record directory citations resolve against |
| `--json` | boolean | no | `false` | emit the check result as one JSON object on stdout |

**Output** — machine channel. The first line is the outcome token alone: `clean`, `defects` or
`bootstrap`. On `defects`, one **tab-separated** line per finding follows: `<kind>`, `<register>`,
`<section>`, `<term>`, `<detail>`.

`kind` is a closed set:

| `kind` | Fires when |
|---|---|
| `row-shape` | the row does not have exactly three cells, or a cell is empty where the shape requires content |
| `duplicate-key` | two rows in the selected registers share a `normalizeKey` |
| `cross-register` | one key is declared in both TERMS and LANGUAGE — one term, one register (#4465) |
| `out-of-order` | a row precedes a row that sorts before it within its section |
| `citation-dead` | a cited `NNNN` decision id has no record under `--decisions` |
| `citation-superseded` | a cited record exists and its frontmatter `status:` is not live |
| `citations-unverified` | `--decisions` could not be read, so no citation in scope was resolved |

A citation is a four-digit token in a row's second or third cell. **Live** is decided by importing
`isLive` from [`src/adr/records.ts`](../../../../packages/fabrika-cli/src/adr/records.ts) rather than
restating it, so the two groups cannot disagree about what a status word means. That function admits
exactly three arms — the status is `accepted`, or exactly `amended-in-part`, or begins
`amended-in-part by`. A looser paraphrase such as "begins `amended-in-part`" is **wrong**: it would
call `amended-in-part (0250)` live where the imported predicate does not.

**`detail` is fixed text per `kind`**, because a caller may grep it:

| `kind` | `detail` |
|---|---|
| `row-shape` | `expected 3 cells, found <n>` — or `cell <1\|2> is empty` |
| `duplicate-key` | `also declared in "<section>"` — naming the **earlier** occurrence; the finding is reported against the **later** row |
| `cross-register` | `also declared in <register> under "<section>"` |
| `out-of-order` | `sorts before "<the preceding row's term>"` |
| `citation-dead` | `cites <NNNN>, no record under <decisions-dir>` |
| `citation-superseded` | `cites <NNNN>, status "<the frontmatter status line, verbatim>"` |
| `citations-unverified` | `cannot read <decisions-dir>: <reason>` |

**`row-shape` requires content in cells 1 and 2 only.** The third cell — `Not` — is legitimately
empty on most rows and an empty one is never a finding; the fixture register carries two such rows
deliberately.

With `--json`, one object with keys `outcome`, `findings` (array of
`{kind, register, section, term, detail}`), `reason` (string or `null`), `scannedRows`,
`scannedRegisters`, `citationsResolved`.

**All three outcomes are answers on exit 0**, because the outcome is this verb's own verdict and a
caller must never read its own finding list as a failed run — the mistake v1's `adr-sweep` made by
exiting non-zero on the one case it was asked to produce (#4723).

**The `reason` string is fixed text, byte for byte:**

| Outcome | `reason` |
|---|---|
| `bootstrap` | `no register at <path> — nothing to check yet, which is bootstrap, not clean` |
| `clean` | `checked <n> row(s) across <m> register(s); no defect found` |
| `defects` | `null` |

**Scope** — every parsed row of the selected register(s), plus every decision record under
`--decisions` that a row cites. The scope line goes to stderr naming the row count per register and
the number of citations resolved.

**Zero scope is a red for this verb, with one carved-out exception.** A selected register that is
present and parses to **zero rows** is exit `7`: a check that scanned nothing must never report
`clean` (ADR 0092). The exception is a register file that is **absent**, which is `bootstrap` on exit
`0` — an adopting repo has not written one yet, and refusing there would leave a fresh repo unable to
run the skill at all (#4776, and the same reasoning that made an empty `.decisions/` answer `0001`
rather than refuse in #5254). Present-and-empty and absent are different facts and never share a
code.

**Two defect classes this verb deliberately does not report**, because each is already decided by a
merge-blocking gate and a second answer could contradict it: **machine-local paths** in the register
(`leak-guard scan`, on `pull_request` and `merge_group`) and **dead internal links**
(`doc-links`, `lychee --offline` repo-wide, fail-closed on zero scope). The skill states the
expectation that those gates hold; it does not recompute their verdicts.

**Exit status**

| Code | Trigger |
|---|---|
| `0` | an outcome token was produced on stdout |
| `4` | a selected register was read and has no parseable term table |
| `7` | a selected register is present and holds zero rows — refusing to report a clean scan of nothing |
| `10` | `--register` carried a value off its closed enum |
| `11` | a selected register could not be read, so the outcome is UNKNOWN |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `glossary check: cannot read <path>: <reason> — the outcome is UNKNOWN, never "clean".` | 11 | refusal |
| `glossary check: <path> has no parseable term table — the outcome is UNKNOWN.` | 4 | refusal |
| `glossary check: <path> holds 0 rows — refusing to report a clean scan of an empty register (ADR 0092).` | 7 | refusal |
| `glossary check: --register "<value>" is not one of terms, language, both.` | 10 | usage error |

**Examples**

Both the register and the decision corpus are committed fixtures in this skill's tree, so every
printed byte reproduces:

```
$ fabrika glossary check --register terms --dir claude-plugins/fabrika/skills/glossary/evals/fixtures/registers --decisions claude-plugins/fabrika/skills/glossary/evals/fixtures/decisions
defects
duplicate-key	terms	Products (domains)	pano	also declared in "Core / shape"
citation-superseded	terms	Core / shape	worker	cites 0950, status "superseded by [0951](0951-depo-internal-asset-store.md)"
$ echo $?
0
```

The fixture register plants exactly those two defects: `pano` is declared under both `Core / shape`
and `Products (domains)`, and the `worker` row cites `0950`, whose fixture record carries a
superseded status line. `depo` and `sozluk` are clean rows, so the finding list is the whole verdict
rather than a truncation.

```
$ fabrika glossary check --register terms --dir /tmp/fresh-repo/.glossary
bootstrap
$ echo $?
0
```

**Grounding**

- ADR 0092 — a judging verb reds on zero scope; exit `7` is that rule for a register that exists and
  holds nothing. The absent-file carve-out follows #5254's reasoning, where refusing on a
  legitimately empty corpus left an adopting repo unable to mint its first record.
- #4723 — v1's sweep exited non-zero on its own informative case, so a caller read a produced answer
  as a failure. All three outcomes here exit `0`.
- #5104, #5274, #4702 — a row lands only after its coining decision is on `main`, and decision
  numbers are not stable before merge (three lanes each derived `0253`, #5278). `citation-dead` is
  how a row that jumped the gun is found afterwards.
- #4727 — a row can go stale against a superseding decision with nothing detecting it;
  `citation-superseded` is that detection.
- #4465 — one term, one register, one row. `cross-register` is that rule made mechanical.
- The leak and link carve-outs are the interface convention's rule 6 consequence — where a question is
  already enforced, state the expectation and leave the verdict where it is enforced.

## Required repo files

The skill's table is the declaration front-door parses; this one states the **code each disposition
fires**, which is the half an implementer needs. Every path is resolved against the target repo's
root, never against the installed plugin, because a register is the adopting repo's artifact and not
fabrika's.

| Must exist | Why this skill needs it | When missing |
| --- | --- | --- |
| `.glossary/TERMS.md` | the domain-noun register every verb reads and `add` writes | **bootstrap** — `drift`, `check` and `sections` answer `bootstrap` on exit `0`; `lookup` answers `absent` for every term; `add` refuses `11` until `init` creates it. A `--dir` that cannot be read is `11` throughout. |
| `.glossary/LANGUAGE.md` | the architecture-vocabulary register, and the second half of `--register both` | **bootstrap** — under `both` the absent register contributes `bootstrap` and the present one still answers on exit `0`; the scope line names which register degraded. Never `11` for absence alone. |
| `.decisions/` | resolves the four-digit citations a row carries, so `check` can separate a live decision from a superseded one | **degrade** — `check` emits a `citations-unverified` finding carrying `cannot read <dir>: <reason>` and still reports its other findings, landing on `defects` rather than `clean`. It never reports `clean` over an unresolved corpus. |
| A merge-blocking leak gate and dead-link gate over changed markdown | `check` deliberately computes neither, deferring both to whichever gate enforces them | **degrade** — no verb changes behaviour; the two classes simply go unchecked, and the skill's report is where that is disclosed. There is no code, because there is nothing for a verb to detect. |
