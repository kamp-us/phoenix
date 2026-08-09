# `/governance` — derived CLI contract

**Skill:** [`governance`](SKILL.md) · **Authoring brief:** [#4949](https://github.com/kamp-us/phoenix/issues/4949) · **Date:** 2026-08-09

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `governance`
subcommand beside the `adr`, `build`, `epic`, `eval`, `plan`, `report`, `review`, `review-ui`,
`ship`, `spend`, `triage`, `ui` and `wire` groups already registered in
`packages/fabrika-cli/src/registry.ts`. The group name was confirmed free at authoring time by
reading that file. The [CLI interface convention](../../docs/cli-interface-convention.md) governs
these verbs; where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). v1's
`review-doc` Step 4a and its `scripts/adr-sweep.sh`, v1's `review-skill` Step 4 check 4, and the
`class-probe` / `verdict` / `control-plane-paths` / `adr-sweep` tools were read for their semantics
and their scars — each Grounding section names what the v1 counterpart gets wrong and what this spec
does instead — but no clause defers to one and none is invoked.

**Substrate.** Effect CLI verbs on the `@effect/platform-node` seam the sibling groups use; GitHub
access per
[skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `governance scope` | whether the diff derives the governance namespace, over which harness roots, with the bound head, the `self` flag, and the decision records the diff touches | matching changed paths against a fixed root set and binding them to a commit is a total function; whether a change weakens a guard is the whole judgment |
| `governance sweep` | the uncited live-`accepted` records whose decision domain a subject touches, ranked, for a subject read out of a bound commit or out of the corpus | the ranking is arithmetic over a corpus; reading the shortlist, and reading the domain the ranking cannot see, is judgment |
| `governance guards` | the anchored invariants the bound diff removes or modifies, and the guard-bearing files it touches | detecting an anchor's removal or mutation in a diff is textual and mechanical; whether the change *weakens* the invariant is judgment |
| `governance base` | this skill's own text at the merge-base of a PR that edits it — the self fence's bytes | resolving a merge base and reading named paths at it is mechanical; judging the PR by those rules rather than the head's is the judgment |
| `governance post` | the single sanctioned emit of the `governance` namespace verdict: compose through the `verdict-marker` wire format, re-resolve the head, upsert one comment, leak-scan, read back | marker composition, head re-resolution, the derived-namespace fence and the read-back are a protocol; the polarity and clause are judgment |
| `governance digest` | the decision records that landed in a window, each with its id, title, status, landing commit and whether its diff carried anchored-invariant changes | enumerating merges in a window and reading each record's frontmatter is mechanical; ranking tension and blast radius is judgment |
| `governance readout` | the digest-publishing protocol: compose the ranked rows through the `governance-digest` wire format, upsert them into the durable artifact, read them back | composition, upsert and read-back are a protocol; the rows and their order are judgment |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live inline, the
same tracked debt the sibling contracts carry.)

