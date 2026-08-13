# `/prototyping` — derived CLI contract

**Skill:** [`prototyping`](SKILL.md) · **Authoring brief:** [#5020](https://github.com/kamp-us/phoenix/issues/5020) · **Date:** 2026-08-10

The verbs land in `packages/fabrika-cli/` under the **`spike`** subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` beside the shipped groups (at the time of writing `adr`,
`build`, `epic`, `hook`, `ledger`, `plan`, `report`, `review`, `review-ui`, `ship`, `spend`,
`triage`, `ui`, `wire` — that list grows most weeks, so read the file rather than this sentence).
The [CLI interface convention](../../docs/cli-interface-convention.md) governs every verb; where this
spec and that doc disagree, the doc wins and this spec is the bug. **None of these verbs exist yet** —
this spec is greenfield. `spike` is the group name because it is the noun a caller already uses for
the artifact, and it was free in the registry when this was written.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR
[0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). The v1 prior art —
`claude-plugins/kampus-pipeline/skills/wayfinder/` and its three scripts, plus `pipeline-cli`'s
`scratchpad`, `worktree-guard`/`reap`/`sweep`, `wayfinder-map` and `leak-guard`/`redact-leaks` — was
**read** for semantics and scars, and none is invoked, wrapped, or deferred to. Nothing under
`claude-plugins/kampus-pipeline/` or `packages/pipeline-cli/` appears in any fence in this spec or
in the `SKILL.md`.

**This is a standalone group with no cross-contract reuse.** It borrows no sibling's verbs. The
`wayfinding` skill ([#5242](https://github.com/kamp-us/phoenix/pull/5242), landed) is *one caller*
and directs the model here for an empirical frontier question — but the caller seam below is stated
**from this side only**, and deliberately so: `prototyping` is standalone-first (#5017), so a seam
defined by one caller's shape would be wrong for every other. Nothing here depends on that
contract's verbs, which is what keeps the two independently implementable.

**What fabrika already ships, reused by import — never respecified:**

- `packages/fabrika-cli/src/verb.ts` — `answer` / `refuse`. A non-zero exit prints nothing on stdout.
- `packages/fabrika-cli/src/report/codes.ts` — the alignment base for seats `3`–`11`; the new `spike`
  table registers in `packages/fabrika-cli/src/exit-code-alignment.ts` and in that file's unit test's
  `TABLES` map, or the suite reds.
- `packages/fabrika-cli/src/report/leaks.ts` — `scanBody` / `isBareAtReference` / `renderLeaks`.
  Every body this group posts passes through them. **A second leak predicate is worse than either
  alone** (`packages/fabrika-cli/src/review/authored.ts:14-15`), so none is derived here.
- `packages/fabrika-cli/src/report/compose.ts` — `normalizeForReadback` (read the body; the docblock
  understates it — it strips trailing newlines too). Every read-back compares through it.
- `packages/fabrika-cli/src/review/authored.ts` — `readAuthored`, the parameterized stdin+leak guard
  that already seats unread→`1`, empty→`3`, bare-`@`→`6`.
- `packages/fabrika-cli/src/build/target.ts` — `resolveTargetRepo`, which owns the `--repo` default
  and the `origin`-remote parse. No verb here re-derives that parse.
- `packages/fabrika-cli/src/io/` — `exec`, `fs`, `git`, `github`, `issues`, `json`, `stdin`. In
  particular `io/issues.ts`'s `Existence<A>` (`present` / `absent` / `unknown`), which is the
  shipped shape of this group's `7`-versus-`11` split.
- `packages/fabrika-cli/src/excess-operand.ts` — `leafCommand`. Every leaf declares the hidden
  trailing catch-all through it, never bare `Command.make`.

## Considered and deliberately not derived

Each of these is either judgment the wrapper keeps, an answer already enforced elsewhere, or a
wrapper whose only behaviour would be relaying an upstream answer (interface convention rule 6;
ADR 0238).

- **A verb that writes the prototype.** What to build is the judgment this skill exists to carry. A
  verb that generated the artifact would be a stochastic answer wearing a deterministic exit code.
- **A verb that decides whether a question is empirical, or whether it is one question.** Same
  reason. The verbs prove the mechanical half — exactly one `--question` operand, on-grammar, no
  leaked path — and the skill owns "would running something settle this?".
- **A verdict marker, and any `ship gate` namespace.** Checked rather than assumed: `prototyping` is
  a member of none of the shipped closed sets — not `NAMESPACE` or `NAMESPACE_PREFIXES`
  (`packages/fabrika-cli/src/wire/verdict-marker.ts:73,78`), not `SHIP_NAMESPACES` or
  `SHIP_CLASS_NAMES` (`packages/fabrika-cli/src/review/classes.ts:161,93`). **It does not need to
  be, and this spec proposes widening none of them**: this group gates no merge, judges no pull
  request, and emits no verdict. A `spike` marker in that namespace would be one `wire read` could
  never read back, which is the hazard that file's own docblock names. The HTML-comment markers
  below are this group's own, live only in issue comments, and enter no wire registry.
- **An eval corpus stage.** Moot: the eval corpus and its stage vocabulary were removed with the
  rest of the eval tooling ([#5510](https://github.com/kamp-us/phoenix/issues/5510)). The ideation
  layer needed a stage the corpus never admitted
  ([#5241](https://github.com/kamp-us/phoenix/issues/5241)); there is no corpus to admit one now.
- **Reusing `build scratch` for the workspace.** Read first, then refused on its preconditions, not
  on taste. `runScratch` requires a session env var, a resolved repo, and a **held `build` claim on
  an issue number**, and derives its nonce *from the claim token*
  (`packages/fabrika-cli/src/build/scratch-verb.ts:60-67`). A spike holds no build claim, so the
  verb would refuse on every real target. (Its keying is *not* the objection: that module's own
  docblock records the claim nonce as exactly what makes the namespace per-lane by construction, and
  this group's nonce does the same job from a different source.)
- **A git worktree as the isolation primitive.** A worktree is inside the repository's own graph and
  its lifecycle is contested: reapers have removed live agents' trees mid-run (#3943), a guarded
  agent whose tree vanished kept running in the primary checkout (#4162), and owner stamps are never
  written on the live path so the signal reapers read has no producer (#4180). A spike does not need
  a git identity — it needs to be *not in the repository at all*. The workspace is a plain directory
  under the OS temp root, and the tree digest below is what proves nothing crossed over.
- **A second machine-local-path scanner.** `report/leaks.ts` is imported. Its recorded
  false-positive is inherited and stated rather than designed around: the scan flags counter-example
  paths quoted in prose (#3785, still an unresolved decision), so a decision body that *quotes* a
  path will refuse on `5`. The expectation is that a decision describes what a path was, it does not
  paste one — which is also what keeps a machine-local path out of a posted body in the first place.
- **A worktree-guard, reaper, or sweep verb.** Those are the fabrika ports tracked at
  [#5194](https://github.com/kamp-us/phoenix/issues/5194)–[#5197](https://github.com/kamp-us/phoenix/issues/5197).
  This group's disposal covers its own workspace and nothing else; a second reaper would contend
  with theirs.
- **A `report`-shaped filing verb for the follow-up build issue.** `report file` already owns intake
  and this group would only relay it. The `SKILL.md` directs the model to fire the `report` Skill.

## The caller seam — stated from this side

Any caller — a human at a keyboard, or a sibling skill whose text directs the model here — supplies
exactly two things, and neither is a fabrika-internal shape:

| Direction | What crosses |
| --- | --- |
| In | The **one named question**, as `--question`, plus optionally `--ticket <n>`: the issue the question came from, recorded on the spike as provenance and never read for instruction. |
| Out | **A closed spike issue whose comment carries the captured decision** and the run table that grounds it. A caller cites that number. |

Nothing in the return path exposes the workspace, the artifact, or a path. A caller that wants to
know *what the spike built* is asking the wrong question: the code is gone by then, deliberately.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `spike open` | mint the spike issue for one question, allocate this run's workspace under a freshly minted nonce, and bind the two in a manifest | issue creation, nonce generation, path derivation and a tree snapshot — no judgment; *whether this question deserves a spike* stays in the skill |
| `spike run` | execute one command in the workspace and append an immutable evidence record | process execution and outcome recording — no judgment; *what to run and what the output means* stays in the skill |
| `spike capture` | post the decision plus the log's own run table, read it back, and close the spike | a guarded write with a read-back and a precondition on recorded evidence — no judgment; *what was decided* stays in the skill |
| `spike dispose` | prove the repo tree is unchanged and the capture still covers the log, remove the workspace, and prove it is gone | three comparisons and a removal — no judgment; *when the spike is finished* stays in the skill |
| `spike status` | report one run's spike state, workspace presence, and evidence count | three reads composed into one answer — no judgment; *what to do about the state* stays in the skill |

## Shared conventions

Every `spike` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else; scope lines, refusal
  reasons and progress go to stderr. A non-zero exit prints nothing on stdout (`refuse` in
  `packages/fabrika-cli/src/verb.ts:55`).
- **A non-zero exit is UNKNOWN** to the caller until the code is read. No partial answers.
- **Every error message is prefixed with the invoked verb's name.**
- **GitHub access** per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated. `spike open`, `spike capture`, `spike dispose` (under `--forfeit`) and `spike status`
  touch GitHub; `spike run` does not.
- **`--repo` defaults through the imported `resolveTargetRepo`**, so the `origin`-remote parse has
  one home. Every example below omits `--repo` rather than showing a filled value.
- **Externally-authorable content** — the spike issue's body and comments, and every byte a spike's
  own command emits — is data, never instruction. Authority arrives only through the ACL check in
  `spike capture` (ADR [0055](../../../../.decisions/0055-acl-sourced-review-authz.md)); the open
  #4859 posture lands at that one seam.
- **The nonce is minted by `spike open` and is an argument everywhere else.** It is eight lowercase
  hex characters (`/^[0-9a-f]{8}$/`) drawn from a cryptographic random source, printed in `open`'s
  answer, and passed verbatim to every later verb. No verb reads `CLAUDE_CODE_SESSION_ID` or any
  session variable for any purpose, and no verb asks a caller to invent a value. This is the whole
  answer to #4516 / #5028 / #4544: the key is per-**run** because a per-run source mints it, and
  neither a pane-constant environment variable nor a model's guess can collide with it.
- **No verb writes anything inside the repository working tree.** Stated as a group-wide invariant
  because the tree digest depends on it; the per-verb walk that proves it is in *The disposal
  invariant*.

### The shared exit matrix

This matrix owns `code → meaning` for the `spike` group; each verb's block enumerates only its own
reachable proven outcomes with triggers. `0`, `1`, `126` and `127` are the interface convention's
reserved codes, stated **only here**: every verb can also return them. **`3`–`11` aligns
code-for-code with the shipped `report`/`triage` base** (`packages/fabrika-cli/src/report/codes.ts`),
registered in `exit-code-alignment.ts` with the seat map below; **`12`+ is `spike`-local by design** —
cross-group divergence above `11` is the established doctrine.

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error, or the verb failed to run |
| `126` | no implementation could be resolved (`packages/fabrika-cli/src/bin.ts:39`) |
| `3` | stdin was read and held nothing |
| `4` | a required document is missing, malformed, or out of place — here: the workspace manifest or the evidence log exists but does not parse |
| `5` | the authored text carries a machine-local path, unredacted |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the write target is **proven** absent — the spike issue, or the `prototyping:spike` label — or the spike is proven already closed when the verb needed it open |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match; the artifact needs a human |
| `10` | a value off its closed vocabulary or naming grammar (an off-grammar `--nonce`, a `--kind` outside `logic`/`ui`, a malformed `--timeout` or `--env`) — a semantic refusal on a *value*; a malformed *flag* stays `1` |
| `11` | a required read or execution failed — no outcome is proven |
| `12` | proven: no workspace exists for this nonce — never opened, or already disposed |
| `13` | proven: the resolved workspace path is inside the repository working tree — refused before anything is written |
| `14` | proven: the evidence log holds zero recorded runs — a decision here would be a self-report |
| `15` | proven: disposal was asked on a spike whose decision is not captured |
| `16` | proven: the workspace was removed and is still present on re-probe |
| `17` | proven: the repository working tree does not match what `spike open` recorded — the spike may have leaked into it |
| `18` | proven: the workspace for this nonce belongs to different work — a manifest naming another spike, or, at open time before a spike is named, a different question or kind |
| `19` | proven: the capture author does not hold `write` or better on the repository (ADR 0055) |
| `20` | proven: the spike issue landed but its manifest could not be completed — the issue exists and the workspace cannot name it |
| `21` | proven: the evidence log moved after the decision was captured — the capture no longer covers the runs |
| `127` | the verb never ran at all (unresolved binary — the shell's code) |

**Seat map for `exit-code-alignment.ts`** — `SPIKE_SEATS` maps this group's exports onto the base's:
`EMPTY_STDIN→EMPTY_STDIN`, `MALFORMED_RECORD→BAD_SECTIONS`, `LEAKED_PATH→LEAKED_PATH`,
`BARE_AT_PATH→BARE_AT_PATH`, `ZERO_SCOPE→NO_TARGET`, `WRITE_UNKNOWN→WRITE_UNKNOWN`,
`READBACK_MISMATCH→READBACK_MISMATCH`, `OFF_VOCABULARY→CLASSIFIED`,
`READ_OR_EXEC_UNKNOWN→PRECONDITION_UNKNOWN`. The group is registered in `ALIGNED_GROUPS`. There is
no `DELIBERATE_GAP`: every seat `3`–`11` is reached by some verb below. **The last name differs
deliberately.** The base's `PRECONDITION_UNKNOWN` covers a failed precondition *read*; this group's
seat also covers a child process that could not be *executed*, which is an attempt rather than a
read. `exit-code-alignment.ts:34-37` records that a group's reading may be a documented
superset and that a number cannot say so on its own; the name is where this one says it.

**`7` versus `11`** is the same split the whole CLI rests on: a proven absence is a verdict, a failed
read is a verdict about nothing. No `spike` verb fuses them, and no message reads "does not exist, or
is not readable". **`12` is deliberately not `7`**: an absent workspace is a routable local state,
not a statement about the issue.

**And the split this group most exists for: `spike run`'s `0` versus its `11`.** Exit `0` means *the
command was executed and its outcome recorded*, whatever the command itself returned — the command's
own status rides in the payload as `commandExit`. Exit `11` means *the command could not be
executed*. A prototype that ran and answered **no** is `0` with a non-zero `commandExit`; a prototype
that could not run is `11` and answers nothing. These are opposite answers and the shipped helpers
make the correct shape the only constructible one: `refuse` hardcodes empty stdout (`verb.ts:55`) and
`answer` hardcodes code `0` (`verb.ts:39`), so a machine payload can only ride exit `0`. A
"ran and answered no" seated on a non-zero code would have to discard the payload that *is* the
answer.

### The workspace grammar — canonical here

```
<tmpRoot>/fabrika-spike/<nonce>/
├── spike.json          the manifest
├── evidence.jsonl      the append-only run log
└── runs/<seq>.out      captured stdout, one file per recorded run
    runs/<seq>.err      captured stderr, one file per recorded run
```

`<tmpRoot>` is the OS temp root, read by the adapter — the one machine fact this group does not
derive. The path is keyed on **`<nonce>` alone**: no session segment, no issue segment, no pid. Two
concurrent spikes carry different minted nonces and therefore different directories, which is the
whole of the collision answer (#4544, #4516, #3607, #5028). The artifact the model writes lives
beside these files; no verb reads it.

<a id="in-tree"></a>**The in-tree test (`13`), stated so two implementers compute one verdict.**
Both paths are resolved physically — symlinks followed, `.` and `..` folded — before any comparison,
and the verb refuses `13` when the resolved workspace path equals the resolved `treeRoot` or begins
with `treeRoot` plus a path separator. This has to be physical: on macOS `/tmp` is a symlink to
`/private/tmp`, so a lexical prefix test gives a different answer than a resolved one, and a repo
checked out under the temp root would pass a lexical test while sitting inside the very tree the
digest measures. `exit-code-alignment.ts:205-208` carries the same scar for the same reason. Every
verb's answer prints the **resolved** path.

**`spike.json` — the manifest.** One JSON object, written by `spike open` and never rewritten after
it is completed:

| Key | Type | Meaning |
|---|---|---|
| `spike` | integer \| null | the spike issue's number; `null` only in the provisional window before the issue lands |
| `nonce` | string | this run's nonce, eight lowercase hex |
| `kind` | `"logic"` \| `"ui"` | the ruled artifact shape |
| `question` | string | the one named question, verbatim |
| `repo` | string | `<owner>/<repo>` the spike was minted in |
| `ticket` | integer \| null | the caller's originating issue, or `null` |
| `treeDigest` | string | 64 lowercase hex — the repository working tree's state at open, defined below |
| `treeRoot` | string | the resolved repository root the digest was taken over |

A manifest that exists but violates this schema — missing key, extra key, off-enum `kind`,
off-grammar `nonce` — is `4`, whole-file. Half a manifest is not a manifest: a verb holding half of
it would compare against a digest it cannot vouch for.

**`evidence.jsonl` — the run log.** One JSON object per line, append-only, never rewritten. `spike
run` appends; nothing else writes it. **The serialization is pinned**, because `evidenceDigest` is
taken over these bytes: keys in exactly the order of the table below, no whitespace between tokens,
one object per line, each line terminated by a single `\n`.

| Key | Type | Meaning |
|---|---|---|
| `seq` | integer | 1-based, incremented from the line count at append time |
| `command` | array of string | the literal argv as executed, `[file, ...args]` |
| `commandExit` | integer \| null | the child's exit status; `null` when it timed out |
| `timedOut` | boolean | the child was killed at `--timeout` |
| `outBytes` / `errBytes` | integer | bytes written to `runs/<seq>.out` and `runs/<seq>.err` — never more than the capture bound |
| `truncated` | boolean | either stream reached the capture bound and the remainder was discarded |
| `outSha256` / `errSha256` | string | 64 lowercase hex over those same captured bytes |

`outBytes` counts what was **stored**, not what the child produced: past the bound nothing further is
read, so a pre-truncation total is not knowable and no field claims to hold one. `truncated` is what
says the stored bytes are not the whole story.

A line that does not parse, or a file whose `seq` values are not contiguous from 1, is `4`.

**The two digests, defined so two implementers compute one number.**

- **`treeDigest`** — run `git status --porcelain=v1 --untracked-files=all --ignored=matching` at
  `treeRoot`, split the output on `\n`, drop the trailing empty element, sort the remaining lines
  byte-wise ascending, join them with a single `\n` after **each** line (so the joined text ends in
  `\n`, and an empty set yields the empty string), and take the SHA-256 of that text's UTF-8 bytes
  as 64 lowercase hex. The empty set therefore digests to the SHA-256 of zero bytes,
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

  **`--ignored=matching` is load-bearing and is the whole reason this is not the default status
  invocation.** A prototype's natural output — a `node_modules/`, a `dist/`, a `.env`, a build
  cache — lands on ignored paths, and a digest blind to them would answer `treeMatched: true` over
  exactly the leak this check exists to find. The one mechanism that turns "throwaway" from prose
  into a property may not have a hole where prototypes most often write.
- **`evidenceDigest`** — the SHA-256 of `evidence.jsonl`'s bytes exactly as they sit on disk, 64
  lowercase hex. It appears in the capture comment, so a decision names precisely the runs that
  existed when it was written, and `spike dispose` re-checks it.

### The comment grammar — canonical here

Three of this group's behaviours turn on recognising a comment, so the predicate is mechanical
rather than prose. Each posted comment's **first line** is an HTML comment and nothing else:

```
<!-- fabrika:spike capture nonce=7f3a9c21 evidenceDigest=<64hex> -->
<!-- fabrika:spike forfeit nonce=7f3a9c21 runs=3 -->
```

**A spike is `captured` when a comment's first line matches the capture marker carrying *this run's
nonce*** — `<!-- fabrika:spike capture nonce=<nonce>` — and where more than one matches, **the
newest by creation time is the one that counts**. Matching on the nonce is what stops another run's
marker answering for this one; naming the newest is what makes `21`'s comparison single-valued once
a supersede has happened. A forfeit marker never satisfies it — otherwise `15` would be bypassable
by forfeiting twice — and no other comment on the issue is read for any purpose.

**The three composed bodies.** The two *comments* are exactly their marker line, a blank line, then
the content below. **The issue body carries no marker** — an issue is found by its
`prototyping:spike` label and its own number, so a marker there would be a second identity to keep in
step with them.

| Body | Content |
|---|---|
| issue body (`spike open`) | `## Question` and the `--question` text; `## Shape` and the `--kind` word; `## Run` and the nonce; `## Came from` and `#<ticket>`, or the literal `standalone` |
| capture comment | `## Decision` and the stdin text verbatim; `## Runs` and a table with one row per evidence line — `seq`, the `command` joined by single spaces, `commandExit` (or `timed out`), and `truncated` — transcribed from `evidence.jsonl`, never re-derived |
| forfeit note (`spike dispose --forfeit`) | `## Abandoned` and the question **read from the manifest** (`dispose` takes no `--question`); `## Runs` and the same table; a closing line stating no decision was reached |

The issue title is `spike: <question>`, truncated at 200 characters on a character boundary with a
trailing `…` when longer.

**The run table is transcribed, not summarised**, and that is the point: a reader sees each recorded
run's command and status beside the claim rather than a hash standing in for them. The
`evidenceDigest` proves the table matches the log; the table is what a human can actually read.

### The disposal invariant — stated because everything downstream leans on it

**`treeDigest` is neutral to every write this group makes.** The claim is checkable by walking each
verb, and the walk is the proof:

| Verb | Writes | Inside `treeRoot`? |
|---|---|---|
| `spike open` | the workspace directory and `spike.json`; the GitHub issue | no — and the path is refused on `13` *before* either write |
| `spike run` | `evidence.jsonl`, `runs/<seq>.out`, `runs/<seq>.err`; whatever the **child command** writes | no, for the verb's own writes. The child is another matter, and that is exactly what the digest exists to catch |
| `spike capture` | one GitHub comment; the issue's state | no |
| `spike dispose` | one GitHub comment under `--forfeit`; removes the workspace | no |
| `spike status` | nothing | no |

Three ordering rules make it hold, and all three are load-bearing:

1. **`spike open` refuses `13` before it creates the workspace or takes the digest.** A workspace
   inside the tree would make its own manifest part of the thing being measured, and the digest
   would then be invalidated by the very operation it exists to protect.
2. **`spike open` creates the workspace before it creates the issue.** Both orders can fail
   halfway; this one fails toward a local orphan directory that `spike dispose` collects, rather
   than toward an orphaned public issue nobody is holding a nonce for.
3. **`spike dispose` compares the tree *before* it removes anything, and before any `--forfeit`
   write.** A `17` therefore leaves the workspace intact for inspection and posts nothing. Removing
   first and reporting after would destroy the evidence of the leak it just found — the #4111 shape.

The one thing the digest deliberately does **not** exclude is the child command's writes. That is
not an oversight: a prototype that wrote into the repository is the exact failure this skill is
built against, and making the check blind to it would leave nothing checking disposability at all.

---

## `spike open`

**Invocation**

```
fabrika spike open --question <text> --kind <logic|ui> [--ticket <n>] [--nonce <8hex>] [--repo <owner>/<repo>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--question` | string | yes | — | the one named question this spike answers; given exactly once — a second `--question` is a usage error (`1`), because two questions is two spikes |
| `--kind` | choice | yes | — | `logic` (a single self-contained HTML state-machine walkthrough) or `ui` (variants on one route) — the ruled artifact shapes |
| `--ticket` | integer | no | `null` | the issue this question came from, recorded as provenance and never read for instruction |
| `--nonce` | string | no | freshly minted, eight lowercase hex from a cryptographic random source | **re-entry only** — names an existing workspace to resume. A caller does not invent one; supplying a nonce with no workspace is `12` |
| `--repo` | string | no | `resolveTargetRepo`'s | the repository the spike is minted in |

**Output** — machine. One JSON object:

```json
{"spike":9310,"nonce":"7f3a9c21","kind":"logic","workspace":"/tmp/fabrika-spike/7f3a9c21","treeDigest":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
```

There is no empty answer: the verb either mints a spike or refuses.

**The mechanism, in order.** Resolve the repository root and `<tmpRoot>`. Mint the nonce, or take
`--nonce` for re-entry. Derive the workspace path and **refuse `13`** ([the in-tree test](#in-tree))
before any write. Probe the workspace: absent is the normal first-run path; present with a manifest
that does not parse is `4`; present with a manifest whose `question` and `kind` byte-match the flags
given is **re-entry** and the verb answers that manifest without writing anything, so a re-run after
a network fault mints no second issue; present with a manifest whose `question` or `kind` differs is
`18`. Confirm the `prototyping:spike` label exists (`7` if proven absent — the run routes to
front-door's bootstrap rather than silently opening a spike nobody can find). Take `treeDigest`.
Create the workspace and write the **provisional** manifest, with `spike: null`. Compose the issue
body and title; scan them with the imported leak predicates (`5` / `6`). **Create the issue in a
single POST carrying `labels: ["prototyping:spike"]`** — one write, so there is no orphan window
between an issue and its label. Read the issue back and compare title, body (through
`normalizeForReadback`) **and** the label set (`8` unproven, `9` on any mismatch). Complete the
manifest by writing `spike`; a failure here is `20` — the issue exists and the workspace cannot name
it.

**A provisional manifest is a real, reachable state, so both verbs that can meet it define their
behaviour against it.** Re-entry (`--nonce`) against a manifest still carrying `spike: null` does
**not** answer it unchanged: the verb lists the repository's open issues carrying the
`prototyping:spike` label (`GET /repos/<owner>/<repo>/issues?labels=prototyping:spike&state=open`,
paginated per skill-conventions §11), finds the one whose body carries this nonce, and completes the
manifest from it — which is what makes `20`'s named way forward work rather than loop. A failure of
that listing read is `11`; the manifest stays provisional and nothing is lost. Finding no such issue
among the results is `12`: the workspace names nothing and the run starts over. And `spike dispose` against `spike: null` skips the issue half
entirely — no `15`, no `21`, no forfeit — performing only the tree comparison and the removal, so an
orphaned workspace is always collectable.

**The issue body carries the nonce and never the workspace path.** That is the design answer to
#3086 — the path is not scanned out of the body, it is never placed in it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | a workspace exists for the given nonce and its manifest does not parse — re-entry cannot be decided, and the whole file is refused |
| `5` | the composed title or body carries a machine-local path |
| `6` | the composed title or body is a bare `@` path reference |
| `7` | proven: the `prototyping:spike` label does not exist in the repository |
| `8` | the issue create was attempted and its outcome could not be proven |
| `9` | the issue landed but its title, body or label set does not read back as sent |
| `10` | `--nonce` is off-grammar, or `--kind` is outside `logic`/`ui` |
| `11` | the repository root, the temp root, the label set, the tree state, or — on re-entry against a provisional manifest — the open-spike listing could not be read; nothing was minted |
| `12` | proven: `--nonce` was given for re-entry and no workspace exists for it |
| `13` | proven: the derived workspace path resolves inside the repository working tree |
| `18` | proven: a workspace exists for this nonce under a different question or kind |
| `20` | proven: the issue landed and the manifest could not be completed |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `spike open: --nonce "<value>" is not eight lowercase hex characters — nonces are minted by this verb, not supplied, except to re-enter a run.` | 10 | refusal |
| `spike open: --kind "<value>" is not logic or ui — those are the two ruled artifact shapes (#5017).` | 10 | refusal |
| `spike open: the workspace path <resolved> resolves inside the repository at <treeRoot> — a spike that lives in the tree is the defect this skill exists to prevent. Nothing was written.` | 13 | refusal |
| `spike open: a workspace for nonce <nonce> holds a different <question|kind> — mint a new run rather than reusing it.` | 18 | refusal |
| `spike open: a workspace for nonce <nonce> exists but its manifest does not parse: <first violation> — refusing the whole file; re-entry cannot be decided against half a manifest.` | 4 | refusal |
| `spike open: --nonce <nonce> names no workspace — omit it to mint a new run.` | 12 | refusal |
| `spike open: the repository has no prototyping:spike label — a spike minted without it is one no later run and no caller can find. Run /fabrika: front-door's bootstrap creates the board labels (#4952).` | 7 | refusal |
| `spike open: the composed <title\|body> carries a machine-local path: <first hit>.` | 5 | refusal |
| `spike open: the composed <title\|body> is a bare @ path reference — write the question, not a pointer to it.` | 6 | refusal |
| `spike open: the issue create failed: <reason> — it may or may not have landed; read the board before re-running.` | 8 | refusal |
| `spike open: the spike landed as #<n> but its <title\|body\|labels> does not read back as sent — it needs a human eye.` | 9 | refusal |
| `spike open: cannot read <what>: <reason> — nothing was minted and no workspace exists.` | 11 | refusal |
| `spike open: the spike landed as #<n> but its manifest could not be completed: <reason> — the issue exists and no workspace names it. Close #<n>, or re-run with --nonce <nonce>.` | 20 | refusal |

**Scope** — one question, one issue, one workspace. Not a judging verb: it supplies an identity. Its
one absence-shaped refusal (`7`) is a routable repository fact with a named way forward, not zero
scope over a corpus.

**Examples**

```
$ fabrika spike open --question "does better-auth mint a single-use token without a new table?" --kind logic
{"spike":9310,"nonce":"7f3a9c21","kind":"logic","workspace":"/tmp/fabrika-spike/7f3a9c21","treeDigest":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
```

```
$ fabrika spike open --question "would this feel right?" --kind ui --nonce run-1
spike open: --nonce "run-1" is not eight lowercase hex characters — nonces are minted by this verb, not supplied, except to re-enter a run.
$ echo $?
10
```

(`treeDigest` in the first example is the SHA-256 of zero bytes — what a clean tree digests to under
the rule above, and derivable from the spec. `spike`, `nonce` and `workspace` are sample values from
one run; every other field is fixed by a stated rule.)

**Grounding**

- v1 scar: a spike had **no marker at all**.
  `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/add-frontier-ticket.sh:24-30` admits
  exactly `type:investigation | type:decision`, so the translation table's `(spike)` was prose and a
  spike was byte-identical to a research ticket on the board. The `prototyping:spike` label is what
  makes a spike findable, countable, and disposable as a class.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/create-map.sh:26-32` trusts the
  create response's `.number`, never reads back, and never confirms the label landed — a labelless
  map reads as a successful chart. Here the label rides in the create call and the read-back
  asserts it.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/add-frontier-ticket.sh:36-45`
  is a non-atomic two-write with a real orphan state and no
  rollback. Here the label is one write with the issue, and the only remaining two-step (issue then
  manifest) has its own proven code (`20`) naming both halves.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/create-map.sh` writes refusal
  prose to **stdout** on four of five failure paths, against
  its own sourced library's stated contract. Here stdout carries the answer and nothing else.
- #4516 / #5028 / #4544 — the key is a minted per-run nonce, never a session variable and never a
  value a model chose.
- #3086 — the body carries the nonce, never the path.

---

## `spike run`

**Invocation**

```
fabrika spike run --nonce <8hex> [--timeout <seconds>] [--env <KEY=VALUE>] -- <command> [args…]
```

Everything after `--` is the command's argv, taken literally and never passed through a shell: no
expansion, no globbing, no pipeline, no redirection. A caller that needs a shell asks for one
explicitly as the command (`-- sh -c '…'`) and owns that choice.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--nonce` | string | yes | — | this run's key; names the workspace the command executes in |
| `--timeout` | integer | no | `300` | seconds before the child's process group is killed; the run is still recorded, with `timedOut` true |
| `--env` | string, repeatable | no | none | `KEY=VALUE` added to the child's scrubbed environment; a value not matching `^[A-Za-z_][A-Za-z0-9_]*=` is `10` |
| `--` then argv | array of string | yes (≥1) | — | the command to execute; zero arguments after `--` is a usage error (`1`) |

<a id="child-env"></a>**The child's environment — specified, because this is the widest capability in
the corpus.** The child does **not** inherit this process's environment. It receives exactly
`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR` from the parent, plus every `--env` pair, plus
`SPIKE_WORKSPACE` set to the resolved workspace path. Everything else is dropped. `GH_TOKEN`, `GITHUB_TOKEN`, and any variable whose
name ends in `_TOKEN`, `_SECRET` or `_KEY` are dropped like the rest — and naming one **explicitly**
in `--env` is not a way around that: it is refused on `10` rather than honoured, so a caller cannot
hand a prototype a credential by asking twice. A prototype is
throwaway code nobody reviewed; handing it the credentials that can write to the board would make
this verb the widest hole in fabrika rather than its most bounded execution point.

**Output** — machine. One JSON object:

```json
{"nonce":"7f3a9c21","seq":1,"command":["printf","no\\n"],"commandExit":0,"timedOut":false,"outBytes":3,"errBytes":0,"truncated":false,"outSha256":"564739ea8fa5926d4fa5c9734fed462061960a22e6b8d5c06e94969d97891bf2","errSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
```

<!-- anchor: RECORDED-IS-THE-ANSWER --> **Exit `0` means the command was executed and recorded, not
that it succeeded.** The command's own status is `commandExit`, in the payload, where a caller reads
it as data. This is the one place in the group where the exit code and the answer are deliberately
about different things, and it is the brief's requirement made constructible: `answer` hardcodes code
`0` (`verb.ts:39`), so an answer carrying `commandExit` cannot ride a non-zero code.

**The mechanism, in order.** Read the manifest (`12` absent, `4` malformed). Re-check the in-tree
condition against the manifest's `treeRoot` (`13`) — a repository that moved under the run is not a
tree this verb will execute against. Read `evidence.jsonl` to derive `seq` (`4` if it does not parse
or is not contiguous); an absent file is `seq` 1 and is a **fact**, not a failed read. Spawn the
command with the workspace as its working directory and [the scrubbed environment](#child-env),
capturing both streams to a bound of **1 MiB each**; at the bound capture stops, the remainder is
discarded, and `truncated` is true — the truncation is recorded, never silent. On `--timeout`, kill
the child's process group, set `commandExit` to `null` and `timedOut` to true, and record it: a run
that hung is a recorded fact, not a missing one. Write `runs/<seq>.out` and `runs/<seq>.err`, then
append the record line — **streams first, record last**, so a record never names files that do not
exist.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | `spike.json` or `evidence.jsonl` exists but does not parse, or the log's `seq` values are not contiguous from 1 |
| `10` | `--nonce` is off-grammar, `--timeout` is not a positive integer, or an `--env` pair is malformed or names a credential variable |
| `11` | the command could not be executed at all — the binary was not found, the workspace is not executable, or a capture file could not be written. **Nothing was appended, and the prototype answered nothing** |
| `12` | proven: no workspace exists for this nonce |
| `13` | proven: the workspace resolves inside the repository working tree |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `spike run: no workspace for nonce <nonce> — open a spike first, or this run was already disposed.` | 12 | refusal |
| `spike run: <path> exists but does not satisfy the manifest schema: <first violation> — refusing the whole file.` | 4 | refusal |
| `spike run: evidence.jsonl line <n> does not parse — the log is the evidence, so a log that cannot be read proves nothing.` | 4 | refusal |
| `spike run: the command could not be executed: <reason> — nothing was recorded, and this is NOT an answer of no.` | 11 | refusal |
| `spike run: cannot write the capture files for run <seq>: <reason> — nothing was appended.` | 11 | refusal |
| `spike run: the workspace <resolved> resolves inside the repository at <treeRoot> — refusing to execute against the tree.` | 13 | refusal |
| `spike run: --timeout "<value>" is not a positive integer.` | 10 | refusal |
| `spike run: --env "<value>" is not KEY=VALUE, or names a credential variable a prototype may not receive.` | 10 | refusal |
| `spike run: --nonce "<value>" is not eight lowercase hex characters.` | 10 | refusal |

**Scope** — one command, one workspace, one appended record. Not a judging verb: it supplies an
observation. There is no zero-scope case, because the verb never surveys anything; an absent
evidence log is a fact (`seq` 1), stated once here.

**Examples**

```
$ fabrika spike run --nonce 7f3a9c21 -- printf 'no\n'
{"nonce":"7f3a9c21","seq":1,"command":["printf","no\\n"],"commandExit":0,"timedOut":false,"outBytes":3,"errBytes":0,"truncated":false,"outSha256":"564739ea8fa5926d4fa5c9734fed462061960a22e6b8d5c06e94969d97891bf2","errSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
```

```
$ fabrika spike run --nonce 7f3a9c21 -- ./missing-binary
spike run: the command could not be executed: ENOENT — nothing was recorded, and this is NOT an answer of no.
$ echo $?
11
```

(Every value in the first example derives from a stated rule: `printf 'no\n'` writes the three bytes
`no\n` and nothing on stderr, `outSha256` is their SHA-256, `errSha256` is the SHA-256 of zero bytes,
and `seq` is 1 by the line-count rule over an absent log. Wall-clock is deliberately absent from
every stdout shape in this group, precisely because it is not derivable from the spec.)

**Grounding**

- #4111 — agent self-reports of a restored state were false twice and silently destroyed what they
  claimed to preserve. This verb exists so the record is produced by execution rather than typed by
  the model, which is why no flag anywhere in this group accepts a result.
- #3148 — what an unfounded decision costs downstream once it is acted on.
- v1 scar: the whole spike mechanism is one table cell
  (`claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md:179`) and one parenthetical (`:324`).
  Nothing recorded what a spike ran, what it produced, or where the artifact went.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/graduate-map.sh:18` re-raises
  `127` for "the CLI never ran", which the invoked tool can also return — UNKNOWN and a proven
  verdict on one code. Here `11` is this verb's own, and `127` keeps the shell's meaning.
- #4106 — a false green from a cross-context cache. Every record here is produced by this
  invocation; nothing is replayed and no result is read from another run's output.

---

## `spike capture`

**Invocation**

```
fabrika spike capture <spike> --nonce <8hex> [--repo <owner>/<repo>]
```

The decision arrives on **stdin**, because it is multi-line authored markdown and an example nobody
can paste verbatim is not an example:

```
$ fabrika spike capture 9310 --nonce 7f3a9c21 <<'MD'
A single-use token needs no new table — the verification record carries it.
MD
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<spike>` | positional integer | yes | — | the spike issue the decision is captured on |
| `--nonce` | string | yes | — | this run's key; the workspace whose evidence grounds the decision |
| `--repo` | string | no | `resolveTargetRepo`'s | the repository |
| *stdin* | text | yes | — | the decision, as authored markdown; empty is `3` |

**Output** — machine. One JSON object:

```json
{"spike":9310,"nonce":"7f3a9c21","commentId":512347,"runs":3,"evidenceDigest":"55260c5daf5ab4072864d383723bc2e54ff906e295fb8b1b2fc8fd5e604ac8fd","state":"closed"}
```

**The mechanism, in order.** Read the decision through the imported `readAuthored` guard — unread is
`1`, empty is `3`, a bare `@` reference is `6` — then scan it for machine-local paths (`5`). Read the
manifest (`12` / `4`) and confirm it names `<spike>` (`18`). Read `evidence.jsonl`: **zero recorded
runs is `14`**, and it is the precondition this verb most exists for. Compute `evidenceDigest`.
Read `<spike>` and its comments through the imported `Existence` shape: **a 404 is `absent` and
seats `7`; any other read failure is `unknown` and seats `11`** — the two are never fused, and this
is the read where that distinction is easiest to lose. Resolve the authenticated author's repository
permission and refuse `19` below `write` (`11` if the permission read itself fails — UNKNOWN, never a
grant); **the ACL gate precedes every write on every path, the idempotent one included**, because a
close is a write and authority is checked before writes rather than around them. Then branch on the newest matching capture
marker, which is the whole of this verb's re-entry story:

- **No capture marker for this nonce, and the spike is closed** — `7`: there is nothing to supersede
  and the spike is finished.
- **A marker whose `evidenceDigest` equals the one just computed** — exit `0` reporting the existing
  `commentId`; the verb only ensures the issue is closed. A re-run after a failed close is safe and
  does not double-post. **The stdin it just read is discarded on this branch, and the answer says
  so** — re-wording a decision without recording a new run changes nothing, and a caller who meant
  to revise must run something first so the digest moves.
- **A marker whose `evidenceDigest` differs** — runs were recorded after that decision was written,
  so post a **superseding** capture comment carrying the current digest, close the spike, and exit
  `0` — **closed either way**, because a captured decision on an open spike is the `15` this verb
  exists to clear, not a state it may leave behind. This holds whether the spike is open or closed, and it is what makes
  `spike dispose`'s `21` a state with a way out rather than a trap: `21` says the record is stale,
  and re-running this verb is what makes it current.
- **No marker at all, and the spike is open** — the ordinary first capture.

**Every branch that posts, posts the same way.** Compose the comment per [the comment
grammar](#the-comment-grammar--canonical-here), transcribing the run table from `evidence.jsonl`;
post it (`8` unproven); read it back through `normalizeForReadback` (`9` on mismatch); close the
spike (`8` if the close is unproven, with the message stating that the decision **did** land). The
idempotent branch is the one exception: it posts nothing and only ensures the close.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty decision |
| `4` | the manifest or the evidence log exists but does not parse |
| `5` | the decision carries a machine-local path |
| `6` | the decision is a bare `@` path reference |
| `7` | proven: `<spike>` is absent, or is closed and carries no capture marker for this nonce at all — there is nothing to supersede |
| `8` | the comment post or the close was attempted and its outcome could not be proven |
| `9` | the comment landed but does not read back as sent |
| `10` | `--nonce` is off-grammar |
| `11` | a precondition read failed — the manifest, the issue, its comments, or the permission — and nothing was posted |
| `12` | proven: no workspace exists for this nonce |
| `14` | proven: the evidence log holds zero recorded runs |
| `18` | proven: the manifest names a spike other than `<spike>` |
| `19` | proven: the author does not hold `write` or better on the repository |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `spike capture: the evidence log holds zero recorded runs — a decision with no recorded run is a self-report, not evidence (#4111). Run something through spike run, or dispose with --forfeit.` | 14 | refusal |
| `spike capture: the decision carries a machine-local path: <first hit>. Describe what the path was; do not paste it.` | 5 | refusal |
| `spike capture: the decision is a bare @ path reference — write the decision, not a pointer to it.` | 6 | refusal |
| `spike capture: stdin was read and held nothing — a spike with no decision has captured nothing.` | 3 | refusal |
| `spike capture: the manifest for nonce <nonce> names spike #<other>, not #<spike> — the evidence does not belong to this spike.` | 18 | refusal |
| `spike capture: <path> exists but does not satisfy the <manifest\|evidence log> schema: <first violation> — refusing the whole file.` | 4 | refusal |
| `spike capture: no workspace for nonce <nonce> — the evidence a decision would rest on is gone.` | 12 | refusal |
| `spike capture: --nonce "<value>" is not eight lowercase hex characters.` | 10 | refusal |
| `spike capture: spike #<n> is proven absent — nothing to capture onto; check the number.` | 7 | refusal |
| `spike capture: spike #<n> is closed and carries no capture marker for nonce <nonce> — there is nothing to supersede. Open a new spike for a new question.` | 7 | refusal |
| `spike capture: <login> holds <permission> on <repo>, below write — a decision recorded here would carry no authority (ADR 0055).` | 19 | refusal |
| `spike capture: cannot read <what>: <reason> — nothing was posted, and authority is UNKNOWN, never granted.` | 11 | refusal |
| `spike capture: the comment post failed: <reason> — it may or may not have landed; read spike #<n> before re-running.` | 8 | refusal |
| `spike capture: the decision landed as comment <id> but the close failed: <reason> — the decision IS on the record; re-run to close.` | 8 | refusal |
| `spike capture: the comment landed but does not read back as sent — it needs a human eye.` | 9 | refusal |

**Scope** — one spike, one evidence log, one comment. The evidence log is the scope the decision
rests on, and **zero scope reds** (`14`): "I ran nothing and it worked" is a pass this verb must
never emit (ADR 0092).

**Examples**

```
$ fabrika spike capture 9310 --nonce 7f3a9c21 <<'MD'
A single-use token needs no new table — the verification record carries it, and the walkthrough
drove sign-in twice on one token with the second rejected (run 1).
MD
{"spike":9310,"nonce":"7f3a9c21","commentId":512347,"runs":1,"evidenceDigest":"55260c5daf5ab4072864d383723bc2e54ff906e295fb8b1b2fc8fd5e604ac8fd","state":"closed"}
```

```
$ fabrika spike capture 9310 --nonce 7f3a9c21 <<'MD'
It works.
MD
spike capture: the evidence log holds zero recorded runs — a decision with no recorded run is a self-report, not evidence (#4111). Run something through spike run, or dispose with --forfeit.
$ echo $?
14
```

(`evidenceDigest` in the first example is derivable: it is the SHA-256 of a one-line log holding
exactly the record `spike run`'s example printed, serialized under the pinned rule above. `commentId`
is sample data returned by GitHub.)

**Grounding**

- #4111 / #3148 — the `14` refusal and the transcribed run table are the same answer to the same
  defect: the reader sees the runs, not the claim about them.
- ADR 0055 — authority is ACL-sourced, and a failed permission read is UNKNOWN (`11`), never a
  demotion or a grant.
- #3086 — the decision is leak-scanned through the shipped predicates before it is posted; the
  inherited #3785 false-positive is stated rather than worked around.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/SKILL.md:292-301` mandates every map
  write through the `wayfinder-map` CLI, and that tool is read-only by construction — the sanctioned
  write path is a dead end and the only alternative is explicitly banned. This group ships its own
  write path rather than assuming a reader will take a write.
- #4683 / #4990 / #3086 — `gh api -f key=@path` sends the literal string and only `-F` reads a file.
  This verb takes the body on **stdin**, so the flag form that causes that class is not reachable.

---

## `spike dispose`

**Invocation**

```
fabrika spike dispose --nonce <8hex> [--forfeit] [--repo <owner>/<repo>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--nonce` | string | yes | — | this run's key; names the workspace to destroy |
| `--forfeit` | boolean | no | `false` | abandon the spike without a decision: posts a forfeit note naming the run count and closes the spike, then disposes. Never bypasses the tree check |
| `--repo` | string | no | `resolveTargetRepo`'s | the repository |

**Output** — machine. One JSON object:

```json
{"spike":9310,"nonce":"7f3a9c21","workspace":"removed","treeMatched":true,"runs":1,"forfeited":false}
```

The answer names no path: there is nothing left to point at.

**The mechanism, in order.** Read the manifest (`12` absent, `4` malformed). **A manifest carrying
`spike: null` skips the issue half entirely** — no `15`, no `21`, no forfeit, no GitHub read at all —
leaving only the tree comparison and the removal below, so an orphaned workspace from a `20` is
always collectable. Otherwise: **recompute
`treeDigest` at the manifest's `treeRoot` and compare it to the manifest's** — a mismatch is `17`,
with the refusal message below — a count-and-first-path summary — **followed on stderr by every
differing status line**, so the removal licence covers all of them and not just the first. The
Errors table states the message; the enumeration is the detail that follows it. And **nothing is removed and nothing is
posted**, so the
leak stays inspectable. This runs first, before any state read and before any write, deliberately:
it is the cheap local check, and ordering it first is what keeps a `17` — the refusal this verb most
exists for — from ever destroying the leak it just found. It does **not** make every non-zero exit
write-free: `8`, `9` and `16` all sit past the `--forfeit` write or past the removal, and each says
so in its own row. Then resolve the spike's state: without `--forfeit`, a spike that is not
closed carrying a **capture marker** is `15`, because destroying an uncaptured spike erases what a
decision would have rested on. With a capture marker present, recompute `evidenceDigest` and compare
it to the digest in the **newest** such marker — a mismatch is `21`: runs were recorded after the
decision was captured, so the decision no longer covers the log. **This comparison runs whenever a capture marker
exists, `--forfeit` or not, and before the forfeit write** — forfeiting a spike whose recorded
decision has gone stale would bury the staleness rather than surface it. The way out is
`spike capture`, which supersedes a stale marker and exits `0` — so `21` is a detour, never a dead
end. One corner is a **human** escalation rather than a loop: if the author's permission has since
dropped below `write`, `capture` refuses `19` and `21` therefore stands, so someone holding `write`
runs the capture. The refusal says so rather than leaving a caller to discover it. With
`--forfeit`, compose the forfeit note, leak-scan it (`5` / `6`), post it (`8` / `9`) and close the
spike. Finally remove the workspace directory recursively, then **re-probe it and refuse `16` if it
is still present**. A removal nobody checked is the self-report class again, one directory down.

`--forfeit` deliberately does not relax `17` or `21`. Forfeiting is about the absence of a decision;
those two are about whether the throwaway stayed thrown away and whether the record is current, and
they are independent questions.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the manifest exists but does not parse |
| `5` / `6` | the composed forfeit note carries a machine-local path, or is a bare `@` reference |
| `7` | proven: the spike issue is absent, so `--forfeit` has nothing to post to |
| `8` | the forfeit note post or the close was attempted and its outcome could not be proven |
| `9` | the forfeit note landed but does not read back as sent |
| `10` | `--nonce` is off-grammar |
| `11` | the manifest, the spike's state, or the tree state could not be read — nothing was removed |
| `12` | proven: no workspace exists for this nonce — already disposed, or never opened |
| `15` | proven: the spike is not closed carrying a capture marker, and `--forfeit` was not given |
| `16` | proven: the workspace was removed and is still present on re-probe |
| `17` | proven: the working tree does not match what `spike open` recorded — nothing was removed. The guard cannot tell a path the spike authored from one anything else wrote, and that is deliberate; restore or remove the named paths either way, then re-run |
| `21` | proven: the evidence log's digest differs from the one in the capture marker |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `spike dispose: spike #<n> carries no captured decision — disposing now destroys what a decision would rest on. Capture it, or pass --forfeit to abandon it on the record.` | 15 | refusal |
| `spike dispose: the working tree changed since the spike opened (<count> paths, first: <path>) — the workspace is intact and NOT removed.` | 17 | refusal |
| `spike dispose: the evidence log moved after the decision was captured (<n> runs now, <m> at capture) — re-run spike capture to supersede the stale decision, then dispose. If capture refuses on 19, someone holding write must run it. Nothing was removed.` | 21 | refusal |
| `spike dispose: the workspace <resolved> is still present after removal — disposal is UNPROVEN, and this spike is not disposed.` | 16 | refusal |
| `spike dispose: no workspace for nonce <nonce> — it was already disposed, or never opened.` | 12 | refusal |
| `spike dispose: <path> exists but does not satisfy the manifest schema: <first violation> — refusing the whole file.` | 4 | refusal |
| `spike dispose: --nonce "<value>" is not eight lowercase hex characters.` | 10 | refusal |
| `spike dispose: spike #<n> is proven absent — there is nothing to forfeit to.` | 7 | refusal |
| `spike dispose: the composed forfeit note carries a machine-local path: <first hit>.` | 5 | refusal |
| `spike dispose: the composed forfeit note is a bare @ path reference.` | 6 | refusal |
| `spike dispose: the forfeit note failed to post: <reason> — it may or may not have landed; read spike #<n> before re-running. Nothing was removed.` | 8 | refusal |
| `spike dispose: the forfeit note landed but does not read back as sent — it needs a human eye. Nothing was removed.` | 9 | refusal |
| `spike dispose: cannot read <what>: <reason> — nothing was removed.` | 11 | refusal |

**Scope** — one workspace, and the repository working tree at the manifest's `treeRoot`, including
ignored paths. This **is** a judging verb: it judges whether the throwaway stayed thrown away, and
its verdict rests on the digest comparison, stated on stderr as the scope line. There is no
zero-scope case — an absent manifest is `12` before any judgment is attempted, never a clean verdict
over nothing.

**Examples**

```
$ fabrika spike dispose --nonce 7f3a9c21
{"spike":9310,"nonce":"7f3a9c21","workspace":"removed","treeMatched":true,"runs":1,"forfeited":false}
```

```
$ fabrika spike dispose --nonce 7f3a9c21
spike dispose: the working tree changed since the spike opened (2 paths, first: apps/agenda/src/query-probe.ts) — the workspace is intact and NOT removed.
spike dispose:   ?? apps/agenda/src/query-probe.ts
spike dispose:   ?? apps/agenda/src/fixtures/seed-2500.json
$ echo $?
17
```

**Grounding**

- The brief's central constraint: a throwaway must not harden into production code. `17` is the
  check that makes disposability a property rather than an intention, `16` is what stops the removal
  itself from being a self-report, and `--ignored=matching` is what stops the check having a hole
  exactly where prototypes write.
- #2666 / #3594 / #4106 — a fresh isolated tree came up dirty, isolated agents wrote their first
  edits into the primary checkout, and a cross-worktree cache returned a false green. All three are
  the same class: isolation that was believed rather than checked.
- #4111 — `15` exists because destroying an uncaptured spike is erasing what you claimed to
  preserve; `21` exists because a capture that no longer covers the log is the same defect a
  half-step later.
- v1 scar: the wayfinder skill contains **no disposal language at all** — no rule that spike code
  must not merge, no cleanup step, no marking. That absence is what this verb answers.
- v1 scar: `claude-plugins/kampus-pipeline/skills/wayfinder/scripts/graduate-map.sh:9-10` states its
  "FULLY-graduated only" precondition in a **comment** and enforces nothing, so it would close a map
  with an open frontier as readily as a cleared one. Here the equivalent precondition is `15`,
  checked.

---

## `spike status`

**Invocation**

```
fabrika spike status --nonce <8hex> [--repo <owner>/<repo>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--nonce` | string | yes | — | this run's key |
| `--repo` | string | no | `resolveTargetRepo`'s | the repository |

**Output** — machine. One JSON object. **This verb is deliberately near-total: it reports per-field
state inside exit `0` rather than refusing**, because its consumer is a session resuming cold, and a
resuming session that gets a refusal learns nothing about where it is.

```json
{"nonce":"7f3a9c21","workspace":"present","spike":9310,"kind":"logic","question":"does better-auth mint a single-use token without a new table?","spikeState":"open","captured":false,"runs":1,"lastCommandExit":0,"evidenceDigest":"55260c5daf5ab4072864d383723bc2e54ff906e295fb8b1b2fc8fd5e604ac8fd","treeMatched":true}
```

`workspace` is `"present"` or `"absent"`. When it is `"absent"` every workspace-derived field is
`null` and that is a **fact**, not a failed read — the one place in this group where an empty answer
is declared a fact, stated here in the header per interface convention rule 4. An **absent
`evidence.jsonl` under a present workspace** yields `runs: 0`, `lastCommandExit: null` and
`evidenceDigest: null`, also a fact: a log that was never written is not a log that hashes to the
empty string. `spikeState` is `"open"`, `"closed"`, or `null` when there is no workspace to name a
spike from; `captured` is whether the spike carries a capture marker. `treeMatched` is the same
comparison `spike dispose` judges on, reported here as information and **never as a verdict** — this
verb removes nothing and refuses nothing on it.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the manifest or the evidence log exists but does not parse — a workspace that cannot be described is not "absent" |
| `10` | `--nonce` is off-grammar |
| `11` | the spike issue's state, its comments, or the tree state could not be read — the field would be a guess |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `spike status: the manifest for nonce <nonce> does not parse: <first violation> — the workspace exists and cannot be described, which is not the same as absent.` | 4 | refusal |
| `spike status: --nonce "<value>" is not eight lowercase hex characters.` | 10 | refusal |
| `spike status: cannot read <what>: <reason> — the state is UNKNOWN, never reported as a default.` | 11 | refusal |

**Scope** — one nonce: its workspace, the spike that workspace names, and the tree. Not a judging
verb — it supplies state. An absent workspace is a **fact** (exit `0`, `workspace: "absent"`), and
that decision is made once, here, per rule 4.

**Examples**

```
$ fabrika spike status --nonce 7f3a9c21
{"nonce":"7f3a9c21","workspace":"present","spike":9310,"kind":"logic","question":"does better-auth mint a single-use token without a new table?","spikeState":"open","captured":false,"runs":1,"lastCommandExit":0,"evidenceDigest":"55260c5daf5ab4072864d383723bc2e54ff906e295fb8b1b2fc8fd5e604ac8fd","treeMatched":true}
```

```
$ fabrika spike status --nonce 0badf00d
{"nonce":"0badf00d","workspace":"absent","spike":null,"kind":null,"question":null,"spikeState":null,"captured":false,"runs":null,"lastCommandExit":null,"evidenceDigest":null,"treeMatched":null}
```

**Grounding**

- Decide who consumes a verb's output before allocating its exit codes. This verb's consumer cannot
  act on a refusal, so absence is a field value here while the same absence is a refusal (`12`) in
  the mutating verbs — two consumers, two correct treatments, stated so an implementer does not
  "fix" the asymmetry.
- ADR 0092 — the asymmetry is bounded: `4` and `11` still refuse, because an unparseable or
  unreadable state rendered as a plausible default is the failure that rule exists to prevent.
- v1 scar: `packages/pipeline-cli/src/tools/wayfinder-map/command.ts:72-79` prints a malformed-map
  line and **returns normally**, so exit status cannot separate malformed from valid. Here malformed is `4`.

---

## Required repo files (verb-level)

The skill's run-level works-here checklist is [`SKILL.md`](SKILL.md)'s `## Required repo files`
table, and front-door's detection parses that one. This table is the same shape, scoped to the reads
**these verbs** make, so an implementer sees the dependency set in one place; it adds no row the
skill's table does not already carry.

| Must exist | Why this group needs it | When missing |
| --- | --- | --- |
| A GitHub repository reachable over `gh` REST with `issues: write` | `spike open` creates the issue; `spike capture` comments and closes; `spike dispose --forfeit` comments and closes; `spike status` reads state | **fail-loud** — `11`, and no outcome is proven. `spike run` and a non-forfeit `spike dispose` are unaffected: neither touches GitHub |
| The `prototyping:spike` label | `spike open` sends it in the create call; `spike capture`, `spike dispose` and `spike status` need spikes to be findable as a class | **bootstrap** — front-door creates it; until then `spike open` exits `7` naming the label. A fresh repo on day one hits exactly this, and the way forward is named rather than left as a refusal |
| A git working tree — the repo root resolves and `git status --porcelain=v1 --untracked-files=all --ignored=matching` answers | `spike open` takes `treeDigest`; `spike dispose` recomputes and compares it; `spike status` reports `treeMatched` | **fail-loud** — `11`. An unreadable tree is UNKNOWN, never "clean". A directory that is not a repository at all is the same `11`, and the way forward is to run from inside one |
| A writable OS temp root that resolves outside the repository tree | the workspace, the manifest, the evidence log and the capture files all live there | **fail-loud** — `11` if it cannot be written, `13` if it resolves inside the tree. There is no in-repo fallback: an in-tree workspace is the defect this group exists to prevent |
| Readable collaborator permissions — `repos/<owner>/<repo>/collaborators/<login>/permission` | `spike capture` resolves the author against them before recording a decision (ADR 0055) | **fail-loud** — `11`. A permission read that fails is UNKNOWN, never a grant |

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag carries a
type and, where optional, a default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (the per-verb tables own the group-local rows, and the universal
`0`/`1`/`126`/`127` live once in the shared matrix, which owns every code's single meaning); every
error names its message, its stream and its code, and every code in every verb's exit table has a
matching Errors row; every judging verb states its scope and its zero-scope behaviour (`spike
dispose` is the one judging verb, and `spike capture`'s `14` is the zero-scope red on the evidence
log); and no clause defers to a v1 script, another skill's prose, or the authoring session — the v1
citations are Grounding notes about what a v1 surface *gets wrong*, never behaviour this spec
inherits, and no sibling fabrika contract is depended on at all.

**The five hand-checks the presence tests cannot perform.**

1. **Every reachable outcome was walked per verb.** The mixed case that needed a stated rule is
   `spike run`'s: a child that fails, a child that hangs, and a child that cannot start are three
   outcomes, and only the third is non-zero.
2. **Every example value derives from stated rules, or is marked as sample data in the same breath.**
   The digests are the SHA-256 of zero bytes, of `printf 'no\n'`'s three bytes, and of the pinned
   one-line log those bytes produce. Issue numbers, `commentId` and the nonce are named as sample
   values where they appear. No example prints a computed score, a ranking, or a duration.
3. **Sibling verbs guard shared preconditions identically, and the four deliberate asymmetries are
   named rather than left to be discovered.** `run`, `capture` and `dispose` seat an absent manifest
   on `12` and a malformed one on `4`; `open` seats only `4`, because on its path an absent
   workspace is the normal first-run case rather than a refusal. **`status` seats `4` and never
   `12`**, the asymmetry its Output section states. `open` and `run` re-check the in-tree condition
   on `13`; **`capture` and `dispose` do not** — `capture` writes only to GitHub, and `dispose`
   removes rather than executes, with its own `17` covering the tree. `capture` and `dispose` run the same posting guards on the same `5` / `6` / `8` / `9`
   seats, and every verb validates `--nonce` on the same `10`.
4. **Every value a later verb needs arrives as an argument or from an artifact on disk, never from
   session memory.** The nonce is minted by `open`, printed in its answer, and passed as an explicit
   flag to every other verb; the spike number, kind, question, `treeRoot` and `treeDigest` persist in
   `spike.json`; the run count and `evidenceDigest` derive from `evidence.jsonl`; the capture's
   digest persists in the comment marker, which is why `dispose` can check `21` without being told.
   No clause refers to "the digest at open time" or "the runs you recorded" as something the model
   carries forward.
5. **Every refusal names a way forward, including on a repository's first day.** A fresh repo with
   no label hits `7` and is routed to front-door's bootstrap; a directory that is not a repository
   hits `11` naming the condition; an empty evidence log hits `14` naming both `spike run` and
   `--forfeit`. No refusal in this spec dead-ends.
