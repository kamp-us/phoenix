# `/build-ui` — derived CLI contract

**Skill:** [`build-ui`](SKILL.md) · **Authoring brief:** [#4941](https://github.com/kamp-us/phoenix/issues/4941) · **Date:** 2026-08-09

The verbs land in `packages/fabrika-cli/` under the **`ui`** subcommand group, registered in
`packages/fabrika-cli/src/registry.ts` like the shipped `adr`, `report`, `triage`, `review` and
`wire` groups. The [CLI interface convention](../../docs/cli-interface-convention.md) governs
every verb; where this spec and that doc disagree, the doc wins and this spec is the bug.
**None of these verbs exist yet** — this spec is greenfield, like the sibling `build` group's
(#4988); nothing below assumes a shipped `ui` implementation.

**`fabrika` calls `pipeline-cli` nowhere, and neither does the skill** (ADR 0238). The v1 prior
art — the three UI branches in v1 `write-code`, `design-token-guard`, `design-inventory` — was
**read** for semantics and scars and none is invoked, wrapped, or deferred to.

**The capture-machinery boundary — no longer a judgment call.** The golden/capture machinery is
**fabrika's own**: it lives at `packages/fabrika-cli/src/capture/`, exported as the
`@kampus/fabrika-cli/capture` subpath, moved out of phoenix's `packages/design-capture` by founder
ruling (#5061 → #5063) so it ships on fabrika's release train instead of an adopter depending on a
phoenix package. So the `ui` verbs **import it**, the way they import fabrika's own `wire` modules
— not "may import a workspace package," and never a reimplementation of the same machinery a
second time.

What did **not** move is the repo-specific **data**: the blessed golden bytes (in depo) and the
pointer that names them, which stays per-repo at `packages/design-capture/golden-pointer.json`
(ADR 0183) with `design-goldens.json` at the root as the fallback — the probe order below is
unchanged by the move. Machinery is fabrika's; goldens are the consuming repo's.

The import does not soften a single verdict: every scar this spec designs out (the `never`-typed
upload channel, the silent `hostedUrls` projection, the fail-open pointer probe) binds **regardless
of whether the implementation imports or reimplements**, and now that the machinery is fabrika's
own, fixing one of those scars upstream is in scope rather than an external constraint. A verdict
this spec assigns to a failure may not be traded away for an upstream API's tolerance of it.

**Lane mechanics are the `build` group's, reused — never respecified:** `tree`, `pick`,
`eligible`, `claim`/`confirm`/`release`, `issue`, `branch`, `scratch`, `check`, `push`, `pr`,
`note`, `verdicts` are specified in [`../build/contract.md`](../build/contract.md) and this
skill invokes them as-is. Restating any of them here would be the second home a shared fact
drifts from. The `ui` group is only what the visual modality adds.

**What fabrika already ships, reused by import — never respecified:**

- `packages/fabrika-cli/src/verb.ts` — `answer`/`refuse`; non-zero exits print nothing on stdout.
- `packages/fabrika-cli/src/report/codes.ts` — the alignment base for seats `3`–`11`; new `ui`
  codes register in `packages/fabrika-cli/src/exit-code-alignment.ts`.
- `packages/fabrika-cli/src/report/leaks.ts` — `scanBody` / `isBareAtReference`; `ui evidence`'s
  posted markdown passes through them.
- `packages/fabrika-cli/src/report/compose.ts` — `normalizeForReadback` (read the body, the
  docblock understates it); `ui evidence`'s comment read-back compares through it.
- `packages/fabrika-cli/src/io/` — exec/fs/github seams.

**Considered and deliberately not derived** — each answer is already enforced at a gate, and a
second answer can contradict the gate (interface convention rule 6; ADR 0238):

- **A token-discipline verdict.** `design-token-guard.yml` runs on every PR: undefined
  `var(--…)` refs, raw hex outside the raw-scale layer, the per-file raw-px ratchet. The skill
  builds to pass it; no `ui` verb recomputes it. (Its two shipped scars — gate-fail vs IO-fail
  undistinguished, and a resettable `--write-baseline` ratchet — are that guard's to fix, not
  this group's to shadow.)
- **An inventory freshness check.** `design-inventory-guard.yml` reds a stale committed
  inventory. `ui manifest` reports the inventory file's *presence*; freshness is the gate's.
- **An a11y verdict.** `a11y-pbt.yml` owns the property-based floor (ADR 0162 pillar 4).
- **A rendered-surface PASS/FAIL.** That is `review-ui`'s gate (#4718). `ui render` + the
  skill's look predict it; they never emit a verdict token.
- **A diff→surface classifier.** v1's `classify-ui-surface.sh` fails open (`#4493`); `build`'s
  contract already declined a surface classifier for text. The skill names the surfaces it
  changed — `ui render` takes them as explicit `--surface` operands and refuses zero.
- **A golden blesser.** Blessing is the founder flow of ADR 0183 §5 through the built gallery
  machinery; `ui golden` only resolves and diffs, it never writes the pointer.
- **A visual-judgement verb — ruled out, not merely skipped** (founder ruling, brief amendment
  2026-08-09). The render loop's cut is: verbs do render, screenshot, and the dumb golden
  pixel-diff — nothing more; everything that *looks* (reading the image, judging it against the
  law, deciding the fix) is LLM-driven in the skill. A verb's ceiling is the golden diff. This
  applies identically to the optional Chrome path. No future `ui` verb may emit a composition
  score, a layout opinion, or any judgement token over pixels.

**The `paths`-glob auto-arm lever — considered, not used (this session's design call, recorded
per the brief).** Auto-arming on touched files would need a glob, and any glob is either
repo-specific (`apps/web/src/**` — dead on the portability ruling, this skill runs wherever a
manifest exists) or so broad (`**/*.tsx`, `**/*.css`) that it arms on non-rendered text work and
fights `/build` mid-lane. The routing that exists is already modality-shaped: `/build`'s §MOD
refusal names this skill on any rendered-visual deliverable, and the description carries the
trigger surface. UI volume at the ruling was 0/60 (#4898), so an auto-arm has no traffic to
catch and no way to be measured yet. Revisit when UI volume exists; the lever stays named on
#4891.

## Verb inventory

| Verb | Purpose | Split test |
|---|---|---|
| `ui manifest` | resolve the repo's design surfaces by convention: manifest, prohibition registry, component inventory — presence + paths | filename-convention probing and file reads — no judgment; *what to do about an absence* stays in the skill |
| `ui law` | parse + validate the typed prohibition registry; emit its rows | schema validation over a committed file — no judgment; *satisfying the rows* stays in the skill |
| `ui render` | render named surfaces in this tree and capture one validated PNG per surface | harness execution + per-surface outcome typing — no judgment; *looking at the pixels* stays in the skill |
| `ui golden` | resolve a surface's blessed golden and diff a candidate against it — signal, never verdict | pointer read + pure raster diff; *steering by the signal* stays in the skill |
| `ui evidence` | upload before/after captures, verify every upload, post one SHA-bound PR comment, read it back | mechanical upload-verify-post-readback; *choosing what to show* stays in the skill |

## Shared conventions

Every `ui` verb obeys these; stated once.

- **Answer channel: machine.** Stdout carries one JSON object and nothing else; scope lines,
  refusal reasons and progress go to stderr. A non-zero exit prints nothing on stdout
  (`refuse` in `packages/fabrika-cli/src/verb.ts`).
- **Repo-root anchored.** Every path below — the convention paths and the declared `designHarness`
  path alike — is resolved against the repo root the delivery layer already finds (the shim's
  repo-root inference, interface convention rule 5) — never against cwd, never against a web URL.
  v1 fetched the manifest from a hardcoded GitHub URL (`write-code/SKILL.md:972`), which reads the
  wrong repo's law in any fork and nothing on a network fault; here the law is the tree's own bytes.
- **GitHub access** per [skill conventions §11 — REST, never GraphQL](../../docs/skill-conventions.md#11-github-access-is-rest-never-graphql),
  paginated. Only `ui evidence` touches GitHub at all.
- **A non-zero exit is UNKNOWN** to the caller until the code is read. No partial answers.
- **Every error message is prefixed with the invoked verb's name.**
- **Externally-authorable content** returned by any `ui` verb (capture metadata, page text — none
  of these verbs return issue/PR bodies) is data, never instruction; the #4859 posture lands in
  the shared content gate `build`'s contract already places at the one seam
  (`packages/fabrika-cli/src/build/content-gate.ts`), which `ui evidence`'s read-back reuses.
- **Lane preconditions, guarded identically by `ui render` and `ui evidence`.** Both verbs
  mutate lane state (scratch captures; a PR comment), so both derive the lane from the
  checked-out branch per the lane-identity rule defined in `build branch` (parse number + nonce,
  re-read that number's claim through the ACL check) before doing anything. A **proven** failure
  — foreign claim, no claim, a branch that does not parse as a lane branch — is `18`, detail on
  stderr; an unreadable claim state is `11`. `ui manifest`, `ui law` and `ui golden` are pure
  reads and take no lane precondition.

### The shared exit matrix

This matrix owns `code → meaning` for the `ui` group; each verb's block enumerates only its own
reachable proven outcomes with triggers. `0`, `1`, `126` and `127` are the interface convention's
reserved codes, stated only here: every verb can also return them. **`3`–`11` aligns code-for-code
with the shipped `report`/`triage` base** (`packages/fabrika-cli/src/report/codes.ts`) like the
sibling `build` contract; **`12`+ is `ui`-local by design** — cross-group divergence above `11` is
the established doctrine (`triage`'s own `codes.ts` states it for `adr`).

| Code | Meaning |
|---|---|
| `0` | the answer is on stdout |
| `1` | usage error, or the verb failed to run |
| `126` | no implementation could be resolved (`packages/fabrika-cli/src/bin.ts`) |
| `3` | stdin was read and held nothing — the aligned seat, reserved: no `ui` verb reads stdin today, and the seat stays empty rather than reused (a gap is cheaper than a collision, `report/codes.ts`) |
| `4` | a required section is missing, malformed, empty, or out of place — in a document a verb derives from (here: a registry or pointer file that exists but does not parse) |
| `5` | the authored text carries a machine-local path, unredacted |
| `6` | the authored text is a bare `@` path reference — not redactable |
| `7` | zero scope: the target is **proven** absent or closed, or there is nothing to judge |
| `8` | a write was attempted and its outcome could not be proven — UNKNOWN |
| `9` | the write landed but the read-back does not match; the artifact needs a human |
| `10` | a value off its closed vocabulary or naming grammar (a non-kebab set name, a reserved `:state` surface) — a semantic refusal on a *value*, as in the sibling `build` matrix's `10`; a malformed *flag* stays `1` |
| `11` | a required read or execution failed — no outcome is proven. A deliberate, stated widening of the report seat (which covers precondition reads only): here it also seats a harness that never became ready and a capture whose validity could not be determined, because both leave the render UNKNOWN in exactly the way a failed read leaves a target UNKNOWN |
| `12` | proven: no design manifest exists at the repo's convention path — the repo is un-bootstrapped; the route is front-door (#4952) |
| `13` | proven: the manifest exists but no typed prohibition registry does — the law is untyped, prose is the fallback source |
| `14` | proven: a surface rendered with an uncaught page error — the render is red |
| `15` | proven: a surface is unreachable — the route resolved to nothing this tree can render (missing route, dark flag, gated tier); named per surface on stderr |
| `16` | proven: a capture was produced but is invalid — zero bytes, undecodable, or zero-area |
| `17` | proven: at least one evidence upload failed — nothing was posted |
| `18` | proven: the lane precondition failed — this session does not hold the claim the checked-out lane branch names (foreign, none, or an unparseable branch); detail on stderr |
| `19` | proven: no file at the declared `designHarness` path — the repo cannot be rendered headlessly |
| `127` | the verb never ran at all (unresolved binary — the shell's code) |

**`7` versus `11`** is the same split the whole CLI rests on: a proven absence is a verdict, a
failed read is a verdict about nothing. No `ui` verb fuses them, and no message reads "does not
exist, or is not readable". **`12` and `13` are deliberately not `7`**: an un-bootstrapped repo
and an untyped law are *routable* states the skill acts on by name, not generic zero-scope.

## Required environment — the two render paths

Declared here per the 2026-08-09 brief amendment (Chrome as a second render path) and the
portability ruling; #5049 is where required-environment declarations live as a corpus concern.

- **Default path (required): the headless harness.** `ui render` needs a local dev server for
  the tree and a headless browser. This path is what works in agent sessions and CI, and it is
  the **only** source of evidence captures — its validation (`16`) is what makes a PNG a record.
  **The browser dependency ships with the verb package** (founder preference, 2026-08-09:
  default-available beats install-a-thing): installing `@kampus/fabrika-cli` provisions the
  headless browser; no operator or agent ever runs a separate browser-install step by hand. A
  missing or broken browser provision at run time is `11` with the exact remediation command in
  the message — never a silent skip.
- **Interactive path (optional): the connected Chrome browser.** When the session's tool surface
  carries the `claude-in-chrome` tools, the *skill* may drive the live browser for the
  look-and-fix loop. **Detection is tool-surface presence, decided by the model at the seam it
  can see** — no verb probes for Chrome, no env var configures it, and no `ui` verb changes
  behavior based on it. Chrome absent means the default path, silently: a missing optional eye
  is never an error, never a deviation, never a terminal state.
- Chrome output never enters `ui evidence`: evidence pairs come from `ui render` capture sets
  only, so the attach path has one validated producer.

## The design-surface conventions

Stated once, consumed by `ui manifest` and `ui law`. These are **filename conventions, not
phoenix facts** — the portability ruling on #4941: this skill reads whatever repo it runs in,
and phoenix is one instance.

| Surface | Convention path (repo-root-relative) | Absent means |
|---|---|---|
| design manifest | `design-system-manifest.md` | the repo is un-bootstrapped for UI work — exit `12`, route to front-door (#4952) |
| prohibition registry | `design-prohibitions.json` | the law is untyped — exit `13` from `ui law`; manifest prose is the fallback source |
| component inventory | `design-system-inventory.md` | a fact: the repo ships no inventory; reported as `null`, never an error |
| golden pointer | `packages/design-capture/golden-pointer.json` where present, else `design-goldens.json` at root | a fact: no goldens; every surface is unblessed |
| render harness config | the **declared** `designHarness` path, whose shipped value here is `design-harness.json` | the repo cannot be rendered headlessly — exit `19` from `ui render`; reported as `null` by `ui manifest` |

The harness row is the one path a repo **declares** rather than inherits: `ui render`, `ui manifest`
and `ui evidence` resolve the `designHarness` key in `.fabrika.jsonc` and open whatever it names,
reaching `design-harness.json` only because that is the shipped value. The other four rows are
convention paths with no key behind them.

### The harness config schema — canonical here

The harness config is one JSON object telling the `ui` group how this repo renders and where
evidence lives — the portable replacement for v1's phoenix-hardcoded "alchemy dev" knowledge:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `command` | string | yes | the shell command that starts the repo's dev server, run from the repo root; `ui render` starts it, waits for readiness, and kills it on exit |
| `url` | string | yes | the base URL the server listens on (e.g. `http://127.0.0.1:5173`); surfaces resolve as `<url><route>` |
| `readyPath` | string | no (default `/`) | path polled for HTTP 200 to detect readiness; not ready within 60s is `11` |
| `viewport` | object `{width, height}` | no (default `{1280, 900}`) | the capture viewport in CSS px |
| `evidenceStore` | string | no | base URL of a content-addressed evidence store (the ADR 0144/0183 idiom); see `ui evidence` for the two-tier upload protocol |
| `storageState` | string | no | repo-root-relative path to a Playwright storage-state JSON, seeded into every capture context so surfaces behind a login render as a signed-in user; declared-but-absent is `11` from `ui render`, never a screenshot of the login page. The file is a credential — the repo gitignores it, and the cookies are never inlined here |

A file that exists but violates this schema is `4` from `ui render` — same whole-file rule as the
registry.

### The registry schema — canonical here

`design-prohibitions.json` is one JSON object: `{"rows": [ … ]}`. Each row carries **exactly**
the seven fields the #4891 ruling pins — the five typed fields plus the two transcribed ones:

| Field | Type | Meaning |
|---|---|---|
| `id` | string, kebab-case, unique in the file | the addressable name of the prohibition |
| `pillar` | string | the repo's own pillar/section name the row belongs to |
| `class` | `"blocking"` \| `"advisory"` | promotion is this one field's edit — that is the point of typing the law |
| `machineCheck` | `"verb"` \| `"vlm"` \| `"none"` | how the row is checkable |
| `source` | string | the manifest section or decision record the row transcribes — the *why* stays in prose, the registry carries the pointer |
| `statement` | string | the prohibition, one sentence |
| `counterexample` | string | one concrete violating instance |

The registry is **normative and founder-ratified** (the ADR 0194 firewall): no fabrika verb
writes it, ever — learn-back drafts *proposals* through report→triage, and ratification moves the
file by human hands. A registry that exists but violates this schema — missing field, duplicate
`id`, off-enum `class`/`machineCheck`, unknown extra field — is `4` from `ui law`, whole-file:
"some rows parsed" is never an answer, because a generator holding half the law believes it holds
the law.

---

## `ui manifest`

**Invocation**

```
fabrika ui manifest
```

**Inputs** — none. The repo root is the delivery layer's; four of the five paths are this
contract's convention table, and the harness path is whatever `designHarness` declares.

**Output** — machine. One JSON object:

```
{"manifest": "design-system-manifest.md",
 "registry": "design-prohibitions.json",
 "inventory": "design-system-inventory.md",
 "goldenPointer": "packages/design-capture/golden-pointer.json",
 "harness": "design-harness.json",
 "lawSource": "registry"}
```

Each key is the surface's repo-root-relative path, or `null` when that path holds no file —
`harness` is the path `designHarness` declares, and the `design-harness.json` above is phoenix's
shipped value, not a fixed name. `lawSource` is `"registry"` when the registry file exists,
`"manifest-prose"` when only the manifest does — the skill writes this token into its PR body
verbatim. `registry`, `inventory`, `goldenPointer` and `harness` report **presence only**; parsing
them is `ui law`'s, `ui golden`'s and `ui render`'s.
The manifest itself is the one surface whose absence refuses: without it there is no law at all.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `11` | the repo root could not be resolved, or one of the five paths' existence could not be determined (permission fault, unreadable dir) |
| `12` | proven: no file at the manifest convention path |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ui manifest: no design manifest at design-system-manifest.md — this repo is not set up for UI construction. Run /fabrika: front-door's bootstrap drafts one from the repo's own CSS and pages (#4952). Never improvise a design language.` | 12 | refusal |
| `ui manifest: cannot probe <path>: <reason> — presence is UNKNOWN, never "absent".` | 11 | refusal |

**Scope** — the same five paths against the repo root: four convention, one declared
(`designHarness`). Not a judging verb; presence is the supplied fact, and the one refusal (`12`)
exists because "no manifest" must route, not report.

**Examples**

```
$ fabrika ui manifest
{"manifest":"design-system-manifest.md","registry":null,"inventory":"design-system-inventory.md","goldenPointer":"packages/design-capture/golden-pointer.json","harness":"design-harness.json","lawSource":"manifest-prose"}
```

```
$ fabrika ui manifest
ui manifest: no design manifest at design-system-manifest.md — this repo is not set up for UI construction. Run /fabrika: front-door's bootstrap drafts one from the repo's own CSS and pages (#4952). Never improvise a design language.
$ echo $?
12
```

**Grounding**

- Founder design input on #4941 (2026-08-09): portability — the manifest is repo content read by
  convention; and the missing-manifest path routes to front-door's bootstrap, never a dead-end.
- v1 scar: the manifest arrived via hardcoded GitHub URL (`write-code/SKILL.md:972`) — wrong
  repo's law on a fork, silent nothing offline. Here: the tree's own bytes, or a loud `12`.
- `12` ≠ `7`: un-bootstrapped is a routable state with a named next step, not generic absence.
- #4952's detection verb may later subsume the presence probe; if it lands first, this verb
  aligns its vocabulary — flagged for both sessions, not raced.

---

## `ui law`

**Invocation**

```
fabrika ui law
```

**Inputs** — none.

**Output** — machine. One JSON object: `{"lawSource": "registry", "rows": [ … ]}` where `rows`
is the registry's rows verbatim, schema-validated, in file order. There is no empty answer: a
registry with zero rows is `4` (a law file that names no law is malformed, not minimal).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the registry exists but violates the schema — missing/extra field, duplicate `id`, off-enum value, zero rows, unparseable JSON |
| `11` | the registry's existence or content could not be read |
| `12` | proven: no manifest (as `ui manifest` — the law question does not arise) |
| `13` | proven: manifest present, no registry file — the law is untyped; consume the manifest's prose prohibitions directly |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ui law: design-prohibitions.json exists but does not satisfy the registry schema: <first violation> — refusing the whole file; half a law is not a law.` | 4 | refusal |
| `ui law: no design manifest at design-system-manifest.md — run /fabrika (#4952).` | 12 | refusal |
| `ui law: the law is untyped — no design-prohibitions.json beside the manifest. The manifest's prose prohibitions are the law; note LAW-SOURCE: manifest-prose in the PR.` | 13 | refusal |
| `ui law: cannot read design-prohibitions.json: <reason> — the law is UNKNOWN, never "untyped".` | 11 | refusal |

**Scope** — one file against one schema. Zero rows reds (`4`): a registry this repo committed
asserts a typed law; an empty one is a drafting defect to surface, not a fact to pass through
(ADR 0092's shape at document scale).

**Example**

```
$ fabrika ui law
{"lawSource":"registry","rows":[{"id":"faint-token-meaning","pillar":"color","class":"blocking","machineCheck":"vlm","source":"design-system-manifest.md#four-pillars","statement":"A meaning-carrying label never sits on a decorative faint token.","counterexample":"Timestamp-styled --text-faint on the error banner's message."}]}
```

**Grounding**

- Charter A on #4941 / the #4891 ruling: the five pinned fields plus `statement` and
  `counterexample`; class promotion as a one-field edit.
- ADR 0194 — the descriptive/normative firewall: this verb reads; ratification is human.
- `13` vs `4` vs `11`: untyped, mistyped, and unreadable are three different facts, and the
  skill's fallback is legal only in the first.

---

## `ui render`

**Invocation**

```
fabrika ui render --out before --surface /pano --surface /pano/yeni [--first-render <surface>]…
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--out` | string | yes | — | kebab-case capture-set name; captures land under the lane scratch dir (`build scratch`'s allocator) in `<set>/` |
| `--surface` | string, repeatable | yes (≥1) | — | a surface id: a bare route (`/pano`); zero surfaces is a usage error (`1`) — no tool guesses surfaces from a diff |
| `--first-render` | string, repeatable | no | — | a listed surface that has no pre-change state; recorded as `firstRender: true`, exempted from before/after pairing |

A surface id is a bare route in v1 of this grammar. A `:state` suffix is **reserved and refused
on `10`** — realizing a named state (a cookie, a fixture, a script) needs its own convention,
deferred until a consumer demands it; refusing now keeps the grammar extensible without two
implementations guessing differently.

**Output** — machine. One JSON object on full success only:

```
{"set": "before", "captures": [
  {"surface": "/pano", "path": "<abs>/before/pano.png", "width": 1280, "height": 2140,
   "sha256": "…", "firstRender": false}
]}
```

**The mechanism, in order.** Resolve the lane (shared conventions; the set dir is
`build scratch`'s allocation for this lane, `<scratch>/<set>/`). Read the declared `designHarness`
path (absent `19`, malformed `4`). Start `command` from the repo root; poll `<url><readyPath>` until
HTTP 200, up to the schema row's readiness bound (`11` on timeout, with the server's stderr tail
in the message); on any exit, kill the started process tree. For each `--surface`, in a headless browser at the
config's viewport: navigate to `<url><route>`; an HTTP status ≥ 400 or a failed navigation is
**unreachable** (`15`); an uncaught page exception during render is **crashed** (`14`);
otherwise screenshot the full page to `<set>/<route-slug>.png` (slug: `/` → `-`, leading
stripped, `/` root → `root`). Validate every capture: file exists, non-zero bytes, decodable
PNG, non-zero area (`16` on any failure). **Write the set manifest** `<set>/manifest.json` —
byte-identical to the stdout JSON — so `ui evidence` reads the set without re-deriving it; the
manifest is part of the answer, and a set without one is not a set.

Exit 0 requires **every** requested surface captured and valid — a partial capture set is one of
the proven refusals below, with every surface's individual outcome on stderr, so the skill drops
a surface only by re-invoking without it: the drop is the skill's explicit act, on the record,
never the tool's silent tolerance.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the harness config exists but violates its schema |
| `10` | `--out` is not kebab-case, or a `--surface` carries the reserved `:state` suffix |
| `11` | the harness did not become ready, a capture's validity could not be determined, or the claim state could not be read — the render is UNKNOWN |
| `14` | proven: at least one surface threw an uncaught page error during render |
| `15` | proven: at least one surface is unreachable — status ≥ 400 or failed navigation (no route, dark flag, gated tier); each named on stderr |
| `16` | proven: at least one capture was produced but is invalid (zero bytes, undecodable, zero area) |
| `18` | proven: the lane precondition failed (shared conventions) |
| `19` | proven: no file at the declared `designHarness` path |

When outcomes mix, the reported code is the smallest applicable of `14`/`15`/`16` and stderr
carries every surface's outcome — the code routes, the stderr enumerates.

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ui render: surface "<id>" threw during render: <first page error> — the render is red; fix it before looking.` | 14 | refusal |
| `ui render: surface "<id>" is unreachable in this tree (<reason: no route | flag dark | gated tier>) — fix reachability, or drop it explicitly and carry the reason into the PR's Deviations (#4305).` | 15 | refusal |
| `ui render: surface "<id>" captured invalid bytes (<detail>) — a capture nobody can open is not evidence (#3925's class).` | 16 | refusal |
| `ui render: the render harness could not start: <reason> — every surface is UNKNOWN.` | 11 | refusal |
| `ui render: the harness did not answer 200 on <readyPath> within the readiness bound — every surface is UNKNOWN; server stderr tail: <tail>.` | 11 | refusal |
| `ui render: cannot determine the validity of <set>/<file>: <reason> — the capture is UNKNOWN, never valid.` | 11 | refusal |
| `ui render: no <harness path> at the repo root — this repo declares no headless render path; add one (see the harness config schema).` | 19 | refusal |
| `ui render: <harness path> exists but does not satisfy its schema: <first violation>.` | 4 | refusal |
| `ui render: --surface "<id>" carries a :state suffix — states are a reserved grammar, not yet realized; render the bare route.` | 10 | refusal |
| `ui render: --out "<value>" is not a kebab-case set name.` | 10 | refusal |
| `ui render: this session does not hold the claim the checked-out branch names (<detail>) — the lane is not yours.` | 18 | refusal |

`<harness path>` is interpolated, not fixed: the verb prints the path `designHarness` declares, so a
repo that declares its own harness path reads that path back in both refusals.

**Scope** — exactly the `--surface` operands, no more: the verb never scans the diff. Zero
operands is `1`, so "rendered nothing, found nothing wrong" is unrepresentable (ADR 0092).

**Example**

```
$ fabrika ui render --out after --surface /pano
{"set":"after","captures":[{"surface":"/pano","path":"/tmp/fabrika-build/s-9f2e/4312-c1a4d6f8/after/pano.png","width":1280,"height":2140,"sha256":"9c41…","firstRender":false}]}
```

**Grounding**

- #4305 / #3232 — the silent-degradation class: a dark-flagged surface self-404'd on preview and
  the design review went render-blind without anyone saying so. `15` makes the state loud and
  puts the drop in the skill's hands.
- #2594 (via the v1 capture leg) — an uncaught page error is a red render, never a screenshot of
  a broken page judged as composition.
- v1 scar: `write-code` Step 4d specifies no capture-success check at all (`SKILL.md:1178` names
  the invocation, nothing checks it); here validity is part of the answer.
- The capture-set name feeds `ui evidence`'s pairing; `--first-render` exists so a new page's
  missing before is a recorded fact, not a fabricated baseline (v1's under-specified "pre-edit
  baseline", `SKILL.md:1531`).

---

## `ui golden`

**Invocation**

```
fabrika ui golden --surface /pano --candidate <path>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--surface` | string | yes | — | the surface id whose blessed golden to resolve |
| `--candidate` | string | no | — | a candidate PNG to diff against the golden; a relative path resolves against `FABRIKA_INVOCATION_DIR` (the delivery layer resets process cwd to the repo root — interface convention, Delivery), though the canonical input is the absolute `path` from a `ui render` answer; without it the verb only resolves |

**The pointer schema — canonical here.** The golden pointer file is one JSON object:
`{"store": "<base URL>", "surfaces": {"<surface-id>": {"sha256": "<hex>"}}}`. `store` is the
content-addressed byte store's base URL (phoenix's instance: depo, per ADR 0183); golden bytes
for a surface resolve as `GET <store>/<sha256>.png`, and the fetched bytes must hash to the
pointer's sha (a mismatch is `11` — the store is answering wrongly, trust nothing). Phoenix's
shipped pointer predates the `store` key while the corpus is empty (`{"surfaces": {}}`); the
implementation treats a pointer with surfaces but no `store` as malformed (`4`).

**The diff — defined here so two implementers compute one number.** Dimensions must match; a
dimension mismatch is reported as `{"magnitude": 1, "regions": [], "dimensionMismatch": true}` —
maximal signal, not an error; the `dimensionMismatch` key appears **only** in that shape, absent
from every matched-dimension diff. Otherwise: a pixel *differs* when the maximum absolute per-channel
delta (RGBA, 0–255) exceeds 10; `magnitude` is differing pixels ÷ total pixels, rounded to 3
decimals. `regions` is the bounding boxes of 8-connected components of differing pixels, boxes
closer than 16px merged, largest-area first, capped at 20 (the cap stated on stderr when hit).

**Output** — machine. One JSON object. Unblessed (the common case — the corpus is empty today):
`{"surface": "/pano", "blessed": false, "golden": null, "diff": null}` on exit 0 — **a missing
golden is a fact, not a failure**. Blessed without `--candidate`: `blessed: true` plus the
resolved golden. With `--candidate`: the diff object too — **a signal to steer by, never a
verdict**; no threshold lives in this verb and no PASS/FAIL token ever appears in its output.

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | the golden pointer file exists but does not parse |
| `11` | the pointer read, the golden bytes fetch, or the candidate read failed — blessing is UNKNOWN, never "unblessed" |
| `16` | proven: the candidate file is invalid (zero bytes, undecodable, zero area) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ui golden: the golden pointer exists but does not parse: <reason> — refusing; an unreadable pointer is not an empty blessed set.` | 4 | refusal |
| `ui golden: cannot resolve the golden for "<surface>": <reason> — blessing is UNKNOWN, never "unblessed".` | 11 | refusal |
| `ui golden: the candidate at <path> is invalid (<detail>).` | 16 | refusal |

**Scope** — one surface against the pointer convention path. The unblessed answer is legal only
after a successful pointer read: v1's blessed-surface probe resolved an **unreadable** pointer to
an empty set with `|| true` (`step4d-blessed-surfaces.sh:9-11`, tracked as #4501) — the exact
fail-open this verb's `4`/`11` rows exist to refuse.

**Examples**

```
$ fabrika ui golden --surface /pano
{"surface":"/pano","blessed":false,"golden":null,"diff":null}
```

```
$ fabrika ui golden --surface /pano
{"surface":"/pano","blessed":true,"golden":{"sha256":"9c41f2…","path":"/tmp/fabrika-ui-goldens/9c41f2….png"},"diff":null}
```

```
$ fabrika ui golden --surface /pano --candidate /tmp/fabrika-build/s-9f2e/4312-c1a4d6f8/after/pano.png
{"surface":"/pano","blessed":true,"golden":{"sha256":"9c41f2…","path":"/tmp/fabrika-ui-goldens/9c41f2….png"},"diff":{"magnitude":0.031,"regions":[{"x":120,"y":840,"w":420,"h":96}]}}
```

(The golden's `path` is the fetched bytes cached content-addressed under the OS temp root —
`<OS temp>/fabrika-ui-goldens/<sha256>.png` — derivable from the sha alone. The cache is
lane-independent by design: `ui golden` stays a pure read with no lane precondition, and a
content-addressed file is write-once, so concurrent lanes cannot clobber each other.)

**Grounding**

- ADR 0183 — bytes in depo content-addressed, pointer in git; this verb reads both, writes
  neither; blessing stays the founder gallery flow (ADR 0183 §5).
- #2945 / calibration B — diff magnitude is a steering signal; the verdict fork is `review-ui`'s.
- #4501 — the fail-open pointer probe, designed out.

---

## `ui evidence`

**Invocation**

```
fabrika ui evidence --pr 4318 --before before --after after
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request the evidence comment posts to |
| `--before` | string | no | — | the before capture-set name; omit only when **every** after-surface is `firstRender` |
| `--after` | string | yes | — | the after capture-set name |
| `--repo` | string | no | the `origin` remote's `owner/name` | the repository written to |

**Output** — machine.
`{"answer": "attached", "pr": 4318, "commentId": 512347, "head": "03135b91", "surfaces": 2}`.

The protocol, in order. **Read both capture sets through their manifests** —
`<set>/manifest.json`, written by `ui render`; a named set with no manifest, or a manifest that
does not parse, is `4` (a set without its manifest is not a set). Pair every after-capture with
its before by surface id (a `firstRender` surface pairs with nothing and is labeled *new
surface*; an after-surface with neither a before nor a `firstRender` mark is `4` — an
unexplained missing baseline is a hole in the evidence, not a layout choice). Re-validate every
paired PNG against its manifest sha (`16` on mismatch or invalidity). **Upload every PNG and
verify each upload individually, before anything posts** — the two-tier store:

1. **Store tier** — when the harness config declares `evidenceStore`: `PUT` each PNG
   content-addressed (`<store>/<sha256>.png`, the golden-store idiom of ADR 0183), then `GET`
   the same URL back and hash-compare. Any failed PUT, GET, or hash mismatch is `17`. (The
   tier choice reads the harness config here too: an absent file selects the attachment
   tier — no harness config is a fact, not an error, at evidence time; a file that exists but
   violates its schema is `4`, same whole-file rule as in `ui render`.)
2. **Attachment tier** — no `evidenceStore` declared: upload each PNG through GitHub's
   user-attachment endpoint, then probe every returned URL (`HEAD`, expect 200). Any failed
   upload or probe is `17`. Two facts about this tier stated rather than hidden: the endpoint
   is **undocumented** (the ADR 0165 durability caveat rides along — hosted copies are
   display-grade, the set manifest in the lane scratch is the durable record), and it is an
   upload API, not an issues read/write, so it sits **outside** skill-conventions §11's
   REST-porcelain scope while every issue/PR read and write in this verb stays inside it.

Any failure in either tier is `17`, aggregated, **nothing posted** — evidence is all-or-nothing:
a comment showing three of five surfaces reads as "this is what changed" and lies by omission.
Then compose one markdown comment — per surface, before|after side by side (or *new surface*),
**bound to the PR's current head SHA in the comment text**; scan it with the imported leak
predicates (`5`/`6`); post it; re-read it through `normalizeForReadback` (`9` on mismatch). A
re-run after a fix posts a **new** comment at the new head — comments are append-only evidence,
never edited in place.

Preconditions: the lane precondition of the shared conventions (`18`/`11`) — the claim is the
one **the checked-out branch names** (the issue number in first-ship mode, the PR number in
resume mode), never "a claim on `--pr`". Additionally the verb resolves `--pr`'s current head
branch and refuses on `18` when the lane branch does not publish there — an evidence comment on
another lane's PR is a cross-lane write. **Where the lane publishes is its branch's tracked
upstream, else `origin/<branch>`** — the same resolution `build push` performs, so a repair round's
`build/pr-<pr>-<nonce>` branch, whose local name is never the PR's head ref, passes on its upstream
rather than refusing every time (#7402). PR open (`7`).

**Exit status** (beyond the universal four)

| Code | Trigger |
|---|---|
| `4` | an after-surface has no before and no `firstRender` mark, a named capture set is missing/empty, a set's `manifest.json` is absent or unparseable, or the harness config exists but violates its schema |
| `5` | the composed comment carries a machine-local path |
| `6` | the composed comment is a bare `@` path reference — not redactable |
| `7` | the PR is proven absent, closed, or merged |
| `8` | the comment post failed — it may or may not have landed; re-read the PR before re-running |
| `9` | the comment landed but does not read back as sent |
| `11` | a precondition read failed (claim, PR head, capture set) — nothing was uploaded or posted |
| `16` | proven: a capture in a named set is invalid or does not match its manifest sha — evidence nobody can open is not evidence |
| `17` | proven: at least one upload or upload-verification failed — **nothing was posted**; every failed surface named on stderr |
| `18` | proven: the lane precondition failed (shared conventions) |

**Errors**

| Message (stderr) | Code | Kind |
|---|---|---|
| `ui evidence: after-surface "<id>" has no before capture and no firstRender mark — an unexplained missing baseline is a hole in the evidence.` | 4 | refusal |
| `ui evidence: upload failed for <n> of <m> captures (<first surface>: <reason>) — refusing to post partial evidence; a gallery missing its failures is #3925.` | 17 | refusal |
| `ui evidence: the composed comment is a bare @ path reference — write the evidence, not a pointer to it.` | 6 | refusal |
| `ui evidence: set "<set>" has no manifest.json — a set without its manifest is not a set; re-run ui render.` | 4 | refusal |
| `ui evidence: this session does not hold the claim on #<n> (<detail>) — the lane is not yours.` | 18 | refusal |
| `ui evidence: the composed comment carries a machine-local path: <first hit>.` | 5 | refusal |
| `ui evidence: PR #<n> is proven absent, closed, or merged.` | 7 | refusal |
| `ui evidence: the post failed: <reason> — it may or may not have landed; re-read the PR before re-running.` | 8 | refusal |
| `ui evidence: the comment landed but does not read back as sent — it needs a human eye.` | 9 | refusal |
| `ui evidence: cannot read <what>: <reason> — nothing was uploaded or posted.` | 11 | refusal |
| `ui evidence: capture "<id>" in set "<set>" is invalid (<detail>).` | 16 | refusal |

**Scope** — the named capture sets, one PR, one comment. All-or-nothing by construction.

**Example**

```
$ fabrika ui evidence --pr 4318 --before before --after after
{"answer":"attached","pr":4318,"commentId":512347,"head":"03135b91","surfaces":2}
```

**Grounding**

- #3925 — months of 100%-failed uploads behind a passing gate. The upstream upload channel is
  typed `never` and silently projects failures away (`packages/fabrika-cli/src/capture/upload.ts:9-13`,
  `orchestrate.ts:104-105`); ADR 0165 accepted that for the *review* side's verdict. This verb is
  the *construction* side's attach, and here a failed upload is `17`, aggregated, fail-closed —
  the one behavior this contract most exists to pin.
- #4808's class — evidence at a stale head misleads; the head SHA is in the comment text and a
  repair re-attach posts fresh at the new head.
- v1 scar: `write-code`'s Step 5 attach names no success check (`SKILL.md:1527-1538`); here the
  read-back is the answer.

---

## Completeness self-test

Per the [interface convention](../../docs/cli-interface-convention.md) Part 2: every flag
carries a type and default; every stdout shape has a literal example; every non-zero code is
enumerated with its trigger (per-verb tables own the group-local rows; the universal
`0/1/126/127` live once in the shared matrix, which owns every code's single meaning); every error
names message, stream, and code; every judging verb states scope and zero-scope behavior; and no
clause defers to a v1 script, another skill's prose, or the authoring session — the `build`
group reuse is a reference to a *sibling fabrika contract*, the sanctioned shape the `build`
contract itself uses for the shipped wire modules. The three hand-checks: every reachable
outcome was walked per verb (mixed render outcomes route by smallest code with full enumeration
on stderr); every example value derives from stated rules (the scratch-dir path from `build
scratch`'s allocator, `lawSource` from the presence table); sibling verbs guard shared
preconditions identically (`render` and `evidence` guard the lane on the same `18`/`11` and
validate captures with the same `16`; `manifest`, `law` and `render` read the same convention
table; `evidence` runs the same posting guards as the `build` writing verbs, on the same
seats — "the same posting guards" means the posting seats `5`/`6`/`8`/`9`; the claim guard is
deliberately `ui`-local `18` where `build` uses `15`). The render→evidence seam persists through
`<set>/manifest.json`, so no value crosses it by memory.