- **A §CP classifier, of any kind — path, content or hybrid.** fabrika's §CP model is
  CODEOWNERS-only, three-valued, `UNKNOWN` treated as §CP, with **no semantic detection**
  ([§CP classification](../../docs/control-plane-classification.md), founder ruling on #4927). The
  boundary is enforced twice in CI — `.github/workflows/codeowners-cp.yml` job `check`, and
  `ci.yml`'s `skills` job via `validate-gate-path-drift.sh` — and by GitHub's own code-owner review
  requirement. A second answer here could contradict a merge-gating verdict, which is #4227's cost.
  This group computes no §CP answer; the skill states the expectation and nothing more.
  ADR [0164](../../../../.decisions/0164-guard-relaxing-adr-cp-gate.md) wanted a guard-vocabulary
  content probe for exactly the case this skill owns. That ADR is `status: proposed`, its mechanism
  exists only inside v1's ship-it Step 0 (#3416), and fabrika resolved the same case **two other
  ways**: path-set completeness in CODEOWNERS, and this skill's judgment. A fabrika content regex
  would be a third, rival answer.
- **A re-derivation of the ranking algorithm.** `governance sweep` **imports**
  `packages/fabrika-cli/src/adr/sweep.ts` — `decisionBearingText`, `tokenize`, the idf scoring and
  `RARITY_FLOOR` — rather than restating any of it. A second lexical sweep would be a rival answer
  to a solved question. What this verb adds is the subject source: `adr sweep` can only read a local
  draft, and a review-time or digest-time subject lives in a **commit**.
- **A citation-resolution verb.** `fabrika adr resolve` already answers
  `live` / `landed` / `in-flight` / `absent` against a freshly fetched base ref. The skill invokes it
  directly. A `governance resolve` would be a wrapper whose only behaviour is relaying an upstream
  answer, which ADR 0238 bans.
- **An ADR-number-collision verb.** `fabrika adr next` already unions the merged set with the ids
  open ADR PRs claim — the cross-PR read #3779 proved a tree-local guard structurally cannot make.
  The skill invokes it; this group adds nothing.
- **A dead-link or ADR-index checker.** `doc-links.yml` and `decisions-index.yml` gate each. Note
  what they do **not** cover, because it is this skill's job and not a gap in theirs: `lychee
  --offline` skips `http(s)` by design and `decisions-index validate` checks files, never citations,
  so a PR citing an unlanded ADR passes both green (#4296). That check reaches the corpus half
  through `adr resolve`, not through a second link checker.
- **A verdict-conjunction or enqueue verb.** `fabrika ship gate` folds the required namespaces into
  one fail-closed enqueue decision and is the single merge authority. This group emits one
  namespace's verdict and reads none of the others.
- **A blocking digest.** The readout gates nothing by founder ruling (#4927 comment 5227714776).
  A verb that could red on a digest row would re-create the human gate the ruling retired.

### Nothing here recomputes an enforced answer

The enforced questions are: the §CP path boundary and its CODEOWNERS/prose drift
(`codeowners-cp.yml` job `check`; `ci.yml` job `skills`), the enqueue conjunction over required
namespaces (`fabrika ship gate`, the single merge authority), typecheck/lint/tests, leaks, secrets,
dead links, and ADR-index integrity — each with the workflow or verb that owns it. This spec
computes no second verdict on any of them. The namespace derivation and the contradiction ranking
are **not** enforced at any CI seam — verified by grepping `.github/workflows/` — which is why they
are legitimately verbs here.

### The name situation, and routing

No v1 skill is named `governance`, so there is no name collision. Nothing on `main` routes to any
fabrika skill: `CLAUDE.md` pins skill routing to the `.claude/skills` filesystem path, which is a
symlink to the v1 tree. The gap is already filed — [#4761](https://github.com/kamp-us/phoenix/issues/4761)
(routing pinned to a path) and [#4829](https://github.com/kamp-us/phoenix/issues/4829) (the symlink
loads v1 regardless of the plugin toggle) — and is recorded in the authoring PR rather than patched
from here, the same disposition the `review` and `ship` contracts took. Today this skill is reached
as `/fabrika:governance`, and **from inside fabrika it is already routed**: `review`'s SKILL.md §6
directs the model to fire it on a `harness: true` diff, and `review`'s eval set carries a
`governance-seam-derived-required` case.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else; scope lines, refusal
  reasons and progress go to stderr. Every "nothing found" case prints a state word — empty stdout
  is byte-identical to a verb that never ran, and v1's `adr-sweep.sh` shipped exactly that: on both
  its guard-abort path and its shortlist path stdout is empty, and the exit code does not separate
  them either.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote; none resolvable → exit `1`) — the resolution chain
  the shipped `report`/`triage`/`review` groups already use. `--json` swaps the line grammar for one
  object with the named keys.
- **Every list read paginates and reports its scanned count** on stderr — comments, changed files,
  corpus members. A verdict driven by a silently truncated read is a verdict over unknown scope.
- **A non-zero exit is UNKNOWN.** No verb prints a partial or permissive answer on a non-zero exit.
  This is not merely a convention here: `packages/fabrika-cli/src/verb.ts`'s `refuse()` hardcodes
  `stdout: ""` and `answer()` hardcodes `code: 0`, so a non-zero exit carrying a machine payload is
  **unbuildable** in this package. Every informative outcome below is therefore an exit-`0` token,
  and every non-zero is a bare refusal with its reason on stderr.

### The shared exit taxonomy

All six verbs allocate from one internal table (`packages/fabrika-cli/src/governance/codes.ts`), so
a code means one thing across *this group*. Every shared seat is **imported**, never restated as a
numeral — a restated numeral is a second source that can drift silently, and an import cannot.
Import exactly as `packages/fabrika-cli/src/review/codes.ts` does, from the modules that actually own
each meaning:

| Seat | Import from | Shipped constant |
|---|---|---|
| `3` `5` `6` `7` `8` `9` `11` | `packages/fabrika-cli/src/report/codes.ts` | `EMPTY_STDIN`, `LEAKED_PATH`, `BARE_AT_PATH`, `NO_TARGET` (re-exported here as `ZERO_SCOPE`, the same rename `review` uses), `WRITE_UNKNOWN`, `READBACK_MISMATCH`, `PRECONDITION_UNKNOWN` |
| `10` | `packages/fabrika-cli/src/triage/codes.ts` | `OFF_VOCABULARY` — **not** `report`'s `10`, which is `CLASSIFIED` ("the title or `--label` carries a type or priority classification", `report file` only) and means something else entirely |
| `12` `13` | `packages/fabrika-cli/src/review/codes.ts` | `STALE_HEAD`, `INCOMPLETE_SCAN` — imported because this group proves the same two facts |
| `4` | declared locally as `DELIBERATE_GAP = 4` | the same shape `review/codes.ts` ships, so the gap is registered rather than silently absent |
| `14` | this group's own | see below |

The group registers in `ALIGNED_GROUPS` in `packages/fabrika-cli/src/exit-code-alignment.ts` **and**
in the `TABLES` record in `packages/fabrika-cli/src/exit-code-alignment.unit.test.ts` — two files,
not one; registering only the first leaves that test red. Codes were read from the **shipped
package**, never from a sibling `contract.md`.

| Code | Meaning | scope | sweep | guards | base | post | digest | readout |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `2` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | ✓ | — | ✓ |
| `4` | *(deliberate gap — `report file`'s body-section seat; no verb here composes body sections)* | — | — | — | — | — | — | — |
| `5` | the **authored** text carries a machine-local path | — | — | — | — | ✓ | — | ✓ |
| `6` | the **authored** text is a bare `@` path reference — not redactable | — | — | — | — | ✓ | — | ✓ |
| `7` | zero scope: the target is **proven absent (404)** or closed, the PR has zero changed files, the corpus holds zero decision records, the window holds zero landings, or the readout artifact is proven absent — a fail-closed refusal (ADR 0092) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `8` | the write itself failed — the outcome is **UNKNOWN** | — | — | — | — | ✓ | — | ✓ |
| `9` | the write landed but the read-back does not match | — | — | — | — | ✓ | — | ✓ |
| `10` | a supplied value is off the closed vocabulary — a bad `--polarity`, a `--sha` that is not a head SHA, an unparseable `--since`, a `--record` that is not a four-digit id, a `--path` outside this skill's own resolved directory | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `11` | a **precondition read failed** — nothing was written and the outcome is UNKNOWN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | refused: the `--sha` given is not the PR's head — a read taken over, or a verdict bound to, a tree that is no longer the PR | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `13` | refused: the read completed but its scope is **provably incomplete** — a truncated changed-file list or diff, a comment enumeration short of its declared count | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| `14` | refused: this PR's diff derives **no** governance namespace — a verdict in a namespace the diff did not require | — | — | — | — | ✓ | — | — |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**The export names `governance/codes.ts` must ship**, because `checkAlignment`
(`packages/fabrika-cli/src/exit-code-alignment.ts`) keys on export *names* and not on numerals — a
different spelling reds the alignment test with nothing in the failure naming why:
`EMPTY_STDIN`, `DELIBERATE_GAP`, `LEAKED_PATH`, `BARE_AT_PATH`, `ZERO_SCOPE`, `WRITE_UNKNOWN`,
`READBACK_MISMATCH`, `OFF_VOCABULARY`, `PRECONDITION_UNKNOWN`, `STALE_HEAD`, `INCOMPLETE_SCAN`, and
this group's own `NOT_HARNESS_TOUCHING`.

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every verb can
also return `0`, `1`, `2` and `127` with the meanings above, stated here and nowhere else; the
per-verb "Exit status" tables enumerate only that verb's own proven outcomes, `3` and up, phrased as
that verb's trigger.

**`11` is the shipped `PRECONDITION_UNKNOWN`**, matched rather than reinvented: a read the verb
needed failed, so nothing is proven — not `7` (which is *proven* absence: a 404 is a fact about the
repository, an unreachable GitHub is not a fact about anything) and not `1` (which would fuse an
unreachable GitHub with a bad flag). **A corpus member that exists and could not be read is `11`,
never `7`** — an incomplete corpus is UNKNOWN, and answering `no-overlap` over it is the fail-open
this whole skill exists to prevent.

**`14` is this group's one private seat.** It is not `10`: `10` is a value off a closed vocabulary,
a caller typo. `14` is a *proven fact about the PR* — the diff was read, bound and partitioned, and
it derives no governance namespace. Folding them would make "you asked wrongly" and "this PR is not
mine to judge" one number, and only the second is safe to treat as a clean skip.
`review/codes.ts` seats its own `14` as `ACL_DENIED`; that is a different group's private band and
carries no cross-group uniqueness obligation (interface convention rule 3), so **declare `14`
locally and do not import it** — an implementer who imports `14` from `review` alongside `12` and
`13` gets the wrong meaning silently.

### The commit binding runs before every read (#5117, #5122, #4163)

`governance scope`, `governance sweep` and `governance guards` serve the artifact a governance
verdict is formed over, so **the bytes come from a named commit, not from an endpoint that takes a
pull-request number and no commit at all.** A push landing between scoping and reading otherwise
serves the new head's artifact under the old head's SHA, and the result is a confident verdict over
text nobody judged. All three run one shared binding step
(`packages/fabrika-cli/src/governance/head.ts`, modelled on the shipped
`packages/fabrika-cli/src/review/head.ts` and importing `bindHead` from it) before any artifact read:

1. An explicit `--sha` must be **the PR's head**, or the verb refuses on `12`. Malformed is `10`.
2. A configured git remote must serve the target repo, `pull/<pr>/head` must **fetch**, the commit
   must resolve in the object database, and `git rev-parse` must resolve it to *itself*. The base ref
   must resolve too, since a diff is a range. Any of these unmet is `11`, naming what is UNKNOWN.
   There is no permissive fallback to the PR-number endpoints.
3. The artifact is then read with `git diff <base>...<head>` and `git show <head>:<path>` under flags
   that pin output to the two commits rather than to the invoking user's `~/.gitconfig`
   (`--no-ext-diff`, explicit `a/`/`b/` prefixes).

**The fetch is load-bearing, not incidental.** A stale working tree is what made four seats declare a
merged ADR nonexistent (#4163) and what applied a withdrawn ADR 86 minutes after its withdrawal
(#4338). v1's `adr-sweep.sh` has no fetch at all and reads whatever `.decisions/` the launching
checkout happens to hold. Nothing is checked out here: a fetch writes objects, not a working tree, so
the head's instruction files are never on disk to be loaded.

### Read-backs compare normalized text, not bytes

`governance post` and `governance readout` re-read their target and compare through
**`normalizeForReadback` from `packages/fabrika-cli/src/report/compose.ts`** — import it; its third
step (strip trailing newlines) is the one a re-derivation drops, and dropping it fires exit `9` on
clean runs.

### Machine-local path detection

`governance post` and `governance readout` share the leak predicate **already implemented** at
`packages/fabrika-cli/src/report/leaks.ts` — import it, never re-derive it. Follow the shipped
wrapper shape at `packages/fabrika-cli/src/review/authored.ts` and
`packages/fabrika-cli/src/triage/authored.ts`: a `readAuthored(surface, read)` plus a
`leakRefusal(...)`.

### Three shipped-surface changes this group requires

All three are additive; none changes how any existing marker, namespace or verdict reads. Each is a
change to a surface this group does not own, so each names the file and the exact edit.

**0. `ship`'s required-namespace vocabulary must admit `governance` — without this the whole
fail-closed property is decoration.** `packages/fabrika-cli/src/review/classes.ts:118` declares
`export const SHIP_NAMESPACES: ReadonlyArray<string> = SHIP_CLASS_NAMES.map((n) => `review-${n}`)`,
and `packages/fabrika-cli/src/ship/gate-verb.ts:158` refuses any `--require` value outside it with
`OFF_VOCABULARY`. So **`fabrika ship gate --require governance` is refused today**, which means a
harness-touching diff can reach the enqueue seam with no governance verdict and nothing anywhere
says no. The skill's "fail-closed on absence" property is a claim about `ship gate`'s conjunction,
and it is false until this lands. Two edits, both additive:

- `SHIP_NAMESPACES` becomes the `review-*` set **plus** the literal `governance`, so `--require
  governance` is admitted. The `review-*` derivation from `SHIP_CLASS_NAMES` is untouched.
- `ship scope`'s printed namespace set (`shipNamespacesOf`) additionally emits `governance` when the
  PR's changed files touch any of this group's four roots — the same total function
  `governance scope` computes, so the two cannot disagree. Share the predicate rather than writing
  it twice.

`ship gate`'s resolution of a `governance` marker needs no change beyond this: it reads markers
through the same `verdict-marker` format for every namespace, and the ADR 0058 key already carries
no notion of which skill posted one. **This is not a second answer to an enforced question** — the
enqueue conjunction stays `ship gate`'s alone. It is that enforcer being taught one more namespace,
which is the only shape in which a derived-required namespace can actually be required.

**1. The `verdict-marker` namespace class must admit `governance`.**
`packages/fabrika-cli/src/wire/verdict-marker.ts` today declares
`const NAMESPACE = /^(review|check-epic-plan)(-[a-z0-9]+)*$/` and
`const NAMESPACE_PREFIXES = ["review", "check-epic-plan"]`. A `governance` marker is **not
representable**: `read`'s prefix gate turns it away as `Absent` before the regex is tested, so
`emit` would compose bytes the format can never read back — the exact hazard that file's own
docblock names. Widen **both** constants to admit `governance`, the same additive shape #5107 used
for the plan gate, and extend the format's round-trip and malformed fixtures with a `governance` row
so `wire/conformance.ts` drives the new arm. Widening one constant and not the other is the defect.

**2. A new registered format `governance-digest`.** One row in
`packages/fabrika-cli/src/wire/registry.ts` plus a sibling schema module
`packages/fabrika-cli/src/wire/governance-digest.ts` — never a branch inside a verb, which is that
registry's stated law. Producer `governance`, consumer the front door
([#4952](https://github.com/kamp-us/phoenix/issues/4952)). The artifact is a fenced block under a
`## Governance readout` heading whose rows are the **stdin row grammar `governance readout` accepts**
— `row\t<NNNN>\t<tension|blast|routine>\t<one-line note>` — and **not** that verb's own stdout line,
which reports the write rather than carrying the digest. `emit` / `read` / fixtures / brands as the
registry's `WireFormat` requires.

**The artifact's bytes, in full, because an implementer writes `emit` and `read` against these and
nothing else in this spec shows them:**

````markdown
## Governance readout

```governance-digest
row	0398	tension	sits against ADR 0173 on whether a pending required check blocks admission
row	0401	blast	every cache key in the system gains a tenant component
row	0396	routine	no tension found
```
````

`emit` composes exactly that block from the rows; `read` is total over any artifact — `Found` with
the rows in file order, `Absent` when no `## Governance readout` heading with a `governance-digest`
fence is present, and `Malformed` when the heading and fence are present but a line is not a
conforming `row` (a drifted heading level, a fourth field, an off-vocabulary kind, a non-four-digit
id). The round-trip fixture is the three rows above; the malformed fixtures are, at minimum, a
drifted heading level, a fence holding prose instead of rows, and a row whose kind is off the closed
set. The note is the only free-text field and it never carries a directive — a receiver re-fetches
the record the id names and reads it there. The digest is a
**closed-vocabulary** artifact for exactly the AC-5 reason: the front door re-fetches and re-reads it
rather than trusting anything a coordination message carried.

---

## `governance scope`

**Invocation**

```
fabrika governance scope 4321 [--sha <head>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number to scope |
| `--sha` | string | no | the PR's live head | the head to read the changed files at; see the binding step above |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`governance\t<required|not-required>\t<head-sha>` — the head is the commit the file list was read
out of. Then one line per harness root the diff touches —
`root\t<.decisions/|.claude/|.github/|claude-plugins/>\t<file-count>` — then
`self\t<true|false>`, then one line per decision record in the diff —
`record\t<NNNN>\t<added|modified|deleted>\t<path>`.

With `--json`, an object with keys `outcome` (`required` | `not-required`), `head` (full 40-hex),
`roots` (array of `{name, files}`), `self` (boolean), `base` (the merge-base SHA, full 40-hex),
`records` (array of `{id, change, path}`), and `scanned` (changed files seen).

`deleted` is in the change vocabulary because removing a decision record is itself a governance
event — the one change to the corpus an `added`/`modified` pair cannot express at all.

**The root set is a fixed path prefix list, stated here so two runs cannot disagree:**

| Root | Why it is governance-bearing |
|---|---|
| `.decisions/` | the decision corpus itself — deliberately outside CODEOWNERS, so this is the guard that stays (#4927) |
| `.claude/` | agent and skill definitions the harness executes |
| `.github/` | workflows, CODEOWNERS and rulesets — the enforcement layer |
| `claude-plugins/` | every plugin's skills, contracts and rubrics, at any depth, whatever the extension |

`required` iff at least one changed path is under at least one root. **The directory is the unit of
coverage, not the file type** — the v1 §CP definition learned this the hard way: an enumerated
skill-dir list plus an any-depth `*.sh` clause left a non-`.sh` file beside a gated script
proven-ordinary and auto-mergeable at zero approvals. `self` is true when any changed path is under a
directory matching `*/skills/governance/` — **resolved, never hardcoded to phoenix's install path**,
for the same portability reason `governance base` states below. That directory is always a subset of
`claude-plugins/`, so this skill's own diff derives its own namespace by construction.

**This is not the §CP answer and the verb says so on stderr**, once, on every run:
`governance scope: this is the governance-namespace derivation, not a §CP classification — §CP is CODEOWNERS' answer.`

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404), or closed, or has **zero changed files** — a derivation over nothing (ADR 0092) |
| `10` | `--sha` is not a head SHA |
| `11` | the PR could not be read, or the commit could not be bound — the derivation is UNKNOWN, never `not-required` |
| `12` | `--sha` is not the PR's head — re-scope at the head |
| `13` | the changed-file enumeration is provably short (received < declared count) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance scope: PR #<n> not found in <repo>.` | 7 | refusal |
| `governance scope: PR #<n> is closed — nothing to derive.` | 7 | refusal |
| `governance scope: PR #<n> has zero changed files — refusing to derive over an empty diff (ADR 0092).` | 7 | refusal |
| `governance scope: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `governance scope: cannot read PR #<n> in <repo>: <reason> — whether the namespace is required is UNKNOWN, never "not-required".` | 11 | refusal |
| `governance scope: <what> — the file list cannot be bound to a commit, so the derivation is UNKNOWN.` | 11 | refusal |
| `governance scope: PR #<n>'s head is <live>, not <asked> — re-scope at <live> (ADR 0058).` | 12 | refusal |
| `governance scope: <sha> carries <k> of the <m> files #<n> declares — refusing to derive from a short read (#3999).` | 13 | refusal |
| `governance scope: root <name> is absent in this repository — the derivation covered <k> of 4 roots.` | 0 | notice |

