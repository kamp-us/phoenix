# `/fabrika` (front-door) — derived CLI contract

**Skill:** [`front-door`](SKILL.md) · **Authoring brief:** [#4952](https://github.com/kamp-us/phoenix/issues/4952) · **Date:** 2026-08-09

These verbs live in `packages/fabrika-cli/`, binary `fabrika`, grouped under a `status` subcommand
beside the groups registered in `packages/fabrika-cli/src/registry.ts` — at the time of writing
`adr`, `build`, `epic`, `hook`, `plan`, `report`, `review`, `review-ui`, `ship`, `spend`,
`triage`, `ui` and `wire`. That list grows most weeks, so **read the file rather than this
sentence**. `status` was confirmed free there against a freshly fetched `origin/main` immediately
before this spec landed. The [CLI interface convention](../../docs/cli-interface-convention.md)
governs these verbs; where this spec and that doc disagree, the doc wins and this spec is the bug.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill**
([ADR 0238](../../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md)). v1's `doctor`
skill and `doctor.sh`, and the `run-evidence`, `epic-ledger` and `decisions-index` tools, were read
for their semantics and their scars — each Grounding section names what the v1 counterpart gets
wrong and what this spec does instead — but no clause defers to one and none is invoked.

**Substrate.** Effect CLI verbs on the `@effect/platform-node` seam the sibling groups use; GitHub
access per
[skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql).

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `status open` | the composite front-door readout: five fields, each with its own state, source and freshness | assembling five independent reads and rendering each one's three-state outcome is a total function; deciding what to *do* about a gap is the skill's |
| `status config` | which repo surfaces every landed skill declares it needs, and whether each is present here | parsing a fixed table shape and probing a path or a label is mechanical, zero judgement (the founder's detection-verb ruling, #4952); drafting a missing surface's *content* is judgment |
| `status settings` | every key on the `.fabrika.jsonc` config surface, its resolved value, and where that value came from | resolving a key against a shipped default and naming its provenance is a total function; deciding what a repo *should* declare is judgment |
| `status menu` | the landed skill roster with each skill's invocation and one-line description | reading a directory and each file's frontmatter is a total function; choosing which skill fits the work at hand is judgment |
| `status readout` | the landed-decision digest as published in the durable artifact | fetching an artifact and decoding a registered wire format is mechanical; ranking the rows is `governance`'s judgment and is not recomputed here |
| `status board` | counts of the board's decided buckets, each with its own freshness | counting labelled issues over named REST endpoints is arithmetic; ranking or picking from them is `build pick`'s |
| `status bootstrap` | create one missing repo surface from this group's own buildable-surface registry, and read it back | the write, the collision guard and the read-back are a protocol; what the file *says* is judgment the skill forms by inference and grilling |

### Considered and deliberately not derived

Each is a real proposal someone could make again. (Conventions §7 homes these in a plugin-root
`.out-of-scope/`, which no fabrika skill has bootstrapped yet; until it exists they live inline, the
same tracked debt the sibling contracts carry.)

- **A ranking of the decision digest.** Tension-with-standing-law and blast-radius are the two ruled
  ranking dimensions and both are judgment, owned by `governance` (#4949, #4927). A second ranking
  here would be a rival answer and would grow a rubric past what the founder authorized. This group
  **displays** rows and computes no order of its own.
- **A decision-index or ADR-corpus validator.** `.github/workflows/decisions-index.yml` job
  `validate` runs on every pull request. A status field restating it would compute a second answer to
  an enforced question.
- **A §CP or control-plane classifier.** CODEOWNERS decides, enforced by GitHub and by
  `.github/workflows/codeowners-cp.yml`. This group reads no CODEOWNERS and states no ownership.
- **A pickability or ranking verb.** `fabrika build pick` and `build eligible` already answer which
  issue is next, fail-closed on every axis. `status board` prints bucket **counts** and routes to
  those verbs; a second ranking would contradict the one that actually claims work.
- **A per-PR gate-state field.** `fabrika build verdicts`, `ship gate` and `ship checks` each answer
  it, and what marks a PR "banked" and what clears it on a head-move is an **open decision**
  ([#4103](https://github.com/kamp-us/phoenix/issues/4103)). Rendering a settled bank state would
  publish a decision nobody made.
- **A cross-group exit-code decoder.** The interface convention permits cross-group code reuse
  precisely because no reader resolves a numeral without knowing its group
  ([rule 3](../../docs/cli-interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is)).
  A composite readout that shelled out to sibling verbs and mapped their exit codes would be **the
  first such reader**, turning every legitimate reuse in the package into a defect. `status open`
  composes by **importing pure cores** ([mapping](#core-to-field)), never by spawning a sibling verb
  and reading its status.
- **A skill-content or quality judgement.** `review` owns that. The menu reports what a skill's
  frontmatter says about itself and never assesses it.

### Nothing here recomputes an enforced answer

The enforced questions are: ADR-index integrity (`decisions-index.yml` job `validate`), the §CP path
boundary (`codeowners-cp.yml` job `check`, plus `ci.yml` job `skills`), the enqueue conjunction
(`fabrika ship gate`), typecheck/lint/tests, leaks, secrets and dead links — each with the workflow
or verb that owns it. This spec computes no second verdict on any of them. Repo-surface presence and
the skill roster are enforced at no CI seam — verified by grepping `.github/workflows/` — which is
why they are legitimately verbs here.

### The group name, and the one thing it reads close to

`status` is the name the authoring brief specifies and every acceptance criterion cites. It is free
at the group level and `fabrika <group> <verb>` always names its group, so there is no parse
conflict. **One readability caveat, recorded rather than hidden:** `fabrika lane status <n>` already
exists (`packages/fabrika-cli/src/lane/status-verb.ts`) and means *the state of one lane*, where
`fabrika status <verb>` means *the state of the factory*. `state`, `ground` and `posture` were free
alternatives. (The caveat first read against the retired epic conductor's own status verb.) **The
brief's name is settled here**; the readability trade is recorded in the authoring pull request for
the founder to re-price before the verbs are built, because a group name is the one thing that is
expensive to change after shipping.

### Routing — nothing on `main` reaches a fabrika skill

`CLAUDE.md` pins skill routing to the `.claude/skills` filesystem path, a symlink to the v1 tree, so
no path reaches any fabrika skill. The gap is already filed —
[#4761](https://github.com/kamp-us/phoenix/issues/4761),
[#4762](https://github.com/kamp-us/phoenix/issues/4762) and
[#4829](https://github.com/kamp-us/phoenix/issues/4829) — and is recorded in the authoring pull
request rather than patched from here, the same disposition `review`, `ship` and `governance` took.
**This skill is a special case worth stating:** it is `disable-model-invocation: true`, so no routing
*instruction* could reach it anyway — a human types it.

## Shared conventions

Stated once rather than repeated per block.

- **Answer channel: machine.** Stdout carries the answer and nothing else; scope lines, refusal
  reasons and progress go to stderr. Every "nothing found" case prints a state word — empty stdout is
  byte-identical to a verb that never ran, and `emit`'s `if (outcome.stdout !== "")` writes literally
  nothing for an empty answer, so an absence here is unrecoverable by the caller.
- <a id="separator"></a>**Every line is TAB-separated, and every field is tab-free.** A `<detail>`
  field is a single line of prose that may contain spaces and must not contain a tab or a newline:
  the implementation strips both, then clamps to 120 characters. Prose describing a shape is not a
  shape (interface rule 2), and a space-separated answer channel with prose in it is unparseable.
- **Common inputs.** `--repo <owner/name>` (default: `$CLAUDE_PIPELINE_REPO`, else
  `$GITHUB_REPOSITORY`, else the `origin` remote) — resolved through `resolveRepo` in
  `packages/fabrika-cli/src/io/issues.ts`, the chain the shipped groups already use. `--json` swaps
  the line grammar for one object.
- **An unresolvable repo is exit `1` for the three verbs whose answer requires it** (`board`,
  `readout`, `bootstrap` for a non-file surface), with the message shape
  `packages/fabrika-cli/src/report/file-verb.ts` already ships. It is **not** an error for
  `status open`, which renders those fields `unknown`, nor for `menu`, which never reads the repo,
  nor for `config`, whose label probes render `unknown` — a probe that could not be *performed*,
  which is not the same as a subject that is not probeable at all.
- **Every list read paginates and reports its scanned count** on stderr. An unpaginated read returns
  a plausible first page instead of an error, so a count taken from one is wrong with nothing marking
  it wrong.
- **A non-zero exit is UNKNOWN.** `packages/fabrika-cli/src/verb.ts`'s `refuse()` hardcodes
  `stdout: ""` and `answer()` hardcodes `code: 0`, so a non-zero exit carrying a machine payload is
  **unbuildable** in this package. Every informative outcome below is an exit-`0` token and every
  non-zero is a bare refusal with its reason on stderr.

<a id="three-state-law"></a>
### The three-state law — the invariant this whole group exists to hold

**Every field, row and bucket resolves to exactly one of three CLASSES, and the third is never
rendered as the second:** a live value; a **proven negative** (the source was read and holds
nothing); or **`unknown`** with its reason (the source could not be read). The middle class has
several spellings because several things can be proven empty — `empty` for a roster, `absent` for an
artifact, `missing` for a surface, `unprobeable` for a subject no probe can settle, `malformed` for
bytes that are present and non-conforming. **Only `unknown` is ever the third class**, in every
vocabulary in this group. Four consequences bind every verb below:

1. **A proven-empty answer is a positive token at exit `0`**, never empty stdout and never `0` where
   a count is unknown. An unmeasured count renders `unknown` with a parenthesised reason, following
   the shipped precedent that an unmeasured run reads `n/a (reason)` rather than `0`
   (measured, #4106).
2. **A state word names the reading it is not.** The `<detail>` beside `absent` carries "proven
   absent, not unread"; beside `unknown` it carries the raw failed read, reproduced verbatim before
   clamping, so the failure stays attributable — the shape
   `packages/pipeline-cli/src/tools/run-evidence/run-evidence.ts` prints, and the shape v1's
   `doctor.sh` prints when it tells the reader what not to conclude.
3. **Per-field state cannot be an exit code.** A composite readout has five independent outcomes and
   one exit status; because a non-zero exit cannot carry a payload, the exit status answers only
   *"did I produce a readout at all"* and each field carries its own state inside it.
4. <a id="open-is-total"></a>**`status open` therefore has no zero-scope and no failed-read seat at
   all.** It is the command the skill injects before the session reads a token; a refusal writes zero
   bytes, so a front door that refused would be silent on exactly the cold start it exists for. Every
   source it cannot read becomes a field state. Its only refusals are a bad `--field` and the
   universals.

### Freshness is carried per field, never assumed

<a id="as-of-is-mandatory"></a>Every rendered field, row, surface and bucket carries an `<as-of>`
token whose grammar is `<YYYY-MM-DDTHH:MM:SSZ|unknown>`. Two sources, two meanings, printed rather
than implied:

- **`read-now`** — a filesystem or REST read performed during this invocation; the token is that
  read's UTC instant.
- **`artifact`** — a durable artifact's own last-write timestamp, taken from the comment's
  `updated_at`, **not** the moment it was fetched. Printing the fetch time for an artifact written
  three weeks ago claims a freshness nobody has: the staleness class of #3148, #3330 and #4338.

A read that produced no timestamp prints `unknown` in the token **and** makes that field's state
`unknown` — the two always move together. In `--json` an unknown timestamp is `"asOf": null,
"asOfKind": null`; otherwise `asOfKind` is `"read-now"` or `"artifact"`.

<a id="roster-location"></a>
### Where the roster lives — the install case is the normal case

**The skill roster is the plugin's, not the target repo's.** fabrika installs into repos that are not
phoenix (#4776), so in the general case `claude-plugins/fabrika/skills/` does not exist in the
working repo and the roster ships inside the installed plugin. Defaulting to a repo-relative path
would make `menu` and `config` empty on precisely the fresh repo this skill onboards.

So `menu` and `config` — and `status open`, through the cores it imports — **resolve the roster
themselves**, in this order, and print which tier served it on the scope line. (`bootstrap` is not on
this list: it builds from a fixed [registry](#buildable-surfaces) and reads no roster at all.)

1. `--skills-dir <path>`, when given explicitly.
2. The installed plugin's own skills directory, discovered from the running module's location the
   way `packages/fabrika-cli/src/delegate/entry.ts` discovers the repo root — by resolution, never by
   an environment variable, because interface rule 5 forbids a variable-rooted invocation and a verb
   never requires an env var to locate itself.
3. `claude-plugins/fabrika/skills/` beneath the repo root, which is the in-repo development case.
4. That same `claude-plugins/fabrika/skills/` beneath the checkout the CLI itself runs from, found by
   walking up from the running module — the rung that answers when fabrika runs out of a phoenix
   checkout against a target repo carrying no roster of its own, where tier 2 cannot fire (the CLI at
   `packages/fabrika-cli/` has no plugin manifest above it) and tier 3 is rooted at that target repo
   (#5775). Resolution again, never an environment variable.

The tier word printed on the scope line is `explicit` · `plugin` · `repo` · `checkout`, one per rung
in that order.

**A roster that resolves and holds zero skills is `empty` at exit `0`, a fact, not a refusal.** These
are supplying verbs, and interface convention §4 requires a supplying verb to decide once, in its
header, whether an empty result is a fact or a failed read: **an empty roster is a fact** (a fresh or
partial install), an unreadable one is `11`. Exit `7` is reserved for an **explicitly passed**
`--skills-dir` that is proven absent — a caller error, not a state of the world — and it is seated on
`menu` and `config` only. **`status open` is exempt though it takes the same flag**: it is the
injected command and [cannot refuse](#open-is-total), so a bad path it was handed renders as a field
state like any other unreadable source. `bootstrap` does not take the flag at all.

<a id="core-to-field"></a>
### How each core outcome becomes a field state in `status open`

`status open` imports the same pure cores its siblings use and maps their outcomes to field states.
The mapping is stated here because leaving it to the implementer would leave the group's whole
purpose — keeping proven-empty apart from unread — to chance.

| Field | Core outcome | Field state | `<detail>` |
|---|---|---|---|
| `menu` | roster resolved, ≥1 skill | `ready` | `<n> skills` |
| `menu` | roster resolved, 0 skills | `empty` | `no skills in <tier> roster` |
| `menu` | roster unreadable | `unknown` | the raw read failure |
| `config` | every declared surface `present`, no `undeclared`, no `unprobeable` | `satisfied` | the counts |
| `config` | ≥1 `missing`, `undeclared` or `unprobeable` | `gaps` | the counts |
| `config` | roster resolved, 0 skills | `gaps` | `empty roster — nothing declared, nothing proven`. **Not `satisfied`**: "every declared surface is present" is vacuously true over zero surfaces, and rendering the fresh install this skill onboards as fine is the exact fail-open of #4060 |
| `config` | roster unreadable | `unknown` | the raw read failure |
| `board` | every bucket counted | `counted` | the two headline counts |
| `board` | ≥1 bucket `unknown`, or the repo unresolvable/unreadable | `unknown` | the raw failure, or the absent labels |
| `readout` | digest block found | `found` | `<n> rows` |
| `readout` | artifact read, no digest block | `absent` | `no digest block in <ref>` |
| `readout` | artifact read, block present, a row non-conforming | `malformed` | which row failed |
| `readout` | repo resolved, no artifact found | `absent` | `no readout artifact` |
| `readout` | repo unresolvable | `unknown` | `cannot resolve a repo — a failed read, not an absent digest`. **Never `absent`**: a repo that was never resolved proves nothing about whether an artifact exists in it |
| `readout` | artifact unfetchable, or the format unregistered | `unknown` | the raw failure |
| `readout` | artifact fetched, its `updated_at` unreadable | `unknown` | `freshness unreadable` — a digest whose age cannot be established is not a digest you may present as current |
| `menu` / `config` | roster readable, one `SKILL.md` inside it unreadable | `unknown` | which file failed — a partial roster is not a roster |
| `lanes` | sweep answered, ≥1 lane verdicted `stale` | `stale` | `<n> stale: <key> (<age>m), …` — each silent lane named with its age |
| `lanes` | sweep answered, zero `stale`, zero `unreadable` | `empty` | `no lanes on disk`, or `<n> lane(s), none silent past <threshold>m` — the threshold echoed from the verb's answer, never a second constant. **Zero lanes on disk is this row, not a fault**: a fresh checkout has none |
| `lanes` | sweep answered, zero `stale`, ≥1 lane record `unreadable` | `unknown` | which lane failed and why — a lane whose silence cannot be judged is never flattened to clean |
| `lanes` | the sweep refused — a lane root is there and cannot be listed | `unknown` | the refusal's reason — the lane set is UNKNOWN, never empty |

**A proven-absent artifact is `absent` inside the composite, never `unknown`** — the two rows above
that both yield `absent` are both facts about the repository, and only a failed *read* is `unknown`.

### The shared exit taxonomy

All six verbs allocate from one internal table (`packages/fabrika-cli/src/status/codes.ts`), so a
code means one thing across *this group*. Every shared seat is **imported**, never restated as a
numeral — a restated numeral is a second source that can drift silently, and an import cannot. The
group registers as an aligned group claiming `SHARED_SEATS`:

| Seat | Import from | Shipped constant |
|---|---|---|
| `3` `5` `6` `7` `8` `9` `10` `11` | `packages/fabrika-cli/src/report/codes.ts` | `EMPTY_STDIN`, `LEAKED_PATH`, `BARE_AT_PATH`, `NO_TARGET` (re-exported here as `ZERO_SCOPE`, the same rename `build`, `review`, `ship`, `triage`, `ui` and `review-ui` use), `WRITE_UNKNOWN`, `READBACK_MISMATCH`, `CLASSIFIED` (re-exported as `OFF_VOCABULARY`), `PRECONDITION_UNKNOWN` |
| `4` | declared locally as `DELIBERATE_GAP = 4` | the same shape `review`, `ship` and `triage` ship, so the gap is registered rather than silently absent — no verb here composes body sections |
| `12` | this group's own | `NOT_BUILDABLE` — see below |

**Three registration edits, not two.** `packages/fabrika-cli/src/exit-code-alignment.ts` gains a
`status` row in `ALIGNED_GROUPS`; `packages/fabrika-cli/src/exit-code-alignment.unit.test.ts` gains
both an `import * as status from "./status/codes.ts"` **and** a `TABLES` row. The assertion that reds
when only `ALIGNED_GROUPS` is updated is the `TABLES`-keys-equal-on-disk one, not the registered-set
one, which the first edit already satisfies.

| Code | Meaning | open | config | menu | readout | board | bootstrap |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo where the answer requires one, a failed stdin read, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | — | ✓ |
| `4` | *(deliberate gap — `report file`'s body-section seat; no verb here composes body sections)* | — | — | — | — | — | — |
| `5` | the **authored** content carries a machine-local path | — | — | — | — | — | ✓ |
| `6` | the **authored** content is a bare `@` path reference — not redactable | — | — | — | — | — | ✓ |
| `7` | zero scope: an **explicitly passed** `--skills-dir` is proven absent (ADR 0092) | — | ✓ | ✓ | — | — | — |
| `8` | the write itself failed — the outcome is **UNKNOWN** | — | — | — | — | — | ✓ |
| `9` | the write landed but the read-back does not match | — | — | — | — | — | ✓ |
| `10` | a supplied value is off the closed vocabulary — an unknown `--field`, a non-integer issue, a `--path` outside the repository root | ✓ | — | — | ✓ | — | ✓ |
| `11` | a **precondition read failed** — nothing was written and the outcome is UNKNOWN | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `12` | refused: the surface named is not in this group's [buildable-surface registry](#buildable-surfaces) | — | — | — | — | — | ✓ |
| `127` | the verb never ran (unresolved binary) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**The export names `status/codes.ts` must ship**, because `checkAlignment`
(`packages/fabrika-cli/src/exit-code-alignment.ts`) keys on export *names* and not on numerals — a
different spelling reds the alignment test with nothing in the failure naming why: `EMPTY_STDIN`,
`DELIBERATE_GAP`, `LEAKED_PATH`, `BARE_AT_PATH`, `ZERO_SCOPE`, `WRITE_UNKNOWN`, `READBACK_MISMATCH`,
`OFF_VOCABULARY`, `PRECONDITION_UNKNOWN`, plus this group's own `NOT_BUILDABLE`.

**This matrix owns what a code *means*; the per-verb tables own what *triggers* it.** Every verb can
also return `0`, `1`, `126` and `127` with the meanings above, stated here and nowhere else; the
per-verb "Exit status" tables enumerate only that verb's own proven outcomes, `3` and up.

**`7` and `11` are the group's load-bearing pair.** `7` is a *fact about a caller-supplied path* —
it was named explicitly and is not there. `11` is a *failed read*. Folding them is the defect this
group exists to prevent. **A surface that exists and could not be read is `11`, never `7`**, and an
*implicitly* resolved roster that holds nothing is neither: it is `empty` at exit `0`.

**Two proven facts that used to be refusals are exit-`0` state words**, because a non-zero cannot
carry the fact the caller acts on: a bootstrap target that already exists prints `exists`, and a
readout with no artifact prints `absent`. Seating either on a refusal would put a fact on a channel
that is defined to be empty.

### What this group imports rather than restates

| Need | Import |
|---|---|
| repo resolution | `resolveRepo` — `packages/fabrika-cli/src/io/issues.ts` |
| file presence (an unperformable probe **fails**, never returns `false`) | `exists` — `packages/fabrika-cli/src/io/fs.ts` |
| directory and file reads that fail typed rather than returning `[]` / `""` | `readDir`, `readFile` — `packages/fabrika-cli/src/io/fs.ts` |
| stdin — **three** variants, `Text` / `NoStdin` / `Failed`, which never collapse | `readStdin` — `packages/fabrika-cli/src/io/stdin.ts` |
| the leak predicate for anything written to a repo file or a public surface | `scanBody`, `isBareAtReference`, `renderLeaks` — `packages/fabrika-cli/src/report/leaks.ts` |
| read-back comparison (its third step, stripping trailing newlines, is the one a re-derivation drops, and dropping it fires `9` on clean runs) | `normalizeForReadback` — `packages/fabrika-cli/src/report/compose.ts` |
| the closed priority vocabulary the board buckets on | `PRIORITIES` — `packages/fabrika-cli/src/triage/facets.ts` |
| the scanned-count stderr line (ADR 0092 auditability) | `scannedLine` — `packages/fabrika-cli/src/build/target.ts`. Four near-identical copies already exist (`build`, `ship`, `review`, `triage`); import one rather than shipping a fifth. |
| decoding the published digest block | the `governance-digest` registered format via `findFormat` — `packages/fabrika-cli/src/wire/registry.ts`. **Not registered yet**; see [sequencing](#sequencing). |
| the verb outcome shape and the mandatory leaf constructor | `answer`, `refuse` — `packages/fabrika-cli/src/verb.ts`; `leafCommand` — `packages/fabrika-cli/src/excess-operand.ts` |

**Genuinely greenfield, and therefore this group's own modules:** the roster resolver and enumerator
(nothing in the package walks a skills tree), the `## Required repo files` table parser, the surface
probe, and the composite renderer.

<a id="sequencing"></a>
### Sequencing — one hard dependency, stated rather than assumed

`status readout` decodes the `governance-digest` wire format, which is **specified but not built**:
one of three shipped-surface changes the `governance` contract requires, tracked at
[#5199](https://github.com/kamp-us/phoenix/issues/5199), whose authoring pull request
([#5200](https://github.com/kamp-us/phoenix/pull/5200)) is open and unmerged. This spec **does not
cross-reference that unmerged contract** — an unlanded sibling is a race — and depends only on the
format's registry name plus the artifact bytes reproduced here, both of which the producer fixes.
Every id, title and byte `status bootstrap` needs is declared in
[the buildable-surface registry](#buildable-surfaces) below, so nothing here defers to another
skill's prose.

Until the format is registered, `status readout` exits `11` with the reason
`the governance-digest format is not registered`, and `status open` renders that field `unknown`.
**Never `absent`** — an unbuilt decoder is a failed read, not a proven-empty artifact.

**The artifact's bytes**, so this verb's read path is implementable without the producer contract in
hand: a fenced block under a `## Governance readout` heading in a comment on the artifact issue,
rows `row<TAB><NNNN><TAB><tension|blast|routine><TAB><one-line note>`.

````markdown
## Governance readout

```governance-digest
row	0398	tension	sits against ADR 0173 on whether a pending required check blocks admission
row	0401	blast	every cache key in the system gains a tenant component
row	0396	routine	no tension found
```
````

---

## `status open`

**Invocation**

```
fabrika status open [--field <name>] [--repo <owner/name>] [--skills-dir <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--field` | string | no | all five | render one field only — `menu`, `config`, `board`, `readout` or `lanes`; any other value is off-vocabulary |
| `--repo` | string | no | resolved | the repository the board and digest fields read |
| `--skills-dir` | string | no | [resolved](#roster-location) | the roster root the menu and config fields read |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header line, then one line per field:

```
open	<field-count>
field	<name>	<state>	<detail>	<source>	<as-of>
```

`<name>` ∈ `menu` · `config` · `board` · `readout`. `<state>` is drawn from that field's closed set,
**every one of which includes `unknown`**, and is produced by [the mapping](#core-to-field):

| Field | Closed state set |
|---|---|
| `menu` | `ready` · `empty` · `unknown` |
| `config` | `satisfied` · `gaps` · `unknown` |
| `board` | `counted` · `unknown` |
| `readout` | `found` · `absent` · `malformed` · `unknown` |

`<source>` names where the answer came from so the session can re-run one read instead of adopting
the render: the resolved roster path for `menu`/`config`, `<owner>/<name>` for `board`, and
`<owner>/<name>#<issue>` for `readout` when an artifact resolved — otherwise `<owner>/<name>`.

**No aggregate state, deliberately.** A roll-up over five independently-sourced fields would need a
rule for "three fine, one unknown", and every such rule either hides the unknown or drowns the three.

**Exit status**

| Code | Trigger |
|---|---|
| `10` | `--field` is not one of `menu`, `config`, `board`, `readout` |

**That is the whole table, and it is the point** ([why](#open-is-total)). An unresolvable repo, an
unreachable GitHub, an unreadable roster, an absent roster and an unregistered digest format each
render their field `unknown` or `empty` at exit `0`. This verb is injected before the session reads a
token; a refusal would write zero bytes on the cold start it exists for.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status open: --field "<v>" is not one of menu, config, board, readout, lanes.` | 10 | usage error |
| `status open: roster <path> (<tier>), <n> skills; repo <owner/name>; <k> field(s) rendered, <u> unknown.` | 0 | notice |

**Scope** — the fields requested, each named on the scope line with the source it resolved and the
roster tier that served it.

**Examples**

```
$ fabrika status open
open	4
field	menu	ready	12 skills	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	config	gaps	9 declared, 3 missing, 3 undeclared	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	board	counted	7 needs-triage, 23 triaged	kamp-us/phoenix	2026-08-09T14:22:05Z
field	readout	found	6 rows	kamp-us/phoenix#9412	2026-08-08T09:00:00Z
```

```
$ fabrika status open
open	4
field	menu	ready	12 skills	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	config	gaps	9 declared, 3 missing, 3 undeclared	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	board	unknown	cannot reach api.github.com: EAI_AGAIN — a failed read, not zero issues	kamp-us/phoenix	unknown
field	readout	unknown	the governance-digest format is not registered — a failed read, not an absent digest	kamp-us/phoenix	unknown
$ echo $?
0
```

```
$ fabrika status open --field readout --json
{"outcome":"open","fields":[{"name":"readout","state":"absent","detail":"no readout artifact","source":"acme/storefront","asOf":null,"asOfKind":null}]}
```

**Grounding**

- the silent-green measurement (#4106) — the silent-green finding: an unresolvable skill exits
  `0` with `num_turns: 0` and reconstructs to well-formed zeros, so `classifyRun` must synthesize the
  missing signal. A front door is where a wrong-but-plausible value does the most damage, because
  every later decision in the session rests on it.
- #3925 / #4105 / #4060 / #4103 — a healthy verdict over a dead source; "none" read while rows sat
  unread; zero scope rendered as an answer; two states rendering identically. The per-field
  three-state token answers all four.
- #4557 — a *healthy* path that exits `1`, misread by a caller reading only the status. Here the exit
  status answers one narrow question and every field's state lives in the payload.
- `packages/fabrika-cli/src/verb.ts` — `refuse()` hardcodes empty stdout, which is why this verb has
  no refusal seat beyond a usage error.
- #4133 / #4227 — orientation errors propagate, so every field names its source.

---

## `status config`

**Invocation**

```
fabrika status config [--skill <name>] [--skills-dir <path>] [--repo <owner/name>] [--json]
```

The **detection verb** the founder ruled into existence in place of v1's `/doctor` skill (#4952, and
the kill ruling #4722 that stands): machine-answerable, exit-coded, zero judgement.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--skill` | string | no | every skill in the roster | probe only the surfaces this one skill declares; a name not in the roster is reported, not refused — see below |
| `--skills-dir` | string | no | [resolved](#roster-location) | the roster whose declarations are parsed |
| `--repo` | string | no | resolved | the repository whose labels are probed |
| `--json` | boolean | no | `false` | emit the result object |

**What it parses.** Each `SKILL.md`'s `## Required repo files` section: a three-column markdown table
whose third cell opens with a bolded disposition word. That shape shipped with #5049, and each
skill's own text states *"it is the same table in every fabrika skill, so one reader parses all of
them."* This verb is that reader.

<a id="surface-ids"></a>**Surface ids are declared, never inferred.** A row's id is the
`` `id:<slug>` `` token in its first cell; `<slug>` is `[a-z0-9-]+`. A row with no id token reports
id `-`, and that is the whole of what an absent id decides: **the id column and `<presence>` are
independent**. The probe still runs, so an id-less row's `<presence>` and `<detail>` carry what the
probe proved, exactly as on a row that has an id. Coupling the two would report nearly every row on
the current tree `unknown` — 8 of the roster's 102 rows carry an id token, and they sit in three
skills (`write-pattern`, `operate`, `front-door`) — leaving a detection verb that names almost no
gap it can act on, and making the example below unproducible (#5298). **No slug is derived from
prose** — a rule that kebab-cased a cell would turn "The board label taxonomy — `status:triaged`,
…" into `the-board-label-taxonomy`, two implementers would ship two id sets, and a reworded cell
would silently break every documented invocation. The ids this group itself needs are fixed in
[the buildable-surface registry](#buildable-surfaces). **A roster id is not a registry id**, which
is why the registry below, and never the roster, is the authority for what `bootstrap` accepts:
`write-pattern`'s six ids (`patterns-dir`, `patterns-index`, `admission-bar`, `git-history`,
`doc-gates`, `dep-manifest`) name no buildable surface at all, so a `bootstrap` that read the
roster would accept six ids it cannot build.

<a id="disposition-is-reported-never-interpreted"></a>**The disposition is printed verbatim, and an
unrecognized word is reported rather than refused.** Every landed skill uses exactly the three
canonical words today — `fail-loud` · `degrade` · `bootstrap` — verified cell by cell across the
roster, so this rule buys nothing on the current tree and is here for the two cases that are
certain to arrive.

The first is that **a `SKILL.md` is externally-authorable text.** fabrika installs into repos that
are not phoenix (#4776), and this verb parses whatever tables it finds there. A parser that refused
on an unknown fourth word would fail on a typo, on a skill authored against a newer convention, and
on any repo that extends the set — and it would fail *closed on the detection verb*, which is the one
surface a fresh repo has nothing else to fall back on.

The second is that the word is easy to misread. It sits in the third cell; the *second* cell is prose
that may itself contain bolded words — `plan-epic` and `check-epic-plan` both write
`` `POST .../labels` **creates** an unknown label `` there, beside a third cell reading
`**fail-loud**`. **Parse by cell position, never by scanning the row for a bolded token**; a
section-wide scan reports a disposition that is not one, and did during this contract's own authoring.

So: the word is printed as written, one outside the three canonical is counted under
`<off-vocabulary>` in the header, and it is never normalized, guessed at, or made a refusal.

<a id="disposition-does-not-gate-bootstrap"></a>**A disposition is not a statement about who can
build the surface.** It says what *the declaring skill* does when the surface is missing.
`build-ui/SKILL.md` declares `design-system-manifest.md` **fail-loud** — that skill stops — and the
same row *"points at front-door's bootstrap"*. Reading `fail-loud` as "unbuildable" would make the
most important onboarding surface unreachable.

**Output** — machine channel, [tab-separated](#separator). A header, then one line per declared
surface, ordered by `<skill>` then `<surface-id>` then the row's order in its table:

```
config	<satisfied|gaps|unknown>	<declared-skills>	<missing>	<undeclared-skills>	<off-vocabulary>
surface	<skill>	<surface-id>	<disposition>	<presence>	<consequence>	<detail>	<as-of>
```

`<presence>` is a **four**-state closed set:

| Presence | Meaning |
|---|---|
| `present` | a path exists, or a label exists — the only two things this verb can *prove* |
| `missing` | the probe ran and the path or label is not there |
| `unprobeable` | the declared subject is not a path or a label, so no probe exists — e.g. *"the `package.json` scripts `typecheck` and `lint:worktree`"*, *"a merge queue enabled on the base branch"*, *"a dev server that actually comes ready"*, *"the linked issue's `### Acceptance criteria` block"*. Rendering these `present` off a file's existence is a **false positive**, which is why the state exists. |
| `unknown` | the probe could not be performed — an unresolvable repo for a label probe, an unperformable filesystem probe |

`<consequence>` is the declaring row's third cell **after** the bolded disposition word, tab- and
newline-stripped and clamped — the sentence the declaring skill wrote about what happens when the
surface is missing. It is carried so a caller can relay it without opening the file behind this
verb's back.

<a id="undeclared-is-not-satisfied"></a>**A skill with no `## Required repo files` section emits
exactly one row** with disposition `undeclared`, presence `unknown` and id `-` — never zero rows, and
never counted as satisfied. An absent declaration means nobody checked, which is #5049's own stated
reason for requiring the section; scoring it clean is the fail-open of #4060. Three landed skills are
in this state today (`adr`, `report`, `triage`), so it is the common path, not an edge case. A
`--skill` naming something not in the roster emits the same shape with detail `not in the roster`.

The header is `satisfied` only when every declared surface is `present` **and** no skill is
`undeclared` **and** nothing is `unprobeable` **and** nothing is `unknown`; `gaps` when anything is
`missing`, `undeclared`, `unprobeable` or `unknown`; `unknown` when the roster itself could not be
read. A row set that is entirely `unknown` is `gaps` by that rule: an unperformed probe is not a
present surface, and scoring it clean is the fail-open this verb exists to remove. **`gaps` and
`unknown` are different answers** — the first is proven.

<a id="multiply-declared"></a>**One surface declared by several skills** — the label taxonomy is
declared by `build` and this skill — emits **one row per declaring skill**, so no
declaration is hidden, and counts **deduplicate by id**, so a twice-declared missing surface counts
once in `<missing>`. Where two skills give one id different dispositions, both rows print their own
word and nothing is folded; this verb reports declarations and reconciles nothing.

With `--json`, `"surfaces"` carries the same fields plus `asOf`/`asOfKind` per row.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | an **explicitly passed** `--skills-dir` is proven absent (ADR 0092) |
| `11` | the resolved roster, or a `SKILL.md` inside it, could not be read — the declaration set is UNKNOWN |

An implicitly-resolved roster holding zero skills is header state `gaps` with zero rows at exit `0`,
per [the roster rule](#roster-location). A failed probe of an individual surface is that row's
`unknown` at exit `0`, not a refusal.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status config: --skills-dir <path> is proven absent — refusing to answer (ADR 0092).` | 7 | refusal |
| `status config: cannot read <path>: <reason> — the declared surface set is UNKNOWN, never empty.` | 11 | refusal |
| `status config: roster <path> (<tier>), <n> skills, <d> declaring, <u> undeclared; probed <s> surfaces, <k> unprobeable.` | 0 | notice |

**Scope** — every directory in the resolved roster holding a `SKILL.md`, and every row of each one's
`## Required repo files` table. An explicitly passed absent path reds (ADR 0092): a detection verb
that scanned nothing and reported no gaps is the pass a guard must never emit.

**Examples**

```
$ fabrika status config
config	gaps	9	3	3	0
surface	build	-	bootstrap	missing	build pick prints an empty pool and the run ends BACKED-OFF	no label status:triaged in kamp-us/phoenix	2026-08-09T14:22:05Z
surface	build	-	degrade	present	an absent file and an empty section are the same well-formed default	ROADMAP.md	2026-08-09T14:22:03Z
surface	build	-	fail-loud	unprobeable	a validator that cannot be executed is exit 11, UNKNOWN, never green	declared subject is a package.json script pair, not a path or a label	2026-08-09T14:22:03Z
surface	build-ui	-	fail-loud	missing	exit 12 ends the session at BLOCKED-NO-MANIFEST with no branch cut	no design-system-manifest.md at repo root	2026-08-09T14:22:03Z
surface	plan-epic	-	fail-loud	missing	ledger child exits 10 naming the absent label rather than minting it	no label status:planned in kamp-us/phoenix	2026-08-09T14:22:05Z
surface	adr	-	undeclared	unknown	-	no `## Required repo files` section	2026-08-09T14:22:03Z
```

```
$ fabrika status config --json
{"outcome":"gaps","declaredSkills":9,"missing":2,"undeclaredSkills":3,"offVocabulary":1,"surfaces":[{"skill":"adr","surfaceId":"-","disposition":"undeclared","presence":"unknown","consequence":"-","detail":"no `## Required repo files` section","asOf":"2026-08-09T14:22:03Z","asOfKind":"read-now"}]}
```

**Grounding**

- #4952 (founder, 2026-08-09) — *"a detection VERB reports which config surfaces exist/are missing …
  machine-answerable, exit codes, zero judgement. This is where dead /doctor's useful half lives; it
  is a verb, never a skill."* #4722 killed the skill; this is the surviving half.
- #5049 — the `## Required repo files` table shipped with it. This verb consumes that table rather
  than defining a second manifest format, so a skill declaring its needs and a reader probing them
  cannot drift.
- v1's `doctor.sh`, designed out twice: its required-label set was a **hand-maintained heredoc
  mirroring a TS constant**, which drifted (#4300) and then needed a second guard — and that guard
  *downgrades to WARN* without incrementing failures, so the anti-drift check is itself fail-open.
  Here the declaration lives in the skill that needs it and is parsed, never copied. And on a repo
  the token lacks admin on, GitHub omits a key entirely and `gh api --jq` exits `0` printing nothing,
  making absent indistinguishable from false; every probe here asserts the positive shape required.
- ADR 0092 — zero scope reds; an unread field is UNKNOWN, never a negative answer.

---

## `status settings`

**Invocation**

```
fabrika status settings [--root <dir>] [--json]
```

The resolved config surface: every key `.fabrika.jsonc` may carry, what it resolves to here, and
where that value came from. It is the one place a skill asks what a key resolves to, so no skill
document has to restate a value (R9.1, #6293). It reads; it writes nothing.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--root` | string | no | the repository root, else the cwd | the directory holding `.fabrika.jsonc` |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header, then one line per registered
key in registry order:

```
settings	<resolved|unknown>	<keys>	<declared>	<unknown>	<as-of>
setting	<key>	<declared|default|unknown>	<value-as-json>	<detail>	<as-of>
```

`<value-as-json>` is the value as JSON, which is what keeps the cell tab-free — a declared string
holding a tab escapes rather than splitting the row. It is printed **in the spelling the file
carries**, not in the shape the package decodes to: `capClearAuthors` prints `["@usirin"]`, never
`[{"_tag":"User","login":"usirin"}]`. `<as-of>` is this invocation's own read of the file,
`asOfKind: "read-now"`, the same instant on every row because every row comes off it.

<a id="provenance-is-the-column"></a>**Provenance is the load-bearing column.** "the governance
roots are the four shipped defaults" and "the governance roots are four values this repo declared"
are different facts, and an agent reading a bare value cannot tell whether the repo made a choice.

| Provenance | Meaning |
|---|---|
| `declared` | the file carries this key and its value decoded |
| `default` | no file, or no such key — the shipped default, with which of the two in `<detail>` |
| `unknown` | the value could not be established, with the reason in `<detail>` and no value printed |

**Three, not the loader's four.** `packages/fabrika-cli/src/config/key-group.ts` distinguishes a
*malformed* declared value from an *unreadable* file; both land here as `unknown`, because the value
this repo runs on is equally unestablished either way and neither may ever render as the default it
did not resolve to. The two reasons stay distinguishable in `<detail>`, which carries the loader's
own words.

**A key that resolves `unknown` makes the whole readout a refusal at `11`.** A non-zero exit
[carries no payload](#separator), so stdout is empty and stderr carries the scope line, the reason,
and one `setting` line per UNKNOWN key — the resolved rows are not printed beside a refusal, since
that invites a caller to read the bytes without reading the status. This is the same rule
`build check` and `build clearances` already hold on this file: an unreadable config is UNKNOWN,
never the shipped default (`packages/fabrika-cli/src/config/document.ts`).

**A repo with no `.fabrika.jsonc` is `resolved` at exit `0`**, every row `default`. That is the
whole point of a shipped default, and it is the three-state law's proven-empty class, not its third.

With `--json`, stdout is one object carrying `outcome` (the header's state), `path`, `keys`,
`declared`, `unknown`, and `settings` — one entry per row with `key`, `provenance`, `value` and
`detail`, plus `asOf`/`asOfKind`. Two fields differ from the tab form: `path` has no cell there, and
`detail` carries the same literal `-` an empty cell prints rather than being omitted. A refusal at
`7` or `11` emits no object, since a non-zero exit [carries no payload](#separator).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the config surface registers zero keys — nothing to resolve, and a readout over an empty surface is not an answer (ADR 0092) |
| `11` | `.fabrika.jsonc` exists and could not be read, is not a JSON object, holds a value the surface refuses, or refused the whole load — UNKNOWN, never green |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status settings: the config surface registers zero keys — there is nothing to resolve, and a readout over an empty surface is not an answer (ADR 0092).` | 7 | refusal |
| `status settings: <n> key(s) resolve UNKNOWN (<keys>) — what this repo runs on is unread, never the shipped default.` | 11 | refusal |
| `status settings: no .fabrika.jsonc — every key falls to its shipped default; <n> key(s), <d> declared, <u> unknown.` | 0 | notice |
| `status settings: read .fabrika.jsonc; <n> key(s), <d> declared, <u> unknown.` | 0 | notice |
| `status settings: could not read .fabrika.jsonc: <reason>; <n> key(s), <d> declared, <u> unknown.` | 11 | notice |

**Scope** — every key in `packages/fabrika-cli/src/config/registry.ts`, resolved against one open and
one parse of the file. No pagination: the scope is a registry, not a list read.

**Examples**

```
$ fabrika status settings
settings	resolved	4	3	0	2026-08-18T22:50:20Z
setting	capClearAuthors	declared	["@usirin","@notusirin"]	-	2026-08-18T22:50:20Z
setting	docLeakExempt	declared	["/CLAUDE.md"]	-	2026-08-18T22:50:20Z
setting	governedRoots	default	[".decisions/",".claude/",".github/","claude-plugins/",".fabrika.jsonc"]	.fabrika.jsonc declares no `governedRoots`	2026-08-18T22:50:20Z
setting	workflowValidators	declared	[]	-	2026-08-18T22:50:20Z
```

The same run under `--json` — the notice line stays on stderr, so stdout is the object alone:

```
$ fabrika status settings --json
{"outcome":"resolved","path":".fabrika.jsonc","keys":4,"declared":3,"unknown":0,"settings":[{"key":"capClearAuthors","provenance":"declared","value":["@usirin","@notusirin"],"detail":"-","asOf":"2026-08-18T22:50:20Z","asOfKind":"read-now"},{"key":"docLeakExempt","provenance":"declared","value":["/CLAUDE.md"],"detail":"-","asOf":"2026-08-18T22:50:20Z","asOfKind":"read-now"},{"key":"governedRoots","provenance":"default","value":[".decisions/",".claude/",".github/","claude-plugins/",".fabrika.jsonc"],"detail":".fabrika.jsonc declares no `governedRoots`","asOf":"2026-08-18T22:50:20Z","asOfKind":"read-now"},{"key":"workflowValidators","provenance":"declared","value":[],"detail":"-","asOf":"2026-08-18T22:50:20Z","asOfKind":"read-now"}]}
```

```
$ fabrika status settings --root /srv/storefront
status settings: could not read .fabrika.jsonc: /srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory; 4 key(s), 0 declared, 4 unknown.
setting	capClearAuthors	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-18T22:51:02Z
setting	docLeakExempt	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-18T22:51:02Z
setting	governedRoots	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-18T22:51:02Z
setting	workflowValidators	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-18T22:51:02Z
status settings: 4 key(s) resolve UNKNOWN (capClearAuthors, docLeakExempt, governedRoots, workflowValidators) — what this repo runs on is unread, never the shipped default.
$ echo $?
11
```

**Grounding**

- R9.1 (#5603 comment 31, founder, verbatim) — *"this file will be used by cli only, the skills
  ideally should be just using the cli but whatever cli will do will depend on the config. this is a
  hard requirement."* One reader means skills must be able to *get an answer*; a rule with no verb
  behind it pushes the value back into prose.
- #6290 — the loader this verb reads through. The `Default` / `Unknown` split is that module's, and
  is why a readout can say which without re-deriving it.
- ADR 0092 — zero scope reds; an unread value is UNKNOWN, never a negative answer.

**Why not the `config` name.** `status config` answers a different question — which repo surfaces the
landed skills declare and whether each is present — and #6301 retires it along with the
`## Required repo files` tables it parses. Taking its name now would break `status open`'s `config`
field mid-epic; the two never overlap, and after #6301 there is one verb answering "what does this
repo have".

---

## `status menu`

**Invocation**

```
fabrika status menu [--skills-dir <path>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--skills-dir` | string | no | [resolved](#roster-location) | the roster root |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header, then one line per skill sorted
by `<name>`:

```
menu	<ready|empty>	<count>	<as-of>
skill	<name>	<invocation>	<model|user>	<one-line description>
```

`<invocation>` is `/fabrika:<name>`. `<model|user>` comes from the frontmatter —
`disable-model-invocation: true` yields `user`, its absence yields `model` — because *who can reach a
skill* is the one routing fact a reader cannot infer from a description.

**The header has two states, not three.** `unknown` is a *composite* rendering
([the mapping](#core-to-field)); this verb refuses rather than printing it, because a caller invoking
`menu` directly reads the exit status.

<a id="description-is-displayed-content"></a>**A description is displayed content, not an
instruction.** It is read from a `SKILL.md` frontmatter in whatever repo fabrika is installed into,
and its whole purpose is to help the model choose the next skill — so it is exactly the field an
attacker would target. Newlines and tabs are stripped and it is clamped to 200 characters. Nothing in
it grants authority, and a reader acts on the skill it names, never on the sentence.

A skill whose frontmatter cannot be parsed emits its row with the description
`unknown (frontmatter unreadable)` rather than being dropped. **A dropped row is a skill the reader
will never know exists** — the false absence of #4105 and #4163.

**The roster is derived, never stored.** No committed menu file, no generate step: the same on-demand
idiom the repo applies to its decision records, generated from source and never auto-injected
([ADR 0129](../../../../.decisions/0129-adr-discovery-is-the-claude-md-contract.md)), and the shape
`DEVELOPMENT.md` already instructs readers to use — *the directory is the list*. A committed roster
is a copy, and a copy rots.

**Exit status**

| Code | Trigger |
|---|---|
| `7` | an **explicitly passed** `--skills-dir` is proven absent (ADR 0092) |
| `11` | the resolved roster could not be read — the roster is UNKNOWN |

An implicitly-resolved roster holding zero skills is `menu<TAB>empty<TAB>0<TAB><as-of>` at exit `0`.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status menu: --skills-dir <path> is proven absent — refusing to answer (ADR 0092).` | 7 | refusal |
| `status menu: cannot read <path>: <reason> — the roster is UNKNOWN, never empty.` | 11 | refusal |
| `status menu: roster <path> (<tier>), <n> skills, <k> unreadable frontmatter.` | 0 | notice |

**Scope** — every directory in the resolved roster containing a `SKILL.md`.

**Examples**

```
$ fabrika status menu
menu	ready	3	2026-08-09T14:22:03Z
skill	build	/fabrika:build	model	Turn one triaged issue into a merged pull request.
skill	front-door	/fabrika:front-door	user	The operating front door — live state and the command menu.
skill	triage	/fabrika:triage	model	Classify, prioritise and route one raw issue off the queue.
```

```
$ fabrika status menu --json
{"outcome":"ready","count":1,"asOf":"2026-08-09T14:22:03Z","asOfKind":"read-now","skills":[{"name":"build","invocation":"/fabrika:build","invocationAxis":"model","description":"Turn one triaged issue into a merged pull request."}]}
```

**Grounding**

- ADR 0129 and `DEVELOPMENT.md` — the directory is the list. `pipeline-cli decisions-index compact`
  and `commands compact` are the repo's two existing generated-on-demand, never-auto-injected
  indexes; this is fabrika's own third instance, implemented in fabrika's package (ADR 0238).
- v1's `decisions-index`, designed out: its committed `index.md` was deleted because a stored index
  drifts, yet `checkIndex` and `generateIndex` still ship, still compare against the deleted file,
  and still print a fix command naming a package that no longer exists. A derived roster leaves no
  such surface behind.
- skill-conventions §3 — the router names the others and when to reach for each; the invocation axis
  is printed because it decides who can reach each one.
- #4105 / #4163 — false absence. Unparseable frontmatter yields a row saying so, never a missing row.

---

## `status readout`

**Invocation**

```
fabrika status readout [<issue>] [--repo <owner/name>] [--json]
```

The display half of the landed-decision digest. The producer is `governance` (#4949); this verb ranks
nothing and re-derives nothing.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | integer | no | resolved, see below | the artifact issue number. **Not a constant**: resolve it from `$FABRIKA_GOVERNANCE_READOUT_ISSUE`, else the single open issue in the target repo titled exactly `Governance readout`; a caller may always pass it explicitly. Unset and unresolvable prints `absent`, never a guessed number, which would display somebody else's issue as the digest |
| `--repo` | string | no | resolved | the repository holding the artifact |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header, then one line per digest row in
artifact order:

```
readout	<found|absent|malformed>	<row-count>	<source>	<as-of>
row	<NNNN>	<tension|blast|routine>	<one-line note>
```

`<source>` is `<owner>/<name>#<issue>` when an artifact resolved, `<owner>/<name>` when none did.
`absent` and `malformed` carry row count `0` and no `row` lines.

<a id="which-comment-is-the-digest"></a>**Which comment is the digest, stated so staleness cannot
hide.** The digest is the **most recently updated comment carrying a `## Governance readout`
heading** — and that comment's conformance alone decides `found` versus `malformed`. A rule that
skipped a newer non-conforming publication in favour of an older valid one would render a stale
digest as current, which is the failure the whole freshness section exists to prevent. Where **no**
comment carries the heading, the reading is `absent`.

**The four readings, and why `absent` is only one of them.** The registered format's `read` is total
and returns `Found` · `Absent` · `Malformed`; this verb adds the fourth by not answering.

| Reading | Meaning | Seat |
|---|---|---|
| `found` | the block is present and every row conforms | `0` |
| `absent` | no artifact resolved, or the artifact was read and carries no `## Governance readout` heading — **proven absent, not unread** | `0` |
| `malformed` | the heading is present and a line does not conform — the digest is unreadable, which is **not the same as no digest** | `0` |
| *(no answer)* | the artifact could not be fetched, or the format is not registered — **UNKNOWN, never absent** | `11` |

Collapsing `malformed` or the unfetchable case into `absent` reports a proven negative over evidence
never held — the hazard `packages/fabrika-cli/src/wire/codes.ts` names when it seats
`ARTIFACT_UNKNOWN` deliberately apart from `ABSENT`.

<a id="note-is-a-pointer"></a>**The note is a pointer, never an instruction.** It is the only
free-text field in the artifact, tab- and newline-stripped and clamped. A reader drills in by
re-fetching the decision record the row's id names — through `fabrika adr resolve <id>`, which is
that group's verb and not one this spec respecifies. Nothing in a note may steer the session.

**`<as-of>` is the artifact comment's own `updated_at`**, `asOfKind: "artifact"` — not the fetch
time. A comment with no readable `updated_at` makes the reading `unknown` at exit `11`, per
[the freshness rule](#as-of-is-mandatory). For `absent` with no artifact resolved there is nothing to
timestamp: `<as-of>` is `unknown` and `asOfKind` is `null`, and the state stays `absent` because the
absence itself is proven.

**Exit status**

| Code | Trigger |
|---|---|
| `10` | the positional argument is not a positive integer |
| `11` | the artifact could not be fetched (network, auth, 5xx), its `updated_at` was unreadable, or the `governance-digest` format is not registered — the digest is UNKNOWN, never `absent` |

**A closed or 404 artifact is `absent` at exit `0`, not a refusal** — it is a fact about the
repository and the caller acts on it by bootstrapping one.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status readout: "<v>" is not a positive issue number.` | 10 | usage error |
| `status readout: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, GITHUB_REPOSITORY, or pass --repo.` | 1 | refusal |
| `status readout: cannot fetch <repo>#<n>: <reason> — the digest is UNKNOWN, never absent.` | 11 | refusal |
| `status readout: <repo>#<n> carries no readable updated_at — the digest's freshness is UNKNOWN.` | 11 | refusal |
| `status readout: the governance-digest format is not registered — the digest is UNKNOWN, never absent (#5199).` | 11 | refusal |
| `status readout: no artifact — $FABRIKA_GOVERNANCE_READOUT_ISSUE unset and no open issue in <repo> titled exactly "Governance readout". Run: fabrika status bootstrap readout-artifact` | 0 | notice |
| `status readout: read <repo>#<n>, <k> comments scanned, digest <state>.` | 0 | notice |

**Scope** — the comments on the resolved artifact issue, paginated, with the scanned count on stderr.

**Examples**

```
$ fabrika status readout
readout	found	3	kamp-us/phoenix#9412	2026-08-08T09:00:00Z
row	0398	tension	sits against ADR 0173 on whether a pending required check blocks admission
row	0401	blast	every cache key in the system gains a tenant component
row	0396	routine	no tension found
```

```
$ fabrika status readout --repo acme/storefront
status readout: no artifact — $FABRIKA_GOVERNANCE_READOUT_ISSUE unset and no open issue in acme/storefront titled exactly "Governance readout". Run: fabrika status bootstrap readout-artifact
readout	absent	0	acme/storefront	unknown
$ echo $?
0
```

```
$ fabrika status readout 9412 --json
{"outcome":"malformed","rows":[],"issue":9412,"repo":"kamp-us/phoenix","asOf":"2026-08-09T07:30:00Z","asOfKind":"artifact","detail":"row 2 carries a fourth field"}
```

**Grounding**

- #4927 comment 5227714776, carried onto #4971 and this brief — the human gate on decision records
  was retired **on one condition**: a periodic, non-blocking digest *"surfaced through the front-door
  status. Without the readout, overrule-later is fiction — this half is not droppable."*
- #4949 — the ranking is `governance`'s, bounded to tension and blast radius. This verb orders
  nothing.
- `packages/fabrika-cli/src/wire/codes.ts` — `ARTIFACT_UNKNOWN` is deliberately not `ABSENT`, because
  *"I could not see it"* and *"it is not there"* are the two facts the wire group exists to keep
  apart, in the one place where the negative is the expected result and so the least likely to be
  questioned.
- #3925 — a PASS over a totally failed read, for months.
- #3148 / #3330 / #4338 — staleness. The most-recent-heading rule and the artifact `updated_at` are
  both here so a stale digest cannot render as current.

---

## `status board`

**Invocation**

```
fabrika status board [--repo <owner/name>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--repo` | string | no | resolved | the repository whose buckets are counted |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header, then one line per bucket in the
fixed order below:

```
board	<counted|unknown>	<bucket-count>
bucket	<name>	<count|unknown>	<selector>	<detail>	<as-of>
```

<a id="bucket-endpoints"></a>**Six buckets, each with the REST call that produces it.** §11 mandates
REST with pagination, so the selector printed is the call actually issued, never GitHub search
syntax — search caps at 1000 results and cannot back a count.

| Bucket | REST call | Note |
|---|---|---|
| `needs-triage` | `GET /repos/{o}/{r}/issues?state=open&labels=status:needs-triage` | **PRs excluded** — see below |
| `triaged` | `GET /repos/{o}/{r}/issues?state=open&labels=status:triaged` | PRs excluded |
| `in-flight` | `GET /repos/{o}/{r}/pulls?state=open` | pull requests only |
| `p0` `p1` `p2` | `GET /repos/{o}/{r}/issues?state=open&labels=<p>` | one per member of the imported `PRIORITIES`; PRs excluded |

**`/issues` returns pull requests among issues** — every issue bucket therefore drops any item
carrying a `pull_request` key before counting. Omitting that filter silently inflates every issue
count by the open-PR count, which is a wrong number with nothing marking it wrong.

<a id="counts-only-never-a-verdict"></a>**Counts only — this verb ranks nothing, picks nothing and
renders no per-PR verdict.** `fabrika build pick` and `build eligible` answer which issue is next,
fail-closed on every axis; `build verdicts`, `ship gate` and `ship checks` answer a PR's state. A
second answer here could contradict the verb that actually claims the work. **And there is no
"banked" bucket**: what marks a pull request banked and what clears it on a head-move is an open
decision ([#4103](https://github.com/kamp-us/phoenix/issues/4103)).

**A bucket whose label does not exist renders `unknown` with `<detail>` `label absent`, never `0`.**
A zero count means the label exists and nothing carries it; an absent label means the question was
never askable. The header is `unknown` if any bucket is.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | the repository could not be read at all — every bucket is UNKNOWN, so there is no readout |

**No `7` seat.** Zero open issues is a *proven* count and a legitimate answer at exit `0`; there is
no zero-scope refusal for a verb whose scope is "this repository".

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status board: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, GITHUB_REPOSITORY, or pass --repo.` | 1 | refusal |
| `status board: cannot read <repo>: <reason> — every bucket is UNKNOWN, never 0.` | 11 | refusal |
| `status board: counted 6 buckets over <repo>, <u> unknown (<absent labels>); scanned <n> items.` | 0 | notice |

**Scope** — the open issues and pull requests of `--repo`, per bucket call, paginated, with each
bucket's scanned count on stderr.

**Examples**

```
$ fabrika status board
board	counted	6
bucket	needs-triage	7	labels=status:needs-triage	-	2026-08-09T14:22:05Z
bucket	triaged	23	labels=status:triaged	-	2026-08-09T14:22:05Z
bucket	in-flight	11	pulls?state=open	-	2026-08-09T14:22:06Z
bucket	p0	1	labels=p0	-	2026-08-09T14:22:06Z
bucket	p1	14	labels=p1	-	2026-08-09T14:22:06Z
bucket	p2	8	labels=p2	-	2026-08-09T14:22:06Z
```

```
$ fabrika status board --repo acme/storefront
board	unknown	6
bucket	needs-triage	unknown	labels=status:needs-triage	label absent	unknown
bucket	triaged	unknown	labels=status:triaged	label absent	unknown
bucket	in-flight	0	pulls?state=open	-	2026-08-09T14:23:01Z
bucket	p0	unknown	labels=p0	label absent	unknown
bucket	p1	unknown	labels=p1	label absent	unknown
bucket	p2	unknown	labels=p2	label absent	unknown
```

The second example is the fresh-repo case: the taxonomy is absent, so five buckets are `unknown`
while `in-flight` is a proven `0`. Rendering the five as `0` would tell a new user their queue is
clear when the question was never askable — the #4060 shape.

```
$ fabrika status board --json
{"outcome":"unknown","buckets":[{"name":"in-flight","count":0,"selector":"pulls?state=open","detail":null,"asOf":"2026-08-09T14:23:01Z","asOfKind":"read-now"},{"name":"p0","count":null,"selector":"labels=p0","detail":"label absent","asOf":null,"asOfKind":null}]}
```

**Grounding**

- #4103 — a FAIL'd pull request presented identically to a banked-ready one, and what "banked" means
  is still open. No bucket claims it.
- #4060 — a probe that read 0 files and classified at exit `0`. An absent label is `unknown`.
- the silent-green measurement (#4106) — an unmeasured value renders `n/a (reason)` rather than
  `0`, *"because … a rendered `0` would erase the difference at the last step."*
- skill-conventions §11 — REST, never GraphQL, and every list read paginates; an unpaginated read
  returns a plausible first page instead of an error.

---

## `status bootstrap`

**Invocation**

```
fabrika status bootstrap <surface-id> [--path <repo-relative>] [--repo <owner/name>] [--json]
```

Creates **one** missing surface from this group's own registry and reads it back. The content is the
skill's judgement; the write, the collision guard and the read-back are this verb's.

<a id="buildable-surfaces"></a>**The buildable-surface registry.** What this verb builds is fixed
here, not inferred from any declaration ([why](#disposition-does-not-gate-bootstrap)). Six ids, and
a seventh is a change to this table, not a new rule.

| `<surface-id>` | Target | Content | Read-back predicate |
|---|---|---|---|
| `design-manifest` | `--path`, default `design-system-manifest.md` at the repo root | **stdin**, required — the skill's inferred draft | the file's bytes match stdin through `normalizeForReadback` |
| `roadmap-focus` | `--path`, default `ROADMAP.md` at the repo root | **stdin**, required — to the [grammar below](#roadmap-grammar), which is not the drafting skill's judgement | same, plus the parsed row count in the notice ([why](#roadmap-grammar)) |
| `gitignore-row` | `--path`, default `.gitignore` at the repo root | **none** — the two comment lines and the row `/.fabrika/`, fixed below, appended to whatever the file already holds | the re-read contains both the row and the whole of the pre-existing text, each through `normalizeForReadback` |
| `label-taxonomy` | the repo's labels | **none** — the set is every imported `STATUSES` member (`status:needs-triage`, `status:triaged`, `status:needs-info`, `status:planned`, `status:awaiting-release`), every imported `PRIORITIES` member (`p0`, `p1`, `p2`), `type:` + every imported `TYPES` member, and `ready-for:` + every imported `AUDIENCES` member — sixteen today, each created with GitHub's default colour and a description naming this group as its creator | every label in the set resolves on a re-read |
| `issue-shape-markers` | the repo's labels | **none** — three labels, each at colour `1D76DB`, with the descriptions fixed below | every label in the set resolves on a re-read |
| `readout-artifact` | one open issue in the repo | **none** — title exactly `Governance readout`; body exactly the two lines below | the issue resolves open, its title matches exactly, and its body matches through `normalizeForReadback` |

<a id="taxonomy-is-derived"></a>**The taxonomy is derived from the vocabularies, never restated.**
Every name comes from the constant the writing verb already reads — `STATUSES` for the five statuses,
`PRIORITIES`, `TYPES` and `AUDIENCES` for the rest — so a seventh `TYPES` member widens what this
verb creates with no second edit anywhere. v1 restated two statuses and `PRIORITIES` and stopped, and
the eleven it omitted are each a label some verb writes; since a verb finds its label absent and
refuses rather than letting the API mint it (#4285), a repo that ran the whole documented bootstrap
could not `triage apply`, `triage park`, `plan flip` or `ship release` (#5772). In a repo bootstrapped
before the widening the verb reports `created` naming only the names it added, which is the honest
answer for a set that grew — not a contradiction of the earlier `exists`.

The three marker labels, fixed here so no clause defers to another skill's prose or to source:

| Label | Description, verbatim |
|---|---|
| `wayfinding:map` | `issue-shape marker: a wayfinding map (not a pipeline state, not pickable)` |
| `prototyping:spike` | `issue-shape marker: a disposable prototyping spike (not a pipeline state, not pickable)` |
| `grilling:session` | `issue-shape marker: a grilling session (not a pipeline state, not pickable)` |

<a id="markers-are-not-the-taxonomy"></a>**Why the markers are their own id and not a wider
`label-taxonomy`.** The taxonomy is the pipeline's state vocabulary: `status board` counts it and
`build pick` filters and ranks on it. A marker says what an issue *is* — nothing counts it, nothing
ranks it, and it is deliberately not pickable. They also carry a different colour and a different
description grammar, so one id covering both would be one id with a conditional inside it. Splitting
them also keeps `status bootstrap label-taxonomy` honest in a repo that already ran it: widening that
set would flip a settled `exists` back to `created` and make the earlier answer read as wrong. One id
covers all three markers rather than one each, because a fresh repo needs the whole set on day one —
`graduate trail` dispatches on two of them at once — and three ids means three commands, of which the
skipped one fails later in exactly the shape this registry exists to prevent.

<a id="roadmap-grammar"></a>**`roadmap-focus` is the one file whose shape is not the skill's
judgement.** Every other stdin surface is prose a human and the skill settle together; a `ROADMAP.md`
is read by machine — `triage homes` joins the repo's open milestones to its rows — so a plausible
draft that does not parse joins nothing. The grammar is stated here, in full, because the drafting
session must not need a second file open:

- The section headings are exactly `## Arcs` and `## Campaigns`. A section runs to the next `## `
  heading. Any other spelling — `## Arcs (2026)`, `### Arcs` — is not the section.
- Each row is `| <name> | #<number> | <state> |`, and it counts **only** when the *second* cell is
  `#<number>` and the first is non-empty. That is what drops the header row and the `|---|`
  separator without matching on their text.
- **The join key is that number, never the title.** An arc named `Geçit` pins a milestone titled
  `Sözlük — search and discovery`; the two share no substring, so a title cell joins nothing.
- The `State` column is **not read**. It is for humans; nothing filters on it.

```markdown
## Arcs

| Arc | Milestone | State |
|---|---|---|
| Geçit | #46 | active |
```

**So the write reports what parsed** — `status bootstrap roadmap-focus` runs the same parser over the
bytes it just wrote and appends the counts to its notice: `read-back conformed — 3 arcs, 0
campaigns`, singular at one (`1 arc`). `--json` carries them as the number fields `arcs` and
`campaigns`. The tab-separated line does not change.

**The count is reported, never enforced.** Zero arcs is still `created` at exit `0`, and the
read-back predicate stays the byte match this table states — a count is not a second predicate.
Refusing an unjoinable roadmap belongs to `triage homes`, whose exit `7` already fires at the point
the rows are actually needed; gating here would block the write a human then has to fix by hand. A
later reader tempted to "fix" this into a gate is looking at the design, not a gap.

The `gitignore-row` block, fixed here so no clause defers to source. The last line is the row
itself, and it is also the marker the collision guard and the read-back match on:

```gitignore
# fabrika's local machine state — the per-lane ledger `fabrika lane` writes under
# `.fabrika/lanes/<n>/`. One machine's run log; never committed.
/.fabrika/
```

<a id="line-surface"></a>**A line surface appends; it never rewrites what is already in the file.**
A `.gitignore` carries rows from every tool in the tree, so this verb is one contributor to a file it
does not author — which makes the file's existence the wrong collision guard. The guard is the row:
present anywhere in the text, this is `exists` at exit `0` and nothing is written; absent, the block
goes on the end and the pre-existing bytes are re-read intact. Both halves are substring reads over
the same marker, so a hand-added row spelled the same way is recognised as the row it is. A target
this verb cannot *read* is exit `11` — whether the row is already there is UNKNOWN, and appending
blind would be the duplicate row this guard exists to prevent.

The `readout-artifact` body, fixed here so no clause defers to another skill's prose:

```markdown
The durable home for the landed-decision digest. `fabrika governance readout` upserts a comment
here; `fabrika status readout` displays it. This issue stays open and is not worked.
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | string | yes | — | one `<surface-id>` from the registry above |
| `--path` | string | no | the registry default | override the target path for a file or line surface; must resolve inside the repository root |
| `--repo` | string | no | resolved | the repository, for the two non-file surfaces |
| `--json` | boolean | no | `false` | emit the result object |
| stdin | text | yes for `design-manifest` and `roadmap-focus` | — | the content. `NoStdin` and `Text("")` are exit `3`; a **failed** stdin read is exit `1` — the content is UNKNOWN, never empty, the split `packages/fabrika-cli/src/report/file-verb.ts` already ships |

**Output** — machine channel, [tab-separated](#separator). One line:

```
bootstrap	<created|exists>	<surface-id>	<target>	<readback>
```

`<target>` is the repo-relative path, `<owner>/<name>#<issue>`, or the comma-separated label list.
`<readback>` is `ok` for `created` and `-` for `exists`.

**`exists` is an exit-`0` answer, not a refusal.** A target that is already there is a proven fact the
caller acts on — it stops and reports the surface present — and a non-zero exit cannot carry it.
Nothing is written and nothing is overwritten.

**Partial existence is not existence.** For the two label surfaces, `exists` requires **every** label
in the set; where some are present the verb creates only the missing ones and reports `created` with
`<target>` naming exactly what it created. These are the surfaces holding many objects, so this is
the one place the rule has to be stated.

**A label is matched by name, not by shape.** Both label surfaces read the repo's label *names*, so a
label someone created by hand at another colour or with another description reads `exists` at `0` and
is left exactly as it is. That is what "nothing is written and nothing is overwritten" costs: the
verb converges a repo that has none of them, and never re-shapes one that already has them under the
same name. Reconciling a hand-made label's colour is a hand fix.

**The operation.** Resolve the id against the registry — not in it is `12`. Probe the target; already
present is `exists` at `0`. For a stdin surface: read stdin, leak-scan the content (`5`, `6`), write,
re-read and compare through `normalizeForReadback` (`9` on mismatch), and for `roadmap-focus` parse
the written bytes and [report the counts](#roadmap-grammar). For the [line
surface](#line-surface) the probe is the marker rather than the path, the content is the registry's
own block so no stdin is read and no leak scan is owed, and the read-back asserts the marker **and**
the prior text. A write whose outcome cannot be
confirmed is `8`, never a reported success. **One surface per invocation**, deliberately: a verb
creating several would have to report a partial outcome, and a partial write reported as success is
#4557's shape. The skill loops.

**Exit status**

| Code | Trigger |
|---|---|
| `3` | stdin was `NoStdin` or empty, for a surface that requires content |
| `5` | the stdin content carries a machine-local path |
| `6` | the stdin content is a bare `@` path reference — not redactable |
| `8` | the write failed — whether anything landed is **UNKNOWN**; re-read before retrying |
| `9` | the write landed and the read-back does not match |
| `10` | `--path` resolves outside the repository root |
| `11` | a precondition read failed — the existence probe could not be performed; **nothing was written** |
| `12` | `<surface-id>` is not in the [buildable-surface registry](#buildable-surfaces) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status bootstrap: stdin held nothing — <surface-id> requires content.` | 3 | refusal |
| `status bootstrap: cannot read stdin: <reason> — the content is UNKNOWN, never empty.` | 1 | refusal |
| `status bootstrap: the supplied content carries a machine-local path: <match>.` | 5 | refusal |
| `status bootstrap: the supplied content is a bare @ path reference — not redactable.` | 6 | refusal |
| `status bootstrap: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, GITHUB_REPOSITORY, or pass --repo.` | 1 | refusal |
| `status bootstrap: writing <target> failed: <reason> — whether it landed is UNKNOWN. Re-read before retrying.` | 8 | refusal |
| `status bootstrap: wrote <target> and the read-back differs — the outcome is UNKNOWN.` | 9 | refusal |
| `status bootstrap: --path <v> resolves outside the repository root.` | 10 | usage error |
| `status bootstrap: cannot probe <target>: <reason> — nothing was written.` | 11 | refusal |
| `status bootstrap: cannot read <target>: <reason> — whether <marker> is already there is UNKNOWN, and nothing was written.` | 11 | refusal |
| `status bootstrap: appending <marker> to <target> failed: <reason> — whether it landed is UNKNOWN. Re-read before retrying.` | 8 | refusal |
| `status bootstrap: appended <marker> to <target> and it could not be read back: <reason> — the outcome is UNKNOWN.` | 8 | refusal |
| `status bootstrap: appended <marker> to <target> and the read-back differs — the outcome is UNKNOWN.` | 9 | refusal |
| `status bootstrap: "<v>" is not a buildable surface. Known: design-manifest, roadmap-focus, gitignore-row, label-taxonomy, issue-shape-markers, readout-artifact.` | 12 | refusal |
| `status bootstrap: created <target> for <surface-id>, read-back conformed.` | 0 | notice |
| `status bootstrap: created <target> for roadmap-focus, read-back conformed — <n> arc(s), <n> campaign(s).` | 0 | notice |
| `status bootstrap: appended <marker> to <target> for <surface-id>, read-back conformed.` | 0 | notice |

**Scope** — the single write target named by `<surface-id>`.

**Examples**

```
$ fabrika status bootstrap design-manifest <<'EOF'
# Design system manifest
## Colour
Brand: #1f5fd6
EOF
bootstrap	created	design-manifest	design-system-manifest.md	ok
```

```
$ fabrika status bootstrap readout-artifact
bootstrap	created	readout-artifact	acme/storefront#9420	ok
```

```
$ fabrika status bootstrap roadmap-focus <<'EOF'
# Roadmap
## Arcs
| Arc | Milestone | State |
|---|---|---|
| Storefront | #12 | active |
EOF
bootstrap	created	roadmap-focus	ROADMAP.md	ok
status bootstrap: created ROADMAP.md for roadmap-focus, read-back conformed — 1 arc, 0 campaigns.
```

```
$ fabrika status bootstrap roadmap-focus --json < inert-draft.md
{"outcome":"created","surfaceId":"roadmap-focus","target":"ROADMAP.md","readback":"ok","arcs":0,"campaigns":0}
$ echo $?
0
```

The second is a draft whose milestone cells carry titles rather than `#<n>`: written, conformed, and
joining nothing. It exits `0` — the count is the signal, not a gate.

```
$ fabrika status bootstrap merge-queue
status bootstrap: "merge-queue" is not a buildable surface. Known: design-manifest, roadmap-focus, label-taxonomy, issue-shape-markers, readout-artifact.
$ echo $?
12
```

```
$ fabrika status bootstrap label-taxonomy --json
{"outcome":"created","surfaceId":"label-taxonomy","target":"status:needs-triage,p1","readback":"ok"}
```

**Grounding**

- #4952 (founder, 2026-08-09) — *"/fabrika shows what's missing, then runs the primitives to build the
  missing thing — we don't build a new onboarding thing."* The verb is the primitive; the inference
  and grilling that compose the content are the skill's, which is why content arrives on stdin.
- `build-ui/SKILL.md` declares `design-system-manifest.md` **fail-loud** and its row points at
  front-door's bootstrap — which is why buildability is this registry's answer and never a reading of
  the disposition word. Three landed skills route a user here for that one file.
- `packages/fabrika-cli/src/report/compose.ts` — `normalizeForReadback`'s third step strips trailing
  newlines; a re-derivation that drops it fires `9` on every clean run.
- `packages/fabrika-cli/src/io/stdin.ts` — three variants. `Failed` on `1` and empty on `3` keeps "I
  could not read the content" apart from "there was none".
- #3086 / #3173 / #4199 are the leak-guard lane's incidents, not claimed here — but the path
  discipline binds this verb, which is why `5` and `6` are seated on content it writes to a public
  surface.
- ADR 0092 — the existence probe fails closed: `exists` in `packages/fabrika-cli/src/io/fs.ts`
  **fails** on an unperformable probe rather than returning `false`, so an unreadable target is `11`
  and never a silent overwrite.

---

## Required repo files

The verbs in this group are what the *other* skills' bootstrap pointers resolve to, so this table
states what the group itself needs. Dispositions use the canonical three.

| Must exist | Why this group needs it | When missing |
| --- | --- | --- |
| A resolvable skill roster — the installed plugin's own skills tree, `claude-plugins/fabrika/skills/` in the target repo, that same path in the checkout the CLI itself runs from, or an explicit `--skills-dir` | it is the roster `status menu` renders and the declaration set `status config` parses | **degrade** — an implicitly-resolved roster holding zero skills is `empty` / `gaps` at exit `0`, never silence; only an **explicitly passed** absent path is `7`, and an unreadable one is `11` ([why](#roster-location)). |
| A resolvable repo — `--repo`, `$CLAUDE_PIPELINE_REPO`, `$GITHUB_REPOSITORY`, or an `origin` remote | `board`, `readout` and the non-file arms of `bootstrap` read against it | **degrade** for `status open`, which renders those fields `unknown`; **fail-loud** at exit `1` for `board`, `readout` and `bootstrap` invoked directly, which have no other answer to give. |
| The board label taxonomy — the whole set the [buildable-surface registry](#buildable-surfaces) derives, not a subset restated here | `status board`'s six bucket calls read five of it; every state-writing verb elsewhere needs the rest | **bootstrap** — absent labels render `unknown` with detail `label absent`, never `0`, and `status bootstrap label-taxonomy` creates the whole set. |
| The issue-shape markers — `wayfinding:map`, `prototyping:spike`, `grilling:session` | `status bootstrap issue-shape-markers` is where three skills' bootstrap pointers land | **bootstrap** — `status bootstrap issue-shape-markers` creates the whole set, and reports `exists` at `0` where it is already there. |
| One open issue titled exactly `Governance readout`, or `$FABRIKA_GOVERNANCE_READOUT_ISSUE` | `status readout`'s artifact | **bootstrap** — `status bootstrap readout-artifact` creates it; until then the reading is `absent` at exit `0`, a proven fact and not a failed read. |
| The registered `governance-digest` wire format | `status readout` decodes the artifact block through it | **fail-loud** — exit `11`, UNKNOWN, never `absent`. Not built yet; tracked at [#5199](https://github.com/kamp-us/phoenix/issues/5199) ([sequencing](#sequencing)). |

**Nothing else is read.** No design manifest, `ROADMAP.md`, `.decisions/` or `.github/CODEOWNERS` is
an input: `bootstrap` *writes* the first two from supplied content without reading them to judge by,
`readout` prints decision ids without opening the records, and §CP is CODEOWNERS' answer, computed
nowhere here.

## Capability declaration

Shell; a repo-scoped GitHub token; filesystem reads under the repository root and over the resolved
roster; filesystem **writes** only through `status bootstrap`, only inside the repository root, only
to a target proven absent first. GitHub writes: exactly two, both `status bootstrap`'s — creating the
readout artifact issue, and creating board labels. **No push, no branch, no merge, no merge-queue
access, no pull request, and no label applied to any existing issue.** This group emits no cross-lane
signal of any kind.

**`fabrika status open` is the command the skill injects**, so its capability set is the one that
matters most: read-only over the filesystem and GitHub, takes no stdin, and writes nothing. **The
injected form cannot refuse** — it passes no flags, so its one refusal seat (`10`, a bad `--field`)
is unreachable, and every source failure becomes a field state. It can still fail to *run* (`1`, `126`,
`127`), which is the no-readout case the skill handles as its own state. Nothing that mutates is ever
injected.
