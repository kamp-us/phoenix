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
| `status open` | the composite front-door readout: six fields, each with its own state, source and freshness | assembling six independent reads and rendering each one's three-state outcome is a total function; deciding what to *do* about a gap is the skill's |
| `status settings` | every key on the `.fabrika.jsonc` config surface, its resolved value, and where that value came from | resolving a key against a shipped default and naming its provenance is a total function; deciding what a repo *should* declare is judgment |
| `status wiring` | whether `.claude/settings.json` enables the fabrika plugin — the precondition under every other verb | reading one `enabledPlugins` key and reporting what it says is mechanical; deciding to *wire* the repo is the operator's, and creating the file is `status bootstrap`'s |
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
  ([rule 3](../../docs/interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is)).
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
  `status open`, which renders those fields `unknown`, nor for `menu` and `settings`, neither of
  which reads the repo at all.
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
would make `menu` empty on precisely the fresh repo this skill onboards.

So `menu` — and `status open`, through the core it imports — **resolves the roster
itself**, in this order, and print which tier served it on the scope line. (`bootstrap` is not on
this list: it builds from a fixed [registry](#buildable-surfaces) and reads no roster at all.)

1. `--skills-dir <path>`, when given explicitly.
2. `$CLAUDE_PLUGIN_ROOT`, when it is set and holds a plugin manifest — the harness's own answer for
   which plugin is running, and the only rung that stays correct if the cache layout changes. It is
   read by the verb, never written into a fence: interface rule 5 constrains the **command string**
   the model runs, and ADR [0235](../../../../.decisions/0235-fences-carry-zero-expansions.md) puts
   everything dynamic inside what the fence invokes. It cannot be the only rung, because the harness
   sets it for plugin hooks and plugin-provided commands and **not** for an ordinary Bash call.
3. A plugin tree the running module itself sits inside, found by walking up for the manifest. This
   fires only where a consumer vendors the CLI into its own plugin; neither shape fabrika ships in
   packages it that way.
4. `claude-plugins/fabrika/skills/` beneath the repo root, which is the in-repo development case.
5. That same `claude-plugins/fabrika/skills/` beneath the checkout the CLI itself runs from, found by
   walking up from the running module — the rung that answers when fabrika runs out of a phoenix
   checkout against a target repo carrying no roster of its own, where rung 3 cannot fire (the CLI at
   `packages/fabrika-cli/` has no plugin manifest above it) and rung 4 is rooted at that target repo
   (#5775).
6. The installed fabrika plugin in Claude Code's plugin cache
   (`<config>/plugins/cache/<marketplace>/<plugin>/<version>/`), matched by the **manifest's declared
   `name`** rather than the directory, since the path carries a marketplace name and a content hash
   that both change without the plugin changing. Versions the harness has stamped `.orphaned_at` are
   skipped and `.in_use` breaks a tie. This is the rung that answers the marketplace shape, where the
   plugin sits in the cache and the CLI is a separate global npm package, so no walk from either the
   module or the cwd can reach the roster (#6448). It sits **below** rungs 4 and 5 on purpose: a
   phoenix developer has both an installed plugin and a checkout, and reading the published roster
   there would render skills the working tree does not have.

The tier word printed on the scope line is `explicit` · `env` · `plugin` · `repo` · `checkout` ·
`cache`, one per rung in that order.

**A roster that resolves and holds zero skills is `empty` at exit `0`, a fact, not a refusal.** These
are supplying verbs, and interface convention §4 requires a supplying verb to decide once, in its
header, whether an empty result is a fact or a failed read: **an empty roster is a fact** (a fresh or
partial install), an unreadable one is `11`. Exit `7` is reserved for an **explicitly passed**
`--skills-dir` that is proven absent — a caller error, not a state of the world — and it is seated on
`menu` only. **`status open` is exempt though it takes the same flag**: it is the
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
| `settings` | every key resolved, declared or defaulted | `resolved` | `<n> keys, <d> declared` |
| `settings` | ≥1 key `unknown` | `unknown` | which keys are unread — a repo whose config will not parse has no known value for anything, and printing the shipped default there is the collapse the surface exists to prevent |
| `settings` | the surface registers zero keys | `unknown` | `the config surface registers zero keys` — vacuously-resolved is not resolved (ADR 0092) |
| `wiring` | `enabledPlugins` carries a `fabrika@<marketplace>` key set to `true` | `wired` | which key is enabled |
| `wiring` | no settings file, no `enabledPlugins` block, no fabrika key, a key switched off, or a key naming no marketplace | `unwired` | which of those it was. **Never `unknown`**: the repo proved each of them, and folding them into `unknown` hides the one gap this field exists to name |
| `wiring` | the settings file, or the repo root above the cwd, could not be read; the bytes are not a JSON object; `enabledPlugins` is not an object; the fabrika key is neither `true` nor `false` | `unknown` | the raw failure. **Never `unwired`**: a probe nobody could perform proves nothing about what loads |
| `board` | every bucket counted | `counted` | the two headline counts |
| `board` | ≥1 bucket `unknown`, or the repo unresolvable/unreadable | `unknown` | the raw failure, or the absent labels |
| `readout` | digest block found | `found` | `<n> rows` |
| `readout` | artifact read, no digest block | `absent` | `no digest block in <ref>` |
| `readout` | artifact read, block present, a row non-conforming | `malformed` | which row failed |
| `readout` | repo resolved, no artifact found | `absent` | `no readout artifact` |
| `readout` | repo unresolvable | `unknown` | `cannot resolve a repo — a failed read, not an absent digest`. **Never `absent`**: a repo that was never resolved proves nothing about whether an artifact exists in it |
| `readout` | artifact unfetchable, or the format unregistered | `unknown` | the raw failure |
| `readout` | artifact fetched, its `updated_at` unreadable | `unknown` | `freshness unreadable` — a digest whose age cannot be established is not a digest you may present as current |
| `menu` | roster readable, one `SKILL.md` inside it unreadable | `unknown` | which file failed — a partial roster is not a roster |
| `lanes` | sweep answered, ≥1 lane verdicted `stale` | `stale` | `<n> stale: <key> (<age>m), …` — each silent lane named with its age |
| `lanes` | sweep answered, zero `stale`, zero `unreadable` | `empty` | `no lanes on disk`, or `<n> lane(s), none silent past <threshold>m` — the threshold echoed from the verb's answer, never a second constant. **Zero lanes on disk is this row, not a fault**: a fresh checkout has none |
| `lanes` | sweep answered, zero `stale`, ≥1 lane record `unreadable` | `unknown` | which lane failed and why — a lane whose silence cannot be judged is never flattened to clean |
| `lanes` | the sweep refused — a lane root is there and cannot be listed | `unknown` | the refusal's reason — the lane set is UNKNOWN, never empty |

**A proven-absent artifact is `absent` inside the composite, never `unknown`** — the two rows above
that both yield `absent` are both facts about the repository, and only a failed *read* is `unknown`.

### The shared exit taxonomy

All seven verbs allocate from one internal table (`packages/fabrika-cli/src/status/codes.ts`), so a
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

| Code | Meaning | open | settings | menu | readout | board | bootstrap |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `0` | the answer is on stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `1` | usage error, unresolvable repo where the answer requires one, a failed stdin read, or the verb failed to run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `126` | no implementation could be resolved | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `3` | stdin was read and held nothing | — | — | — | — | — | ✓ |
| `4` | *(deliberate gap — `report file`'s body-section seat; no verb here composes body sections)* | — | — | — | — | — | — |
| `5` | the **authored** content carries a machine-local path | — | — | — | — | — | ✓ |
| `6` | the **authored** content is a bare `@` path reference — not redactable | — | — | — | — | — | ✓ |
| `7` | zero scope: an **explicitly passed** `--skills-dir` is proven absent, or the config surface registers zero keys (ADR 0092) | — | ✓ | ✓ | — | — | — |
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
(nothing in the package walks a skills tree) and the composite renderer.

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
| `--field` | string | no | all six | render one field only — `menu`, `settings`, `wiring`, `board`, `readout` or `lanes`; any other value is off-vocabulary |
| `--repo` | string | no | resolved | the repository the board and digest fields read |
| `--skills-dir` | string | no | [resolved](#roster-location) | the roster root the menu field reads |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). A header line, then one line per field:

```
open	<field-count>
field	<name>	<state>	<detail>	<source>	<as-of>
```

`<name>` ∈ `menu` · `settings` · `wiring` · `board` · `readout` · `lanes`. `<state>` is drawn from that field's closed set,
**every one of which includes `unknown`**, and is produced by [the mapping](#core-to-field):

| Field | Closed state set |
|---|---|
| `menu` | `ready` · `empty` · `unknown` |
| `settings` | `resolved` · `unknown` |
| `wiring` | `wired` · `unwired` · `unknown` |
| `board` | `counted` · `unknown` |
| `readout` | `found` · `absent` · `malformed` · `unknown` |

`<source>` names where the answer came from so the session can re-run one read instead of adopting
the render: the resolved roster path for `menu`, `.fabrika.jsonc` for `settings`,
`.claude/settings.json` for `wiring`, `<owner>/<name>` for `board`, and
`<owner>/<name>#<issue>` for `readout` when an artifact resolved — otherwise `<owner>/<name>`.

**No aggregate state, deliberately.** A roll-up over six independently-sourced fields would need a
rule for "three fine, one unknown", and every such rule either hides the unknown or drowns the three.

**Exit status**

| Code | Trigger |
|---|---|
| `10` | `--field` is not one of `menu`, `settings`, `wiring`, `board`, `readout`, `lanes` |

**That is the whole table, and it is the point** ([why](#open-is-total)). An unresolvable repo, an
unreachable GitHub, an unreadable roster, an absent roster and an unregistered digest format each
render their field `unknown` or `empty` at exit `0`. This verb is injected before the session reads a
token; a refusal would write zero bytes on the cold start it exists for.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status open: --field "<v>" is not one of menu, settings, wiring, board, readout, lanes.` | 10 | usage error |
| `status open: roster <path> (<tier>), <n> skills; repo <owner/name>; <k> field(s) rendered, <u> unknown.` | 0 | notice |

**Scope** — the fields requested, each named on the scope line with the source it resolved and the
roster tier that served it.

**Examples**

```
$ fabrika status open
open	6
field	menu	ready	12 skills	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	settings	resolved	15 keys, 4 declared	.fabrika.jsonc	2026-08-09T14:22:03Z
field	wiring	wired	fabrika@kampus is enabled — sessions in this repo load fabrika's skills	.claude/settings.json	2026-08-09T14:22:03Z
field	board	counted	7 needs-triage, 23 triaged	kamp-us/phoenix	2026-08-09T14:22:05Z
field	readout	found	6 rows	kamp-us/phoenix#9412	2026-08-08T09:00:00Z
field	lanes	empty	no lanes on disk	.fabrika/lanes,.fabrika/chores	2026-08-09T14:22:05Z
```

The adopter case, where the CLI answers and no skill can load — the shape that went unseen for two
days in kamp-us/demlik#26:

```
$ fabrika status open
open	6
field	menu	ready	12 skills	claude-plugins/fabrika/skills	2026-08-09T14:22:03Z
field	settings	resolved	15 keys, 0 declared	.fabrika.jsonc	2026-08-09T14:22:03Z
field	wiring	unwired	no .claude/settings.json — no fabrika skill can load in a session here	.claude/settings.json	2026-08-09T14:22:03Z
field	board	unknown	cannot reach api.github.com: EAI_AGAIN — a failed read, not zero issues	kamp-us/phoenix	unknown
field	readout	unknown	the governance-digest format is not registered — a failed read, not an absent digest	kamp-us/phoenix	unknown
field	lanes	empty	no lanes on disk	.fabrika/lanes,.fabrika/chores	2026-08-09T14:22:05Z
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

## `status settings`

**Invocation**

```
fabrika status settings [--root <dir>] [--surfaces] [--json]
```

The resolved config surface: every key `.fabrika.jsonc` may carry, what it resolves to here, and
where that value came from. It is the one place a skill asks what a key resolves to, so no skill
document has to restate a value (R9.1, #6293). It reads; it writes nothing.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--root` | string | no | the repository root, else the cwd | the directory holding `.fabrika.jsonc` |
| `--surfaces` | boolean | no | `false` | expand `surfaceDispositions` into one row per repo surface |
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
roots are the five shipped defaults" and "the governance roots are five values this repo declared"
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

<a id="surfaces-expands-one-key"></a>**`--surfaces` expands one key; it does not add a readout.**
`surfaceDispositions` resolves to an id-to-word map, and a map alone cannot tell an operator what a
surface *is* — that half is the registry's per-surface note, and relaying it is what `front-door`
step 3 does. With the flag, `surface` rows are appended to the same answer, in registry order:

```
surface	<id>	<fail-loud|degrade|bootstrap>	<what the surface is, and the verb arm its disposition was read off>
```

The disposition cell is the one this repo **resolves to** — a declared override prints over the
shipped word. Resolving is all it does: nothing in the CLI branches on a disposition, and
`status/settings-verb.ts` is its only reader. The cell says what this repo declared it wants, which
is what an operator relays; whether a verb should read it is
[#6412](https://github.com/kamp-us/phoenix/issues/6412). The note cell is flattened to one line and **not** clamped: every other prose cell points at
something the reader can go and look at, while this one is the whole answer. There is no separate
resolver — the rows come off the same `settingRows` read, which is what keeps "what does this repo
have" on one path. Under `--json` the same rows are a `surfaces` array, present only when the flag
was passed. A key that resolved `unknown` still makes the whole readout a refusal at `11`, with no
surface rows: a surface readout over shipped defaults the repo may have overridden is exactly the
collapse this verb refuses.

With `--json`, stdout is one object carrying `outcome` (the header's state), `path`, `keys`,
`declared`, `unknown`, and `settings` — one entry per row with `key`, `provenance`, `value` and
`detail`, plus `asOf`/`asOfKind`. Two fields differ from the tab form: `path` has no cell there, and
`detail` carries the same literal `-` an empty cell prints rather than being omitted. A refusal at
`7` or `11` emits no object, since a non-zero exit [carries no payload](#separator).

**Exit status**

| Code | Trigger |
|---|---|
| `7` | the config surface registers zero keys, or `--surfaces` was passed and no `surfaceDispositions` key is registered — nothing to resolve, and a readout over an empty surface is not an answer (ADR 0092) |
| `11` | `.fabrika.jsonc` exists and could not be read, is not a JSON object, holds a value the surface refuses, or refused the whole load — UNKNOWN, never green |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status settings: the config surface registers zero keys — there is nothing to resolve, and a readout over an empty surface is not an answer (ADR 0092).` | 7 | refusal |
| ``status settings: the config surface registers no `surfaceDispositions` key, so there are no surfaces to expand (ADR 0092).`` | 7 | refusal |
| `status settings: <n> key(s) resolve UNKNOWN (<keys>) — what this repo runs on is unread, never the shipped default.` | 11 | refusal |
| `status settings: no .fabrika.jsonc — every key falls to its shipped default; <n> key(s), <d> declared, <u> unknown.` | 0 | notice |
| `status settings: read .fabrika.jsonc; <n> key(s), <d> declared, <u> unknown.` | 0 | notice |
| `status settings: could not read .fabrika.jsonc: <reason>; <n> key(s), <d> declared, <u> unknown.` | 11 | notice |

**Scope** — every key in `packages/fabrika-cli/src/config/registry.ts`, resolved against one open and
one parse of the file. No pagination: the scope is a registry, not a list read.

**Examples**

Every transcript below is from phoenix, where the registry holds **15** keys and the file declares
**5** of them. Row sets are abridged to the ones the example is about; the counts on the header line
are not.

```
$ fabrika status settings
settings	resolved	15	5	0	2026-08-19T20:43:22Z
setting	capClearAuthors	declared	["@usirin","@notusirin","@cansirin"]	-	2026-08-19T20:43:22Z
setting	codeValidators	declared	[{"command":["pnpm","typecheck","--force"]},{"command":["pnpm","lint:worktree"]}]	-	2026-08-19T20:43:22Z
setting	docLeakExempt	declared	["/CLAUDE.md",…]	-	2026-08-19T20:43:22Z
setting	governedRoots	default	[".decisions/",".claude/",".github/","claude-plugins/",".fabrika.jsonc"]	.fabrika.jsonc declares no `governedRoots`	2026-08-19T20:43:22Z
setting	unreadableCodeowners	declared	"refuse"	-	2026-08-19T20:43:22Z
setting	workflowValidators	declared	[]	-	2026-08-19T20:43:22Z
```

With `--surfaces`, the same rows plus one per repo surface (abridged — phoenix registers 38):

```
$ fabrika status settings --surfaces
settings	resolved	15	5	0	2026-08-19T20:43:22Z
setting	surfaceDispositions	default	{"gh-rest":"fail-loud","git-worktree":"fail-loud",…}	.fabrika.jsonc declares no `surfaceDispositions`	2026-08-19T20:43:22Z
surface	gh-rest	fail-loud	a GitHub repo reachable over `gh` REST with `issues: write`; every issue-writing verb exits 11 without it, and a run with no board is no answer rather than a narrower one
surface	roadmap-focus	degrade	the `## Campaigns` table at `roadmapFile`, which declares the campaign in exclusive focus; an absent file and an absent table are the same well-formed default — nothing is active, so `build pick`'s and `build claim`'s fence is inert and admits every issue …
```

The same run under `--json` — the notice line stays on stderr, so stdout is the object alone:

```
$ fabrika status settings --json
{"outcome":"resolved","path":".fabrika.jsonc","keys":15,"declared":5,"unknown":0,"settings":[{"key":"capClearAuthors","provenance":"declared","value":["@usirin","@notusirin","@cansirin"],"detail":"-","asOf":"2026-08-19T20:43:22Z","asOfKind":"read-now"},…,{"key":"governedRoots","provenance":"default","value":[".decisions/",".claude/",".github/","claude-plugins/",".fabrika.jsonc"],"detail":".fabrika.jsonc declares no `governedRoots`","asOf":"2026-08-19T20:43:22Z","asOfKind":"read-now"},…,{"key":"workflowValidators","provenance":"declared","value":[],"detail":"-","asOf":"2026-08-19T20:43:22Z","asOfKind":"read-now"}]}
```

```
$ fabrika status settings --root /srv/storefront
status settings: could not read .fabrika.jsonc: /srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory; 15 key(s), 0 declared, 15 unknown.
setting	capClearAuthors	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-19T20:51:02Z
setting	docLeakExempt	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-19T20:51:02Z
setting	governedRoots	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-19T20:51:02Z
setting	workflowValidators	unknown	UNKNOWN	/srv/storefront/.fabrika.jsonc: EISDIR: illegal operation on a directory	2026-08-19T20:51:02Z
status settings: 15 key(s) resolve UNKNOWN (boardVocabulary, capClearAuthors, ci, …, workflowValidators) — what this repo runs on is unread, never the shipped default.
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

## `status wiring`

**Invocation**

```
fabrika status wiring [--root <dir>] [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--root` | string | no | the repo root above the cwd | the directory holding `.claude/settings.json` |
| `--json` | boolean | no | `false` | emit the result object |

**Output** — machine channel, [tab-separated](#separator). One line:

```
wiring	<wired|unwired>	<entry>	<marketplace>	<detail>	<as-of>
```

`<entry>` is the `enabledPlugins` key naming fabrika and `<marketplace>` is that key's source half;
each is `-` when the file names none.

<a id="wiring-is-the-other-half"></a>**Every other verb in this group answers about something the
CLI reads. This one answers about the plugin that carries the skills.** A repo can have the CLI
installed and answering while no fabrika skill can load in a session there, and nothing said so
until this verb existed — kamp-us/demlik#26 ran that way for two days with every other status
surface green ([#6443](https://github.com/kamp-us/phoenix/issues/6443)).

**The gating fact is `enabledPlugins`, and the marketplace source is the key's own suffix.** A
Claude Code `enabledPlugins` key is `plugin@marketplace`, so one entry carries both halves the
wiring needs; a bare `fabrika` key names no source and resolves to no plugin, so it is `unwired`.
`extraKnownMarketplaces` is **deliberately not read**: ADR
[0273](../../../../.decisions/0273-fabrika-ships-as-an-installed-plugin.md)'s 2026-08-16 amendment
records that Claude Code never registers a project-scope `extraKnownMarketplaces` block (verified
live on [#5705](https://github.com/kamp-us/phoenix/issues/5705)), so a repo carrying one is no more
wired than a repo without, and reading it as evidence would green a session that loads nothing.

**`unwired` is an answer at exit `0`, and `unknown` is a refusal.** A proven-off plugin is a fact
the caller acts on — the seat `status board`'s proven `0` and `status readout`'s `absent` take —
while a probe that could not be performed has no answer to seat.

**It detects; it never writes.** Creating `.claude/settings.json` is `status bootstrap`'s registry
work under epic [#5979](https://github.com/kamp-us/phoenix/issues/5979). A probe that repaired what
it measured could never report the state it found, and a repo that never ran bootstrap would still
need this answer.

**Exit status**

| Code | Trigger |
|---|---|
| `11` | the repo root could not be resolved; `.claude/settings.json` exists and could not be read; its bytes are not JSON or not a JSON object; `enabledPlugins` is not an object; the fabrika entry is neither `true` nor `false` |

**No `7` seat.** An absent settings file is a *proven* negative and a legitimate answer at exit `0`;
there is no zero-scope refusal for a verb whose scope is "this repository's settings file".

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `status wiring: <what failed> — whether a session here loads fabrika's skills is UNKNOWN, never unwired and never green.` | 11 | refusal |
| `status wiring: <how the file was found>; plugin fabrika is <state>.` | 0 | notice |

**Scope** — one file, `.claude/settings.json`, under `--root` or the repository root above the cwd.

**Examples**

```
$ fabrika status wiring
wiring	wired	fabrika@kampus	kampus	fabrika@kampus is enabled — sessions in this repo load fabrika's skills	2026-08-20T16:41:45Z
```

```
$ fabrika status wiring
wiring	unwired	-	-	no .claude/settings.json — no fabrika skill can load in a session here	2026-08-20T16:41:58Z
$ echo $?
0
```

```
$ fabrika status wiring --json
{"outcome":"unwired","path":".claude/settings.json","entry":"fabrika@kampus","marketplace":"kampus","detail":"enabledPlugins carries fabrika@kampus switched off","asOf":"2026-08-20T16:42:10Z","asOfKind":"read-now"}
```

**Grounding**

- #6443 / kamp-us/demlik#26 — the CLI half answered and the skill half silently did not exist; no
  status surface said so for two days.
- ADR 0273 (2026-08-16 amendment) / #5705 — project-scope `extraKnownMarketplaces` is inert, which
  is why the marketplace source is read off the `enabledPlugins` key instead.
- #5979 — the emit side. This verb is its detection companion and stays out of its registry.

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

- ADR 0129 and `DEVELOPMENT.md` — the directory is the list. v1's `decisions-index compact` and
  `commands compact` were the repo's two generated-on-demand, never-auto-injected indexes; both died
  with that package (#6100, and #6332 tracks the ADR map's absence), so this roster is the shape's
  only live instance, implemented in fabrika's package (ADR 0238).
- v1's `decisions-index`, designed out: its committed `index.md` was deleted because a stored index
  drifts, yet `checkIndex` and `generateIndex` shipped on, still comparing against the deleted file
  and still printing a fix command naming a package that no longer existed. A derived roster leaves
  no such surface behind.
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

Creates **one** missing surface from this group's own registry and reads it back; an adoption
surface merges into a file that is already there instead (ADR
[0334](../../../../.decisions/0334-bootstrap-merge-into-present-files.md)). The content is the
skill's judgement; the write, the collision guard and the read-back are this verb's.

<a id="buildable-surfaces"></a>**The buildable-surface registry.** What this verb builds is fixed
here, not inferred from any declaration. Nine ids, and
a tenth is a change to this table, not a new rule.

| `<surface-id>` | Target | Content | Read-back predicate |
|---|---|---|---|
| `design-manifest` | `--path`, default `design-system-manifest.md` at the repo root | **stdin**, required — the skill's inferred draft | the file's bytes match stdin through `normalizeForReadback` |
| `roadmap-focus` | `--path`, default the `roadmapFile` this repo declares, itself defaulting to `ROADMAP.md` | **stdin**, required — to the [grammar below](#roadmap-grammar), which is not the drafting skill's judgement | same, plus the parsed row count in the notice ([why](#roadmap-grammar)) |
| `gitignore-row` | `--path`, default `.gitignore` at the repo root | **none** — the two comment lines and the row `/.fabrika/`, fixed below, appended to whatever the file already holds | the re-read contains both the row and the whole of the pre-existing text, each through `normalizeForReadback` |
| `claude-md-section` | `--path`, default `CLAUDE.md` at the repo root | **none** — the canonical operator-first "work flows through fabrika" section, fixed below, appended when its marker heading `## Work flows through fabrika` is absent (ADR [0334](../../../../.decisions/0334-bootstrap-merge-into-present-files.md)'s append-if-absent arm) | the re-read contains both the heading and the whole of the pre-existing text, each through `normalizeForReadback` |
| `label-taxonomy` | the repo's labels | **none** — the set is every imported `STATUSES` member (`status:needs-triage`, `status:triaged`, `status:needs-info`, `status:planned`, `status:awaiting-release`), every imported `PRIORITIES` member (`p0`, `p1`, `p2`), `type:` + every imported `TYPES` member, and `ready-for:` + every imported `AUDIENCES` member — sixteen today, each created with GitHub's default colour and a description naming this group as its creator | every label in the set resolves on a re-read |
| `issue-shape-markers` | the repo's labels | **none** — three labels, each at colour `1D76DB`, with the descriptions fixed below | every label in the set resolves on a re-read |
| `readout-artifact` | one open issue in the repo | **none** — title exactly `Governance readout`; body exactly the two lines below | the issue resolves open, its title matches exactly, and its body matches through `normalizeForReadback` |
| `settings-patch` | `--path`, default `.claude/settings.json` at the repo root | **none** — the two keys [fixed below](#json-key-merge), merged into the object a present file parses to, written whole into a file that is absent | a present file re-reads to the merged object — every undeclared key intact, the declared keys at their registry values — through `normalizeForReadback` |
| `dep-pin` | `--path`, default `package.json` at the repo root | **none** — the `dependencies.@kampus/fabrika-cli` row at the version npm's registry currently [publishes](#json-key-merge), merged into the object a present manifest parses to, written whole into a manifest that is absent | a present manifest re-reads to the merged object — every undeclared key intact, the row at exactly the resolved version — through `normalizeForReadback`; an unreachable registry refuses unwritten |

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
- The `State` column **is read on a campaign row**: `active` there is the dispatch permission,
  so `build`'s scope fence admits a lane only under an `active` campaign (ADR
  [0304](../../../../.decisions/0304-campaign-active-is-the-dispatch-permission.md)). A drafted
  campaign row is therefore written `paused` — flipping it to `active` is the human's separate,
  explicit start act, so a bootstrap never grants dispatch permission. On an arc row the column
  is still for humans; nothing filters on it.

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

The `claude-md-section` block, fixed here so no clause defers to source. The first line is the
marker heading the collision guard and the read-back match on — which is what recognises a
hand-adapted section (repo tone, carve-outs) as the section it is, and leaves it alone. The
canonical text carries no repo-specific branches; adaptation stays with the adopting agent
(ADR [0334](../../../../.decisions/0334-bootstrap-merge-into-present-files.md)):

```markdown
## Work flows through fabrika

report → triage → plan → build → review → ship. Every unit of work is a GitHub issue moving
through those stages; the fabrika skills run them, and the `fabrika` CLI's verbs are the ground
truth at every step.

**The default unit of work is a lane, and the operator drives it.** To get an issue built,
reviewed and shipped, spawn ONE **operator** on it (`operate` skill) — it runs the builder,
reviewer and shipper shells itself, feeds every outcome back to the lane ledger, and parks to a
human only when a gate genuinely needs one. Do not hand-dispatch the per-stage shells for normal
work, and never route around them with an ad-hoc general-purpose subagent — an off-pipeline run
skips the gates.

| Work intent | Skill | Agent |
|---|---|---|
| Get one issue built → reviewed → shipped | `operate` | **operator** |
| Capture an observation / bug / idea | `report` | — |
| Classify + prioritize the backlog | `triage` | **triager** |
| Decompose a triaged epic into children | `plan-epic`, then `check-epic-plan` | — |
| Record a decision | `adr` | — |
| Record how the code is shaped | `write-pattern` | — |

The per-stage shells are surgical — resume a half-dead lane, re-run one gate, repair one PR —
never the normal entry point: `build` (**builder**), `review` (**reviewer**), `ship`
(**shipper**), and `heal-ci` for a PR that is green but going nowhere.
```

<a id="line-surface"></a>**A line surface appends; it never rewrites what is already in the file.**
A `.gitignore` carries rows from every tool in the tree, and a CLAUDE.md is the repo's own prose —
either way this verb is one contributor to a file it does not author, which makes the file's
existence the wrong collision guard. The guard is the marker — `gitignore-row`'s row,
`claude-md-section`'s heading: present anywhere in the text, this is `exists` at exit `0` and
nothing is written; absent, the block goes on the end and the pre-existing bytes are re-read intact.
Both halves are substring reads over the same marker, so a hand-added row — or a hand-adapted
section under the same heading — is recognised as the thing it is. A target
this verb cannot *read* is exit `11` — whether the marker is already there is UNKNOWN, and appending
blind would be the duplicate this guard exists to prevent.

<a id="json-key-merge"></a>**A json surface merges its declared keys into a present file; it never
touches keys it did not declare.** `.claude/settings.json` exists before fabrika is ever adopted, so
the file surfaces' absence guard cannot serve it (ADR
[0334](../../../../.decisions/0334-bootstrap-merge-into-present-files.md)). The `settings-patch`
keys, fixed here so no clause defers to source:

```json
{
	"extraKnownMarketplaces": {
		"kampus": {
			"source": { "source": "github", "repo": "kamp-us/phoenix" },
			"autoUpdate": true
		}
	},
	"enabledPlugins": { "fabrika@kampus": true }
}
```

Present, the file must parse as a JSON object: the two keys above merge in over it, following only
the paths the patch itself spells — an `enabledPlugins` already carrying other plugins keeps them —
and every key the patch does not name survives the re-serialize verbatim: a permissions block,
hooks, whatever else the repo carries.
Bytes that refuse to parse, or a top level that is not an object, are exit `11` naming the file and
the parse failure, and nothing is written. Absent, the two keys are written whole through the file
arm's write-and-read-back protocol. Already merged — the parsed object equals what merging would
produce, however its keys are ordered — is `exists` at exit `0`: a second run over an adopted repo
is byte-for-byte a no-op, because idempotency is absolute (ADR 0334).

**`dep-pin` resolves the version at run time; the registry's answer is the only pin it knows.** The
row it merges is `dependencies.@kampus/fabrika-cli`, at exactly what
`https://registry.npmjs.org/@kampus/fabrika-cli/latest` publishes when the verb runs — never a
constant in this table, which is what makes a re-run move a stale row forward instead of declaring
it already adopted. A registry that cannot be reached or answers without a version is exit `11` —
nothing pinned, nothing written; a guessed version is the one outcome this surface refuses. The
edit itself rides the same key-merge arm as `settings-patch`: unknown keys preserved verbatim,
unparseable bytes refused unwritten, absolute idempotency. And per the founder's ruling on #6995
(R1.3), no package manager ever spawns and no lockfile is read or written — the exact install
command (`pnpm add --save-exact @kampus/fabrika-cli@<version>`) is printed on the notice channel,
because the lockfile stays the caller's.

The `readout-artifact` body, fixed here so no clause defers to another skill's prose:

```markdown
The durable home for the landed-decision digest. `fabrika governance readout` upserts a comment
here; `fabrika status readout` displays it. This issue stays open and is not worked.
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| *(positional)* | string | yes | — | one `<surface-id>` from the registry above |
| `--path` | string | no | the registry default | override the target path for a file, line, json or dep-pin surface; must resolve inside the repository root |
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
the written bytes and [report the counts](#roadmap-grammar). For a [line
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
| `11` | a precondition read failed — the existence probe could not be performed, a present json target's bytes do not parse as a JSON object, or dep-pin's registry read failed (unreachable, non-200, or no version named); **nothing was written** |
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
| `status bootstrap: <target> does not parse as a JSON object: <reason> — nothing was written.` | 11 | refusal |
| `status bootstrap: <target> parses to <array|string|number|boolean|null>, not a JSON object — nothing was written.` | 11 | refusal |
| `status bootstrap: appending <marker> to <target> failed: <reason> — whether it landed is UNKNOWN. Re-read before retrying.` | 8 | refusal |
| `status bootstrap: appended <marker> to <target> and it could not be read back: <reason> — the outcome is UNKNOWN.` | 8 | refusal |
| `status bootstrap: appended <marker> to <target> and the read-back differs — the outcome is UNKNOWN.` | 9 | refusal |
| `status bootstrap: "<v>" is not a buildable surface. Known: design-manifest, roadmap-focus, gitignore-row, claude-md-section, label-taxonomy, issue-shape-markers, readout-artifact, settings-patch, dep-pin.
| `status bootstrap: created <target> for <surface-id>, read-back conformed.` | 0 | notice |
| `status bootstrap: created <target> for roadmap-focus, read-back conformed — <n> arc(s), <n> campaign(s).` | 0 | notice |
| `status bootstrap: appended <marker> to <target> for <surface-id>, read-back conformed.` | 0 | notice |
| `status bootstrap: merged the declared keys into <target> for settings-patch, read-back conformed.` | 0 | notice |
| `status bootstrap: cannot resolve @kampus/fabrika-cli's current release from npm: <reason> — nothing pinned, nothing written.` | 11 | refusal |
| `status bootstrap: the lockfile stays yours — install with: pnpm add --save-exact @kampus/fabrika-cli@<version>` | 0 | notice |

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
$ fabrika status bootstrap claude-md-section
bootstrap	created	claude-md-section	CLAUDE.md	ok
status bootstrap: appended ## Work flows through fabrika to CLAUDE.md for claude-md-section, read-back conformed.
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
$ fabrika status bootstrap settings-patch --json
{"outcome":"created","surfaceId":"settings-patch","target":".claude/settings.json","readback":"ok"}
status bootstrap: merged the declared keys into .claude/settings.json for settings-patch, read-back conformed.
$ echo $?
0
```

The file was already there carrying hooks and permissions of its own; the two keys merged in and
nothing else moved. A second run over it reads `{"outcome":"exists",…}` and writes nothing.

```
$ fabrika status bootstrap dep-pin
bootstrap	created	dep-pin	package.json	ok
status bootstrap: created package.json for dep-pin, read-back conformed.
status bootstrap: the lockfile stays yours — install with: pnpm add --save-exact @kampus/fabrika-cli@0.7.1
$ echo $?
0
```

The manifest was there carrying scripts and other dependencies of its own; the one row merged in at
the version npm publishes right now, and the install command is printed for the caller to run —
no package manager ever spawns and no lockfile moves. A re-run with the row already current reads
`{"outcome":"exists",…}`; a re-run over an older pin moves it forward.

```
$ fabrika status bootstrap merge-queue
status bootstrap: "merge-queue" is not a buildable surface. Known: design-manifest, roadmap-focus, gitignore-row, claude-md-section, label-taxonomy, issue-shape-markers, readout-artifact, settings-patch, dep-pin.
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