**Scope** — one PR's metadata and the changed-file list of one bound commit, count-checked against
the declared total. Zero changed files is a refusal, never `not-required`: the whole value of a
`not-required` answer is that it was computed over everything.

**Examples**

```
$ fabrika governance scope 4321
governance	required	03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c
root	.decisions/	1
root	claude-plugins/	2
self	false
record	0240	added	.decisions/0240-only-landed-adrs-may-be-cited.md
```

```
$ fabrika governance scope 4400 --json
{"outcome":"not-required","head":"9f2c1a77b0e4d3586a1c9042bb7731ee5c0d18af","roots":[],"self":false,"records":[],"scanned":6}
```

**Grounding**

- #4386 / #3416 — §CP-by-content has no platform enforcement and only §CP-by-path hard-gates. This
  verb does not try to fill that gap with a content regex; it derives a *separate* namespace whose
  verdict is the skill's judgment, and leaves §CP to CODEOWNERS.
- The v1 §CP boundary's recorded holes — the enumerated skill-dir list, the `**/*.sh` clause, the
  `.claude-plugin/` hyphen miss — are why the root set is four directory prefixes and not a file-type
  or an enumeration that can rot as surfaces are added.
- #4060 — v1's `class-probe` read 0 files and classified `has-code` at exit 0; the zero-file case
  here is a `7` refusal.
- #5117 — the file list is the derivation's only input, so the list and the head are one commit or
  the verb refuses.
- `class-probe`'s `ReviewNamespace` is a closed three-value union keyed to v1's gate skills, so a new
  required namespace there is a type-level change. Here the requirement is a boolean over a root
  list, so a fifth root is a one-row edit with no type surgery.

---

## `governance sweep`

**Invocation**

```
fabrika governance sweep 4321 --record 0240 [--sha <head>] [--dir <path>] [--limit <n>] [--repo <owner/name>] [--json]
fabrika governance sweep --landed 0240 [--dir <path>] [--limit <n>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | no | — | the pull-request number the subject record lives in; required unless `--landed` is given |
| `--record` | string | no | — | the four-digit id of the decision record in that PR to sweep; required with the positional |
| `--landed` | string | no | — | sweep a record already in `--dir` instead of one in a PR — the digest-time mode; mutually exclusive with the positional and `--record` |
| `--sha` | string | no | the PR's live head | the head to read the subject record at; see the binding step above |
| `--dir` | string | no | `.decisions` | the corpus to rank against |
| `--limit` | integer | no | `8` | the maximum shortlist entries |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the answer as JSON on stdout instead of the line grammar |

**Output** — machine channel. First line is the outcome token —
`shortlist` · `no-overlap` · `indeterminate` — and on `shortlist`, one line per entry:
`<id>\t<score to 2dp>\t<file>\t<title>`.

With `--json`:
`{"outcome":…,"subject":"0240","entries":[{"id","score","file","title"}…],"reason":null|"…","scanned":<n>,"inScope":<n>,"cited":<n>}`.

<a id="sweep-all-three-are-answers"></a>
**All three outcomes exit 0 and all three are answers.** `no-overlap` is a distinct token, never an
empty shortlist, and **none of the three is a clearance** — a record that disagrees with the subject
about what a *label means* shares no distinctive vocabulary and never appears here at all. The
`reason` field carries that sentence verbatim on the `no-overlap` arm so a caller reading only the
JSON cannot mistake it for one.

`indeterminate` fires when the live-`accepted` corpus is below `RARITY_FLOOR` (10) — rarity is not
measurable and every term scores as common — or when the subject yields no distinctive terms. The
stderr reason names which of the two.

**The ranking core is imported, not restated.** `decisionBearingText`, `tokenize`, the idf scoring,
`RARITY_FLOOR` and `DEFAULT_LIMIT` come from `packages/fabrika-cli/src/adr/sweep.ts`. This verb owns
only the subject acquisition: `git show <bound-head>:<path>` for the PR mode, a corpus read for
`--landed`. Two runs of the two verbs over the same bytes therefore produce the same ranking by
construction rather than by agreement.

**Every score this spec prints is derivable from that module** — score is the sum over shared terms
of `log(n / max(df, 1))`, where `n` is the live-`accepted` count and `df` the document frequency,
counted only for terms with `df < n`. The example below is illustrative of the *shape*; an
implementer reproduces scores from the imported module, never from this document (#4735).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | `--dir` was read and held zero decision records — zero scope (ADR 0092); or the PR is proven absent (404) or closed |
| `10` | `--record` / `--landed` is not a four-digit id; `--sha` is not a head SHA; `--limit` is negative; or the positional and `--landed` were both given |
| `11` | the subject record could not be read at the bound commit, the commit could not be bound, **or a corpus member exists and could not be read** — an incomplete corpus is UNKNOWN |
| `12` | `--sha` is not the PR's head |
| `13` | the changed-file list proving `--record` is in this PR is provably short |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance sweep: scanned <dir>, 0 decision records — refusing to answer (ADR 0092).` | 7 | refusal |
| `governance sweep: PR #<n> not found in <repo>.` | 7 | refusal |
| `governance sweep: --record "<v>" is not a four-digit decision id.` | 10 | refusal |
| `governance sweep: --sha "<v>" is not a head SHA — expected 7–40 lowercase hex characters.` | 10 | refusal |
| `governance sweep: --limit <v> is negative — a shortlist cannot be shorter than empty.` | 10 | refusal |
| `governance sweep: pass a PR with --record, or --landed, never both.` | 10 | refusal |
| `governance sweep: #<n> at <sha> carries no decision record <id> — nothing to sweep.` | 11 | refusal |
| `governance sweep: cannot read <dir>/<file>: <reason> — an incomplete corpus is UNKNOWN, never "no-overlap".` | 11 | refusal |
| `governance sweep: <what> — the subject cannot be bound to a commit, so what it says is UNKNOWN.` | 11 | refusal |
| `governance sweep: PR #<n>'s head is <live>, not <asked> — re-sweep at <live> (ADR 0058).` | 12 | refusal |
| `governance sweep: <sha> carries <k> of the <m> files #<n> declares — refusing to prove <id> is in this PR from a short read (#3999).` | 13 | refusal |
| `governance sweep: ranked <k> uncited live-accepted records of <m> in scope.` | 0 | notice |
| `governance sweep: only <k> live-accepted records in <dir> (rarity needs at least 10) — the run carries no information.` | 0 | notice |

**Scope** — the live-`accepted` records in `--dir`, minus those the subject already cites. The scope
line names the corpus size and the in-scope count on stderr, because the outcome is only readable
against them. Zero records is a refusal; a corpus below the rarity floor is `indeterminate` at
exit 0, which is a different fact and stays a different answer.

**Examples**

```
$ fabrika governance sweep 4321 --record 0240
shortlist
0058	11.42	0058-sha-bound-verdict-contract.md	Gate verdicts are SHA-bound and one-per-gate
0164	7.08	0164-guard-relaxing-adr-cp-gate.md	A guard-relaxing ADR is control-plane
```

```
$ fabrika governance sweep --landed 0240 --json
{"outcome":"no-overlap","subject":"0240","entries":[],"reason":"no uncited live-accepted record shares a distinctive term with the subject — this is not a clearance: a record that disagrees about what a label means shares no vocabulary and never appears here","scanned":241,"inScope":232,"cited":9}
```

```
$ fabrika governance sweep --landed 0240 --dir claude-plugins/fabrika/skills/governance/evals/fixtures/small-corpus
governance sweep: only 4 live-accepted records in claude-plugins/fabrika/skills/governance/evals/fixtures/small-corpus (rarity needs at least 10) — the run carries no information.
indeterminate
$ echo $?
0
```

**Grounding**

- v1's `adr-sweep.sh` **exits non-zero on its own informative case** — a shortlist, the normal
  outcome of a healthy sweep, reads as a failed run to any caller keying on status — and its
  exit `1` is shared by shortlist, indeterminate and the CLI's own failure, while a `kp_pcli`
  failure exits `127` that its skill prose never mentions. All three outcomes exit `0` here and
  every failure has its own seat.
- v1's `--json` **lands on stderr on the shortlist path** and on stdout only for the useless clean
  report, because the report is routed through a `CheckFailed` (#4723). Here `--json` is on stdout
  for all three outcomes.
- v1's sweep never fetches; it reads whatever `.decisions/` the launching checkout holds (#4163,
  #4338). The subject here is read at a bound commit and the corpus read is count-reported.
- The citation-independence rule is v1's one good idea, kept: the candidate set is never derived
  from the subject's own reference list, because a document that never names what it contradicts
  gives you no thread to pull (#3980).
- #4735 — a spec that prints a score it cannot derive is incomplete; the derivation is stated above
  and the module that owns it is named.

---

## `governance guards`

**Invocation**

```
fabrika governance guards 4321 [--sha <head>] [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--sha` | string | no | the PR's live head | the head to read the diff at; see the binding step above |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line:
`guards\t<hits|no-anchor-change|no-anchors-in-reach>\t<anchors-in-reach>` — the third field is how
many anchored invariants exist in the files this diff touches. Then one line per hit:
`anchor\t<removed|modified>\t<NAME>\t<file>:<line>`, and one line per touched guard-bearing file
with no anchor change: `guard-file\t<path>\t<anchor-count>`.

With `--json`:
`{"outcome":…,"hits":[{"kind","name","file","line"}…],"guardFiles":[{"path","anchors"}…],"inReach":<n>,"scanned":<files>}`.

**The three outcomes are distinct facts and none is a clearance.** `hits` — an anchored invariant
was removed or its line changed. `no-anchor-change` — anchors exist in the diff's reach and none
moved. `no-anchors-in-reach` — the touched files carry no anchors at all, so this scan had nothing
to look at; it is the mechanical floor reporting its own silence, not a statement that no guard was
weakened. A guard weakened in prose that carries no anchor is invisible here **by construction**,
and the skill's judgment is what covers it.

**What an anchor is.** The `<!-- anchor: NAME -->` HTML comment fabrika skills already carry; NAME is
`[A-Z][A-Z0-9-]*`. The scan is over the diff's removed and added lines, pairing by NAME: a NAME
present in a removed line and absent from every added line is `removed`; a NAME on both sides with
different following text is `modified`.

**What a guard-bearing file is, stated closed so two implementers build one verb.** A changed file is
guard-bearing iff it satisfies at least one of: (a) it contains at least one anchor at the bound
commit; (b) it is under `.github/workflows/`; (c) it is owned by a control-plane team row in
`.github/CODEOWNERS`. Nothing else qualifies — in particular, "a file that looks important" is not a
criterion, and the verb does not read file content beyond the anchor scan. Clause (c) reads
CODEOWNERS **only to decide whether to print a `guard-file` row**; it computes no §CP verdict and
prints no §CP value. Where CODEOWNERS is unreadable, clauses (a) and (b) still apply and the omission
goes to stderr — the row list narrows, and `inReach` is unaffected because it counts anchors.

**Why the inventory is not in this verb.** v1's gate-invariant check kept a hardcoded prose list of
what each gate promises, inside the reviewing skill — a copy of the guarded files, which drifts from
them silently and which nothing checks. Anchors live in the guarded file itself, so the set cannot
rot while the guards move. That is the whole design difference, and it is why this verb reports
anchors rather than invariants.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed, or has zero changed files |
| `10` | `--sha` is not a head SHA |
| `11` | the diff could not be read, or the commit could not be bound — UNKNOWN, never `no-anchor-change` |
| `12` | `--sha` is not the PR's head |
| `13` | the diff is provably incomplete — fewer files than the PR declares; a partial scan must never print beside a "nothing moved" answer |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance guards: PR #<n> not found in <repo>.` | 7 | refusal |
| `governance guards: PR #<n> has zero changed files — nothing to scan (ADR 0092).` | 7 | refusal |
| `governance guards: --sha "<v>" is not a head SHA — expected 7–40 hex characters.` | 10 | refusal |
| `governance guards: <what> — the diff cannot be bound to a commit, so what it shows is UNKNOWN.` | 11 | refusal |
| `governance guards: cannot read the diff for #<n> at <sha>: <reason> — UNKNOWN, never "nothing moved".` | 11 | refusal |
| `governance guards: PR #<n>'s head is <live>, not <asked> — re-scan at <live> (ADR 0058).` | 12 | refusal |
| `governance guards: the diff at <sha> carries <k> of #<n>'s <m> declared files — refusing a partial anchor scan (#3925's class).` | 13 | refusal |
| `governance guards: scanned <k> files, <m> anchored invariants in reach.` | 0 | notice |

**Scope** — the bound commit's diff, completeness-checked against the PR's declared changed-file
count, and the anchors in every file that diff touches. A truncated diff is refused rather than
scanned, because an under-reported hit list reads as a checked-clean answer that was never checked.

**Examples**

```
$ fabrika governance guards 4321
guards	hits	6
anchor	modified	UNSEEN-NEVER-PLAUSIBLE	claude-plugins/fabrika/skills/review/SKILL.md:12
guard-file	claude-plugins/fabrika/skills/ship/SKILL.md	3
```

```
$ fabrika governance guards 4400
guards	no-anchors-in-reach	0
```

```
$ fabrika governance guards 4321 --json
{"outcome":"hits","hits":[{"kind":"modified","name":"UNSEEN-NEVER-PLAUSIBLE","file":"claude-plugins/fabrika/skills/review/SKILL.md","line":12}],"guardFiles":[{"path":"claude-plugins/fabrika/skills/ship/SKILL.md","anchors":3}],"inReach":6,"scanned":4}
```

**Grounding**

- v1 `review-skill` Step 4 check 4 — "does the edit quietly weaken a gate?", the most serious verdict
  that gate lands, whose evidence form is the exact removed or softened line and the invariant it
  breaks. That judgment moves here whole; only its hardcoded invariant inventory is left behind.
- The worked v1 FAIL is the shape this scan is calibrated on: a diff dropping the `@ <sha>` from the
  shipper's matcher, so the SHA-staleness refusal no longer fires.
- v1's explicitly-empty answer is kept and made mechanical: a non-gate-critical PR records "no gate
  invariant is in the diff's reach" as a PASS with that evidence. `no-anchors-in-reach` is that
  answer's machine half — an explicitly-empty answer rather than an unwritten one.
- #4000 — a PR shipped an invariant-narrowing change in skill text with no authorizing ADR, and the
  reviewer-required ADR was never filed. The hit list is what makes that finding concrete enough to
  survive an agreement that nobody wrote down.
- ADR 0092 — the scan states its scope (`inReach`) on its own channel, so "I scanned nothing and
  found nothing" is never renderable as a pass.

---

## `governance base`

**Invocation**

```
fabrika governance base 4321 [--path <repo-relative>] [--repo <owner/name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number whose merge-base is resolved |
| `--path` | string, repeatable | no | this skill's `SKILL.md` and `contract.md` | a repo-relative path inside this skill's own directory to read at the merge-base; see the fence below |
| `--repo` | string | no | resolved | the repository |

**Output** — machine channel. First line: `base\t<merge-base-sha>\t<file-count>`. Then, per path, a
header line `file\t<path>\t<byte-count>` followed by that file's bytes at the merge-base. No
`--json`: the bytes are the object.

**This verb exists so the self fence is a pasteable literal.** The skill's rule — judge a
self-editing PR by the merge-base revision of its own text — needs a merge-base SHA the model would
otherwise have to compute and interpolate, which the harness's isolation verifier refuses (interface
convention rule 5: every documented invocation is a plain literal command string). Resolving a merge
base and reading named paths at it is mechanical; judging by them is not.

**`--path` is fenced to this skill's own directory, resolved rather than hardcoded.** A path is
admitted iff it lies under a directory matching `*/skills/governance/` at any depth — in phoenix that
is `claude-plugins/fabrika/skills/governance/`, and in a repo that homes its plugins elsewhere it is
whatever that repo's install path is. **Do not hardcode phoenix's path**: this skill ships to other
repositories, and a literal `claude-plugins/fabrika/` fence would refuse the self fence in every one
of them — the failure a run of this spec surfaced. The fence itself is deliberate: this verb exists
for the self fence, and a general "read any file at the merge-base" verb would be a second way to
load instructions out of a tree, which is what the whole no-checkout posture exists to prevent.
Nothing is checked out here either; the bytes come from the object database.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the PR is proven absent (404) or closed; or every `--path` is proven absent at the merge-base — a self fence over no bytes |
| `10` | a `--path` resolves outside this skill's own directory (a path not under a `*/skills/governance/` root) |
| `11` | the merge base could not be resolved, or a path could not be read at it — the base rules are UNKNOWN, so no fallback to the head is taken |
| `12` | the PR's head moved while the base was being resolved — re-run; a base paired with a head nobody judged is not a fence |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance base: PR #<n> not found in <repo>.` | 7 | refusal |
| `governance base: none of the requested paths exist at merge-base <sha> — there is no base revision to judge by.` | 7 | refusal |
| `governance base: --path "<v>" is outside this skill's own directory (<resolved>) — this verb reads only this skill's own text.` | 10 | refusal |
| `governance base: cannot resolve the merge base of #<n>: <reason> — the base rules are UNKNOWN; refusing to judge by the head's.` | 11 | refusal |
| `governance base: cannot read <path> at <sha>: <reason> — UNKNOWN.` | 11 | refusal |
| `governance base: #<n>'s head moved to <live> while resolving — re-run.` | 12 | refusal |
| `governance base: merge base of #<n> is <sha>.` | 0 | notice |

**Scope** — one merge base and the named paths at it. Zero readable paths is a refusal: a self fence
that reads nothing would silently fall back to judging by the head's rules, which is the exact
failure the fence exists to prevent.

**Examples**

```
$ fabrika governance base 4321
base	8b1e0c4499ad72f635e0117a9bb2d3c058e7fa16	2
file	claude-plugins/fabrika/skills/governance/SKILL.md	9812
---
name: governance
description: The governance-corpus integrity gate — one judgement, asked of any diff…
```

```
$ fabrika governance base 4321 --path claude-plugins/fabrika/skills/review/SKILL.md
governance base: --path "claude-plugins/fabrika/skills/review/SKILL.md" is outside this skill's own directory (claude-plugins/fabrika/skills/governance/) — this verb reads only this skill's own text.
$ echo $?
10
```

**Grounding**

- ADR 0052 — the BASE-revision pin: a gate must not review a PR by the instructions that PR
  introduces. v1 enforced it with a denylist that removed the head's instruction surfaces from a
  worktree; here nothing is checked out at all, so there is no surface to remove and the fence is
  a positive read of named base bytes instead of a negative scrub.
- The `11` refusal never falls back to the head. A self fence that degrades to the head's rules on a
  failed read is a fence that opens exactly when it is being tested.

---

## `governance post`

**Invocation**

```
fabrika governance post 4321 --polarity PASS --sha 03135b91 --clause "no contradiction, no weakening" [--repo <owner/name>] [--json]
```

The verdict body arrives on **stdin only** — no `--body`, no `--body-file`, for the reason the
sibling write verbs give: a path flag is how a machine-local path reaches a public surface while the
poster reads success.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the pull-request number |
| `--polarity` | enum | yes | — | `PASS` or `FAIL` — a third token is not a polarity |
| `--sha` | string | yes | — | the head the reviewer actually inspected (7–40 lowercase hex) |
| `--clause` | string | yes | — | the human clause; blank is not a clause |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | markdown | yes | — | the verdict body below the first line: the questions swept, the sweep outcome, the domain read by hand, the anchored invariants in reach and their disposition |

**Output** — machine channel. One line:
`posted\tgovernance\t<polarity>\t<sha>\t<created|edited>\t<comment-url>`.
With `--json`:
`{"outcome":"posted","namespace":"governance","polarity":…,"sha":…,"upsert":"created"|"edited","commentUrl":…}`.

**The namespace is fixed.** There is no `--namespace` flag: this verb emits exactly one namespace and
composing another is not a mode it has. That is the disjointness guarantee made structural in the
other direction from `review post`, which refuses a namespace outside its derived set — here the
namespace is a constant, so it cannot be aimed anywhere else even by a confused caller.

**What the operation does, in order — each step gates the next.**

1. **Re-resolve the live head.** `--sha` not prefix-matching it is the `12` refusal: a verdict formed
   over a moved-past tree is re-reviewed, never re-bound.
2. **Re-derive the namespace requirement at the bound commit** — the same derivation
   `governance scope` prints, through the shared binding step. A PR that derives `not-required` is
   the `14` refusal. This is the fail-closed condition inverted at the write seam: the namespace
   cannot be filled on a diff that did not require it, so a governance PASS always attests a diff
   that was actually in scope.
3. **Compose the first line through the wire format's `emit`**
   (`packages/fabrika-cli/src/wire/verdict-marker.ts`, imported — fields
   `namespace`/`polarity`/`sha`/`clause`), giving
   `governance: PASS @ <sha> — <clause>`. This requires the namespace widening specified above; until
   it lands, `emit` composes bytes `read` rejects and step 6 fails every clean run.
4. **Leak-scan the assembled comment** (`report/leaks.ts`, imported) — an authored machine-local path
   is the `5` refusal, a bare `@` reference the `6`.
5. **Upsert one comment.** An existing comment by this bot whose first non-blank line reads as the
   `governance` namespace is edited in place; otherwise a new comment is created. One namespace, one
   comment: a second marker stacked on line 2 is un-anchored, resolves the namespace empty and
   fail-closes a substantively-passing PR.
6. **Read it back, unconditionally, from live PR state** — re-fetch the comment, hand its body to the
   format's `read`, require `Found` with exactly the four fields posted, then compare the whole
   comment against the bytes sent through `normalizeForReadback`. A read-back that trusts a carried
   variable instead of live state re-ships #3173's false PASS.

**No advisory carrier.** `review post` takes `--carrier advisory` for §CP PRs, where a human approval
is the gate. This verb has no such mode: §CP is not this namespace's question, the governance verdict
is never the §CP approval, and a carrier flag here would be a second §CP answer wearing an input's
clothes.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty verdict body would read as UNGATED |
| `5` | the assembled comment carries a machine-local path |
| `6` | the body is a bare `@` path reference — the body never arrived |
| `7` | the PR is proven absent (404) or closed |
| `8` | the create/edit failed — UNKNOWN whether a comment landed |
| `9` | the comment landed but the read-back does not yield this marker |
| `10` | a bad `--polarity`, a `--sha` that is not a head SHA, or a blank `--clause` |
| `11` | a precondition read failed — the PR, the live head, or the commit binding the re-derivation rests on |
| `12` | the live head moved past `--sha` — re-review at the new head, never re-bind |
| `14` | this PR's diff derives no governance namespace — refusing to fill a namespace it did not require |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance post: no body on stdin — an empty verdict reads as UNGATED; pipe the verdict body in.` | 3 | refusal |
| `governance post: the assembled comment carries a machine-local path at line <k> (<class>) — cite it repo-relative or by class root.` | 5 | refusal |
| `governance post: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.` | 6 | refusal |
| `governance post: PR #<n> not found in <repo>.` | 7 | refusal |
| `governance post: PR #<n> is closed — a verdict on a closed PR gates nothing.` | 7 | refusal |
| `governance post: --polarity must be PASS or FAIL — got "<v>". A third token is not a polarity.` | 10 | refusal |
| `governance post: --sha "<v>" is not a head SHA — expected 7–40 lowercase hex characters.` | 10 | refusal |
| `governance post: --clause is blank — a verdict with no clause states nothing.` | 10 | refusal |
| `governance post: cannot read <what> for #<n>: <reason> — nothing was posted.` | 11 | refusal |
| `governance post: the live head is <live>, not <sha> — the tree you judged is gone; re-review at <live> (ADR 0058).` | 12 | refusal |
| `governance post: #<n>'s diff touches no governance root (<roots>) — the namespace is not required here, and a verdict in it would attest a scope nobody derived.` | 14 | refusal |
| `governance post: create/edit failed: <reason> — UNKNOWN whether the verdict landed; re-read #<n>'s comments before retrying.` | 8 | refusal |
| `governance post: posted, but the read-back does not yield this marker (<wire reason>) — the PR may carry a garbled verdict; inspect comment <id>.` | 9 | refusal |

**Scope** — one PR: its live head, the bound commit's file list for the re-derivation, its comments,
and the caller's stdin. A read failing at any of those is `11` — nothing written, outcome
known-unwritten.

**Examples**

```
$ fabrika governance post 4321 --polarity PASS --sha 03135b91 --clause "no contradiction, no weakening" < verdict.md
posted	governance	PASS	03135b91	created	https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5154902211
```

```
$ fabrika governance post 4321 --polarity PASS --sha 03135b91 --clause "no contradiction, no weakening" --json < verdict.md
{"outcome":"posted","namespace":"governance","polarity":"PASS","sha":"03135b91","upsert":"created","commentUrl":"https://github.com/kamp-us/phoenix/pull/4321#issuecomment-5154902211"}
```

```
$ fabrika governance post 4400 --polarity PASS --sha 9f2c1a77 --clause "ok" < verdict.md
governance post: #4400's diff touches no governance root (.decisions/, .claude/, .github/, claude-plugins/) — the namespace is not required here, and a verdict in it would attest a scope nobody derived.
$ echo $?
14
```

**Grounding**

- ADR 0058 — the marker is SHA-bound and one-per-(PR, namespace), upserted rather than appended. The
  key is unchanged by this group: nothing in the enqueue decision asks which skill posted a
  namespace, which is what makes one skill emitting N namespaces, and a namespace filled by a
  non-primary reviewer, both already legal.
- #3173 — a hand-rolled emit posted a literal path and self-reported a false PASS; this verb is the
  single sanctioned path and the read-back is unconditional and from live state.
- ADR 0055 — authority arrives through the ACL-checked read, never from the text being plausible.
  The verdict body is authored by this run, so `5`/`6` apply to it: authored text is refusable
  because the author can fix it.
- The `14` refusal is the fail-closed condition's write-seam half. Absence of a verdict on a
  required diff is a refusal downstream; presence of one on a non-required diff is a refusal here.
  Both directions exist so the namespace means exactly one thing.

---

## `governance digest`

**Invocation**

```
fabrika governance digest --since 2026-08-02 [--until <YYYY-MM-DD>] [--dir <path>] [--base <ref>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--since` | string | yes | — | the window's inclusive start, `YYYY-MM-DD` |
| `--until` | string | no | now | the window's inclusive end, `YYYY-MM-DD` |
| `--dir` | string | no | `.decisions` | the corpus whose landings are listed |
| `--base` | string | no | `origin/main` | the ref whose history is walked; fetched before the walk |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel. First line: `digest\t<landed|none>\t<count>`. Then one line per landed
record, oldest first:
`landed\t<NNNN>\t<status>\t<commit>\t<YYYY-MM-DD>\t<anchors-touched>\t<title>` — where
`<anchors-touched>` is the number of anchored invariants the landing commit's own diff changed, the
blast-radius input the ranking needs.

With `--json`:
`{"outcome":"landed"|"none","count":<n>,"records":[{"id","status","commit","date","anchorsTouched","title","path"}…],"window":{"since","until"},"base":"origin/main"}`.

`none` is a **proven** answer at exit 0 — the window was walked and nothing landed in it. Empty
stdout would be byte-identical to a verb that never ran, which is the v1 scar this group's shared
conventions name.

**The `status` field is reported, never interpreted.** It is the frontmatter line as written. Nine
records on `main` read `proposed` while being enforced at a live gate (#4388), ADR 0164 among them,
so a consumer that treats `proposed` as "not law" is reading a claim as an observation. The verb
prints what is there and the skill judges what it means.

**This verb ranks nothing.** Tension and blast radius are the two ruled ranking dimensions and both
are judgment; a ranking verb would be a second judgement wearing a verb's clothes, and would also
grow the rubric past what #4927 authorized.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | `--dir` is proven absent, or holds zero decision records — zero scope (ADR 0092) |
| `10` | `--since` or `--until` is not `YYYY-MM-DD`, or `--until` precedes `--since` |
| `11` | `--base` could not be fetched or resolved, or a landing commit could not be read — the window is UNKNOWN, never `none` |
| `13` | the history walk is provably incomplete — a shallow clone whose graft boundary falls inside the window |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance digest: scanned <dir>, 0 decision records — refusing to answer (ADR 0092).` | 7 | refusal |
| `governance digest: --since "<v>" is not a YYYY-MM-DD date.` | 10 | refusal |
| `governance digest: --until <b> precedes --since <a> — an empty window is a usage error, not a result.` | 10 | refusal |
| `governance digest: cannot fetch or resolve <base>: <reason> — what landed is UNKNOWN, never "none".` | 11 | refusal |
| `governance digest: cannot read landing commit <sha>: <reason> — the window is UNKNOWN.` | 11 | refusal |
| `governance digest: the history is shallow and its boundary <sha> falls inside the window — refusing a partial landing list (#3999's class).` | 13 | refusal |
| `governance digest: walked <base> from <since> to <until>, <k> commits touching <dir>.` | 0 | notice |

**Scope** — the commits on `--base` between `--since` and `--until` that touch `--dir`, and for each
landed record its frontmatter and its landing commit's anchor delta. The scope line names the base,
the window and the commit count, because `none` is only readable against them.

**Examples**

```
$ fabrika governance digest --since 2026-08-02
digest	landed	2
landed	0238	accepted	aab2adea	2026-08-06	0	fabrika reimplements v1, never calls it
landed	0240	accepted	1f8e83b1	2026-08-08	2	Only landed ADRs may be cited
```

```
$ fabrika governance digest --since 2026-08-09 --until 2026-08-09 --json
{"outcome":"none","count":0,"records":[],"window":{"since":"2026-08-09","until":"2026-08-09"},"base":"origin/main"}
```

The window is inclusive at both ends, so this second example is `none` only because neither landing
above falls on `2026-08-09` — `0240` lands on `2026-08-08` and would be inside a window ending there.

**Grounding**

- #4927 comment 5227714776 — the founder's condition for retiring the human gate on ADRs: a
  periodic, non-blocking digest of landed decisions, ranked by this skill. "Without the readout,
  overrule-later is fiction — this half is not droppable." This verb is the listing mechanics that
  ruling required to be a verb rather than prose in a skill.
- #4388 / #4391 — `status:` does not track what is binding; the field is reported verbatim and the
  hazard is stated rather than silently normalized.
- #4338 — the base is fetched before the walk, because a stale checkout is how withdrawn doctrine
  gets applied after its withdrawal.
- ADR 0092 — `none` over a corpus that could not be read is not `none`; the read failure is `11`.

---

## `governance readout`

**Invocation**

```
fabrika governance readout 4952 [--repo <owner/name>] [--json]
```

The ranked rows arrive on **stdin** — one row per line in the `governance-digest` line grammar.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | yes | — | the issue number of the durable readout artifact the front door reads |
| `--repo` | string | no | resolved | the repository |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | text | yes | — | the ranked rows: `row\t<NNNN>\t<tension\|blast\|routine>\t<one-line note>`, highest consequence first |

**Output** — machine channel. One line:
`readout\t<issue>\t<row-count>\t<created|edited>\t<comment-url>`.
With `--json`: `{"outcome":"readout","issue":…,"rows":<n>,"upsert":"created"|"edited","commentUrl":…}`.

**The row vocabulary is closed**, and the verb refuses a row outside it. The three kinds are
`tension` (the record sits against standing law), `blast` (wide reach, no tension found) and
`routine`. Free prose is confined to the one-line note, and the note is a *pointer*, not a
judgement a receiver acts on: the front door re-fetches the referenced records and reads them
itself. That is what keeps a coordination artifact from steering its receiver.

**Non-blocking by construction.** This verb writes a comment and nothing else. It sets no label,
touches no PR, and has no exit code meaning "the corpus is in a bad state" — because a digest that
could red would be the human gate the #4927 ruling retired, wearing a new name. Every outcome here
is either "the readout landed" or "the readout did not land".

**The operation:** compose the rows through the `governance-digest` wire format's `emit`;
leak-scan the assembled body; upsert the single comment on the artifact issue whose first non-blank
line reads as this format; re-fetch and read it back through the format's `read`, requiring the same
rows in the same order, then compare the whole body through `normalizeForReadback`.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was read and held nothing — an empty readout is not a readout |
| `5` | the assembled body carries a machine-local path |
| `6` | the body is a bare `@` path reference |
| `7` | the artifact issue is proven absent (404) or closed — the readout has nowhere durable to land |
| `8` | the create/edit failed — UNKNOWN whether the readout landed |
| `9` | it landed but the read-back does not yield the same rows in the same order |
| `10` | a row's kind is outside `tension` / `blast` / `routine`, or a row's id is not four digits |
| `11` | the issue or its comments could not be read — nothing was written |
| `13` | the comment enumeration is provably short of its declared count, so the upsert target is unknown |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `governance readout: no rows on stdin — an empty readout is not a readout.` | 3 | refusal |
| `governance readout: the assembled body carries a machine-local path at line <k> (<class>) — cite it repo-relative.` | 5 | refusal |
| `governance readout: the body is a bare "@" path reference — the rows never arrived. Send them on stdin.` | 6 | refusal |
| `governance readout: issue #<n> not found in <repo> — the readout artifact is absent; front-door creates it (#4952).` | 7 | refusal |
| `governance readout: issue #<n> is closed — a readout nobody reads is not a readout.` | 7 | refusal |
| `governance readout: row <k>'s kind "<v>" is outside tension/blast/routine.` | 10 | refusal |
| `governance readout: row <k>'s id "<v>" is not a four-digit decision id.` | 10 | refusal |
| `governance readout: cannot read #<n>: <reason> — nothing was written.` | 11 | refusal |
| `governance readout: received <k> of <m> comments on #<n> — refusing to upsert against a partial sweep.` | 13 | refusal |
| `governance readout: create/edit failed: <reason> — UNKNOWN whether the readout landed; re-read #<n> before retrying.` | 8 | refusal |
| `governance readout: landed, but the read-back does not yield the same rows — inspect comment <id>.` | 9 | refusal |

**Scope** — one issue and its comments, plus the caller's stdin. The artifact is one comment,
upserted, so a reader always finds exactly one current readout rather than an append stream.

**Examples**

```
$ printf 'row\t0240\ttension\tsits against ADR 0058 on whether a verdict may bind an unread head\nrow\t0238\troutine\tno tension found\n' | fabrika governance readout 4952
readout	4952	2	edited	https://github.com/kamp-us/phoenix/issues/4952#issuecomment-5229900001
```

```
$ printf 'row\t0240\troutine\tno tension found\n' | fabrika governance readout 4952 --json
{"outcome":"readout","issue":4952,"rows":1,"upsert":"edited","commentUrl":"https://github.com/kamp-us/phoenix/issues/4952#issuecomment-5229900001"}
```

**Grounding**

- #4927 comment 5227714776 — the readout is the non-droppable condition on retiring the ADR human
  gate. The producer half is this verb; the display half is #4952's.
- ADR 0058 rule 2 — upsert, never append: one current record rather than a stream a timestamp
  decides between. The same reasoning applies to a readout as to a verdict.
- #4481 — a periodic sweep re-files what a standing ruling already killed unless something stops it.
  The rows are authored per run by the skill, which cites the ruling and drops the row; this verb
  refuses nothing on that basis, because a verb that judged a row's novelty would be judging.
- #4761 / #4829 — the front door cannot reach this artifact by skill routing yet; the artifact is an
  issue precisely so it is reachable without any routing at all.

---

## Required repo files

The skill's works-here checklist is stated once, in [`SKILL.md`](SKILL.md)'s "Required repo files"
section, with the closed **fail-loud / degrade / bootstrap** vocabulary every fabrika skill shares.
The verb-level facts behind those rows are the `7` / `11` / `13` seats in the matrix above, so this
spec adds nothing to that table rather than restating it in a second home.

Two rows bear directly on an implementer and are worth naming here, because they are the ones a
foreign repo will hit first: a repository with no `.decisions/` at all makes `governance sweep` and
`governance digest` exit `7` rather than answer `no-overlap` or `none`, and a repository holding
fewer than ten live-`accepted` records makes every sweep `indeterminate` at exit `0`. Neither is a
bug report; both are the fail-closed direction, and the second is why `indeterminate` is a distinct
token rather than a quiet `no-overlap`.

## The eval-enumeration obligation (leaf rule)

Stated once, in [`SKILL.md`](SKILL.md)'s "Eval enumeration" section — the single home #4891's
obligation lives in. This spec adds nothing to it; the eval mechanics belong to
[#4649](https://github.com/kamp-us/phoenix/issues/4649).

## Open questions this spec does not decide

- **Is a founder ruling recorded on an issue binding law for this judgement?**
  [#4982](https://github.com/kamp-us/phoenix/issues/4982) is open. Until it is ruled, the
  conservative floor above holds: a ruling cited from an issue is evidence to name in a verdict body,
  never the sole ground for a FAIL, and a *relayed* ruling is indistinguishable from a fabricated one
  ([#4441](https://github.com/kamp-us/phoenix/issues/4441)).
- **Does ADR 0092's fail-closed rule extend from zero scope to stale scope?**
  [#4628](https://github.com/kamp-us/phoenix/issues/4628) is open. This spec takes the conservative
  side already — every read fetches and binds — so a ruling either way leaves these verbs correct.
- **Does the ADR-0231/0233 enforcement row belong to this skill's gate half or to `review`'s skill
  rubric?** [#4560](https://github.com/kamp-us/phoenix/issues/4560) is open against the v1 gate. The
  gate-invariant judgement is this skill's, so the row lands here when it is ruled; nothing in this
  spec assumes it has been.
