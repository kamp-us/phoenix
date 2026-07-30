# The gate-verdict contract — one spec, four gate namespaces

The single source for **how a review gate lands its verdict on a PR**: the SHA-bound marker
shape, the upsert key, the matcher every consumer scans with, the forbidden emit forms, the
control-plane advisory form, and the post-write read-back that proves the marker landed clean.

**Who reads it.** The four PR gates — `review-code`, `review-doc`, `review-skill`,
`review-design` — emit against it; `ship-it` scans it to decide a merge; `write-code`'s repair
round-trip scans it to find a FAIL. Each **cites** this file; none re-derives it.

Extracted from [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), where the same
spec lived as four near-identical per-gate sections that drifted against each other (#4438). It
lives under `claude-plugins/kampus-pipeline/skills/`, so it is control-plane in whole under the
existing whole-tree `CONTROL_PLANE_RE` branch — the same gating the gate skills themselves carry,
with no boundary amendment.

## Retired section numbers — the mapping

The per-gate sections were numbered against the formats contract's sequence, which is exactly
what made them positional rather than nameable. Here they carry mnemonic tokens, matching that
contract's own convention for factored, cross-cited sections (§CP, §DOC, §CLASS, §ZS, §SP, …).
A record citing an old number resolves through this table:

| Retired | Now |
|---|---|
| §5 — review-code pass marker | §VERDICT |
| §6 — review-doc verdict marker | §VERDICT |
| §6.5 — review-skill verdict marker | §VERDICT |
| §6.7 — review-design verdict marker | §VERDICT |
| §6.6 — the canonical advisory line | §ADVISORY |
| the verdict read-back guard / unconditional read-back / mandatory guarded emit | §READBACK |

---

## VERDICT. The verdict marker — one contract, four namespaces

A gate lands its verdict as a **comment whose first line is a recognizable, SHA-bound marker**.
That marker is a downstream contract: `ship-it` scans for the PASS marker to find verified,
merge-ready PRs unambiguously, and `write-code`'s fix round-trip scans for the FAIL marker to
find a PR that came back failed.

Everything below holds for **all four gates**. The two tables carry the only values that differ.

### The per-gate namespace table — the values that differ

| Gate | Marker namespace | PASS first line | FAIL first line | Verdict carrier |
|---|---|---|---|---|
| `review-code` | `review-code` | `review-code: PASS @ <sha> — merge-ready` | `review-code: FAIL @ <sha> — not merge-ready` | the comment **or** a native `APPROVE` |
| `review-doc` | `review-doc` | `review-doc: PASS @ <sha> — merge-ready` | `review-doc: FAIL @ <sha> — changes-requested` | the comment only |
| `review-skill` | `review-skill` | `review-skill: PASS @ <sha> — merge-ready` | `review-skill: FAIL @ <sha> — changes-requested` | the comment only |
| `review-design` | `review-design` | `review-design: PASS @ <sha> — merge-ready` | `review-design: FAIL @ <sha> — changes-requested` | the comment only |

| Gate | Surface it gates | What the verdict body carries below the marker |
|---|---|---|
| `review-code` | the code class | the per-criterion evidence table |
| `review-doc` | the **§DOC doc class** — `.decisions/**`, `.patterns/**`, `docs/**`, or a root/top-level prose `*.md`; explicitly **not** a code-root `*.md` under `apps/**`/`packages/**`, which rides `review-code` | the per-criterion **+ per-hygiene-check** evidence table |
| `review-skill` | a **skill PR** (`skills/**`, superseding ADR 0063's `skills/**` → `review-code` routing), against the ACs *plus* a rigor checklist — behavioral correctness, trigger/`description` quality, cross-skill conflict/shadowing, gate-invariant preservation (ADR [0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §1) | the per-criterion **+ per-rigor-check** evidence table |
| `review-design` | a **UI-affecting PR**, judged by driving Playwright over the PR's preview deploy, capturing the changed surfaces, and judging the rendered screenshots multimodally against the **four-pillars design law** (ADR [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md); the gate is ADR [0165](https://github.com/kamp-us/phoenix/blob/main/.decisions/0165-review-design-gate.md), skill landed via #2246). It hard-FAILs **only** on the six enumerable, objective ADR-0162 prohibitions; all holistic/taste judgment rides as advisory (non-blocking) notes in the same comment | the per-prohibition table (the six hard-FAIL checks, passing rows too), an **Advisory (non-blocking)** section, and an **Evidence** section embedding the GitHub-hosted screenshot URLs so a human can see what was judged |

### Shape — SHA-bound (ADR 0058)

The recognizable **first line** of the PR comment carries the **head SHA the reviewer inspected**
(`@ <sha>`), resolved at post time from `gh api repos/$REPO/pulls/$PR --jq .head.sha`. `<sha>` is
the full or abbreviated (≥7 hex) head SHA. What's load-bearing for the scanner is only that first
line — the namespace, the polarity, **and the `@ <sha>`**; the body below it is for the human and
the implementer.

The `@ <sha>` is **load-bearing, not decoration**: `ship-it` and `write-code`-repair refuse a
verdict whose `@ <sha>` does not match the PR's *current* head, and refuse a SHA-less marker
outright — this is what closes the stale-PASS-masks-a-FAIL and head-moved-under-the-verdict races
(ADR [0058](https://github.com/kamp-us/phoenix/blob/main/.decisions/0058-sha-bound-verdict-contract.md), issue #258). A marker with no
`@ <sha>` is a *pre-0058 legacy* shape and resolves to `unverified`, not PASS.

### Upsert, not append — the record is keyed on (PR, gate-namespace, head, run) (ADR 0058, refined by ADR 0213)

A verdict record is identified by **four** dimensions: the PR, the gate namespace, the **head**
it is bound to, and the **run** that posted it. That upsert is **`pipeline-cli verdict post`'s own
behavior, not something a reviewer hand-rolls**: the verb scans the PR for a prior marker in its
namespace matching *this head and this run's `<!-- verdict-run: … -->` trailer* and, if one
exists, replaces that comment in place with the fresh verdict; anything else it **appends**.

So the key, not a "one comment per PR" rule, decides what happens:

- **Same key** (same head, same run) → a genuine correction **upserts in place**, so no slot
  accumulates a stale verdict stream a millisecond decides. See ADR 0058 rule 2.
- **New head** → a fresh record is appended and the prior head's verdict is left standing; that is
  what the `head` dimension buys (#4007, ADR
  [0213](https://github.com/kamp-us/phoenix/blob/main/.decisions/0213-verdict-upsert-keyed-on-run-not-shared-author.md)).
- **Different run** → a distinct record, appended. Every draining agent authenticates as one shared
  GitHub login, so without the run dimension two concurrent reviewers each matched the *other's*
  comment and PATCHed its body away — a server-side loss of a merge-gate artifact (ADR 0213).

Consequently **a PR thread may legitimately carry more than one verdict comment in one namespace,
including at one head** — that is the intended state, not a defect to reconcile, and no rule here
may be written as if a namespace held exactly one comment per PR. Resolution among them is the
reader's job, not the poster's: the ADR-0055 author-gate first, then latest-verdict-wins per
namespace by timestamp, then the SHA-staleness test.

**Do not translate this into a raw `gh api` comment `PATCH`.** A hand-rolled patch of a verdict
body is a marker hand-post — it skips `emissionDefect` and the post-write `verifyLanded` re-scan,
which is exactly the emit-side bypass [The guarded emit path is
MANDATORY](#the-guarded-emit-path-is-mandatory--never-hand-post-a-verdict-marker-off-the-guard)
forbids (#2789 / #2816 / #2818). If a raw post is genuinely unavoidable, take that section's one
escape hatch — `pipeline-cli leak-guard scan-comment` on the body **first**.

### Carrier — comment-only, and the one gate that keeps a native `APPROVE`

`review-doc`, `review-skill` and `review-design` emit their verdict **only** as the SHA-bound
`<namespace>:` comment, **never** a native `APPROVE`/`REQUEST_CHANGES` review (ADR 0058 rule 4).
This resolves the duality #258 flagged: a native GitHub review cannot carry the `@ <sha>` in the
comment shape this contract controls (it records `commit_id` in a *different* record type), so
leaving a gate free to post either would force `ship-it` to compare a review against a comment for
that lane — two incomparable records. One carrier per lane keeps the lane resolvable.

`review-code` is the exception and keeps its native-`APPROVE` path, because `ship-it` reads that
review's `commit_id` — which **is** the SHA the reviewer approved — and applies the same staleness
test to it. The `review-code` comment marker is the fallback that carries the same meaning (with
the `@ <sha>` doing explicitly what `commit_id` does for a native review) where a formal review
can't be posted, e.g. when org branch rules forbid reviewing your own PR.

### The matcher contract — emphasis-tolerant, SHA-capturing, anchored, never cross-matching

The marker line may carry **leading Markdown emphasis** — `review-code` historically emitted it
bolded (`**review-code: PASS @ <sha> — merge-ready**`), `review-doc` emits it bare. To stop the
emitter and the matcher from drifting apart (the bolded marker once read as "no verdict" and
stalled every code-lane merge — #219), this contract pins **one** rule both sides cite:

- **Canonical emit shape** (what an emitter SHOULD write): the bare, unbolded first line —
  `<namespace>: PASS @ <sha> — merge-ready`. New/converging emitters write this.
- **Token order is fixed** (the single source every emitter cites): the `@ <sha>` comes
  **immediately after** the `PASS`/`FAIL` polarity and **before** the `— merge-ready` /
  `— not merge-ready` / `— changes-requested` tail — `review-code: PASS @ <sha> — merge-ready`,
  never `review-code: PASS — merge-ready @ <sha>`. The matcher below is **anchored to this
  order**: it captures the SHA only when `@ <sha>` directly follows the polarity, so a marker that
  pushes `@ <sha>` *past* the tail captures `sha=null` → the consumer resolves it `unverified` and
  refuses a correct, current-head PASS (the token-order drift that silently stalled #623's
  merge — #625). The fix is to **emit the canonical order**, not to loosen the matcher to chase a
  trailing SHA (ADR 0058 forbids weakening the SHA-binding).
- **Matcher obligation** (what every scanner MUST accept): an **optional leading `**`** before the
  namespace token, so a bolded marker resolves identically to a bare one, **and a captured
  `@ <sha>`** so the consumer can apply the staleness test. The four anchored, case-insensitive
  matchers are:

  - code:   `^\s*\**\s*review-code:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
  - doc:    `^\s*\**\s*review-doc:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
  - skill:  `^\s*\**\s*review-skill:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`
  - design: `^\s*\**\s*review-design:\s*(PASS|FAIL)\s*@\s*([0-9a-f]{7,40})`

  The leading `\**` absorbs the emphasis; `^\s*` still pins the marker to the start of the body so
  a mid-body *quote* never matches; the trailing `@\s*([0-9a-f]{7,40})` captures the bound head
  SHA. A SHA-less marker that matches only the looser
  `^\s*\**\s*<namespace>:\s*(PASS|FAIL)` prefix but **not** the `@ <sha>` tail is a legacy
  verdict → the consumer treats it as `unverified` (ADR 0058 rule 3).
- **The four namespaces are disjoint by construction.** Each matcher names its own literal token,
  and because the tokens end in four different words (`code:` / `doc:` / `skill:` / `design:`) no
  anchored literal can prefix-match another. A scan in one namespace can **never** cross-match
  another, and a gate **never** emits another gate's marker.
- **Every matcher site cites this one rule** — `ship-it`'s merge gate, `write-code`'s fix
  round-trip, and each gate's own upsert — so they can't diverge again.

### Forbidden emit forms

The matcher above is anchored, so an emitter that freelances any of the shapes below produces a
verdict **no consumer can read** — `ship-it` resolves the PR to `unverified` and silently refuses
to merge a genuine, current-head PASS (the #1095 stall: a real PASS posted as
`<!-- review-code: PASS sha:… -->` sat unmerged). The emit contract is the mirror of the matcher —
emit the canonical first line and **none** of these:

- **HTML-comment-wrapped** — `<!-- review-code: PASS @ <sha> — merge-ready -->`. The `<!--` is
  non-whitespace ahead of the namespace token, so it fails the `^\s*\**\s*` anchor (the `\**`
  absorbs only Markdown emphasis, never `<!--`). The marker must be **live body text**, not an
  HTML comment — the verdict-marker contract has no HTML-comment form (the only sanctioned HTML
  comments here are the unrelated AC-append provenance tag and the upsert's `verdict-run` trailer).
- **`sha:` (or any non-`@`) SHA delimiter** — `review-code: PASS sha:<sha>`. The matcher captures
  the bound SHA only from the literal `@ <sha>` tail; `sha:<sha>` matches only the looser SHA-less
  prefix → `unverified`. The delimiter is `@`, never `sha:`/`SHA=`/`commit:`.
- **Heading-only / prose-only verdict** — `## review-code verdict: PASS` with no marker line. A
  heading is not the contract: it carries no `@ <sha>` and isn't anchored at the namespace token.
  The recognizable first line is required *in addition to* any human-facing heading.
- **Marker not on the literal first line** — the `^` anchor pins the marker to the **start of the
  comment body**; a marker buried after a preamble paragraph never matches. It leads the body.
- **Two namespace markers stacked in one comment (the multi-namespace fan)** — on a mixed-class
  diff the reviewer fans several verdict namespaces (e.g. `review-code` + `review-skill` for a
  skill+code PR, `review-design` for a UI PR). Each namespace's `^` anchor pins its marker to the
  first line of **its own comment**, so stacking a second namespace's marker on line 2 of the
  first's comment leaves that second marker un-anchored: it never matches, its namespace resolves
  **empty**, and `ship-it` fail-closes a substantively-PASS PR (the live PR #2456 stall — both
  reviews PASSed, but the stacked `review-skill` marker was unmatchable and recovery needed a
  manual re-emit). **Emit each fanned namespace's verdict as its OWN separate PR comment, its
  `<namespace>: PASS|FAIL @ <sha>` marker on that comment's literal first line — one comment per
  namespace, never two markers stacked.** The upsert key is unchanged; the fan writes N such
  comments (one per namespace), not one comment carrying N markers.

These are emitter bugs, not matcher gaps — the fix is always to **emit the canonical shape**,
never to loosen the anchored matcher to chase a malformed marker (ADR 0058 forbids weakening the
SHA-binding).

### Field notes

- **First line, recognizable.** The marker leads the comment so a scan can match it without
  parsing the whole body. Recognize it tolerantly by shape (`<namespace>: PASS @ <sha>` …
  `merge-ready`) and emphasis (optional leading `**`, per the matcher contract above), not by
  exact dashes or spacing — but the `@ <sha>` is required.
- **Two markers, two consumers.** `PASS @ <sha> — merge-ready` (every criterion the gate owns
  verified, bound to that head) is read by `ship-it` as the go-ahead to merge a **non-blocking**
  PR **iff `<sha>` is the current head**. The FAIL marker (≥1 criterion unmet) is read by
  `write-code`'s fix round-trip as "my PR came back failed"; `ship-it` reads it as "do not merge."
  Each marker has exactly one merge-relevant meaning.
- **Signals, never merges.** The PASS marker is an approval signal `ship-it` acts on. A gate
  writing it does **not** merge; merging is `ship-it`'s deliberate act (see each gate's
  §"Authority limit" and ADR
  [0048](https://github.com/kamp-us/phoenix/blob/main/.decisions/0048-ship-it-merge-actor.md)).
- **`review-design`'s required-gate wiring has landed** as part of the ADR-0165 rollout: `ship-it`
  runs the `UI_RE` probe and refuses a `has-ui` PR with an empty `review-design` namespace, and
  §CLASS's `pipeline-cli class-probe classify` folds the additive gate in.
- **Every `review-design` verdict body carries the canonical `Reviewed-head: @ <sha>` line**
  (§ADVISORY / ADR 0151) on *every* path, not only the advisory one — the read-back guard asserts
  it, and a delegated §CP merge actor (and `ship-it`'s ADR-0135 approval-aware enqueue) resolves
  the reviewed head from **exactly that line**, never from the first-line marker.

---

## ADVISORY. The canonical advisory line — one form for all four gates

The gates once expressed "advisory" two ways: `review-code` emitted a binding
`PASS @ <sha> — merge-ready` line *plus* a control-plane caveat, while `review-doc`
suppressed the binding PASS and led with a **no-`@ <sha>`** advisory line. ADR
[0073](https://github.com/kamp-us/phoenix/blob/main/.decisions/0073-review-skill-gate.md) §5 picks
`review-doc`'s form as the **single canonical advisory shape** and converges all the gates on
it; the later `review-design` gate (ADR 0165) adopts the same form from birth.

For a PR in the **control-plane / blocking set** (§CP), the gate emits a comment whose first
line is the **no-`@ <sha>`** advisory marker in its own namespace:

```markdown
review-code:   advisory — blocking-set PR (§CP — approval-gated)
review-doc:    advisory — blocking-set PR (§CP — approval-gated)
review-skill:  advisory — blocking-set PR (§CP — approval-gated)
review-design: advisory — blocking-set PR (§CP — approval-gated)
```

Every gate takes this arm on a §CP PR, and it is the **common case for a skill PR** (every gate
skill is gate-critical, so most skill PRs that touch a gate land here).

**The advisory is a PASS path only.** A gate that finds a failing criterion on a §CP PR emits its
**FAIL** marker instead, which routes the PR into the author's repair round — an advisory whose
body carries a `[FAIL]` criterion is a state nothing downstream can act on (ADR
[0226](https://github.com/kamp-us/phoenix/blob/main/.decisions/0226-cp-advisory-never-carries-a-failing-criterion.md)).

The rest of the body carries the same per-check evidence table the PASS/FAIL paths carry — the
verdict is *recorded* (for the human or delegated merge actor to read), it just **authorizes
nothing on its first line**. The advisory **first line** **carries no `@ <sha>`** on purpose: it
does not enter any `ship-it` `PASS @ <sha> — merge-ready` namespace, so a §CP PR is never
auto-mergeable off it (ADR 0053). Under ADR 0135's approve-then-enqueue, `ship-it` enqueues it once a
`@kamp-us/control-plane` approval is present at head (ADR 0053/0065/0135) — that approval, not a gate
verdict, is what authorizes the merge.

**The advisory body MUST carry the canonical `Reviewed-head` line (ADR 0151).** Immediately after
the advisory's first-line marker + framing prose, the body carries **exactly one** line recording
the reviewed head SHA in a fixed, machine-parseable form:

```markdown
Reviewed-head: @ <HEAD_SHA>
```

This is the single canonical binding for a §CP advisory — it replaces the free-prose "reviewed head"
phrasings (which spelled the SHA half a dozen incompatible ways and made the §CP enqueue
nondeterministic; #1932/#2022). It is a **body** line with a **distinct `Reviewed-head:` token**, so
it is never matched by the first-line `<namespace>: PASS @ <sha>` PASS-namespace matcher —
the advisory stays out of `ship-it`'s auto-merge namespace exactly as ADR 0111 requires. Both a human
delegated merge actor and `ship-it`'s ADR-0135 approval-aware §CP enqueue read the reviewed head from
**this** line, via the anchored matcher (case-insensitive, optional `@`, 7–40 hex, ADR 0058
prefix-match either side):

```
^\s*Reviewed-head:\s*@?\s*([0-9a-f]{7,40})\b
```

`ship-it` treats the §CP advisory namespace as an enqueue-eligible current-head PASS-equivalent iff
(a) this `Reviewed-head` SHA prefix-matches the PR's current head, (b) every body checkbox is
`[PASS]`, and (c) Step 0's control-plane approval is present at head — else it refuses
deterministically (ship-it Step 2.§CP, ADR 0151). The reviewer is **never** asked to emit a bindable
first-line PASS on a §CP PR to unblock enqueue (ADR 0111's advisory-is-SHA-less-in-first-line
invariant is preserved; the reviewer marker contract is not widened).

This is why the advisory form is namespace-uniform but binding-free: it keeps each gate's
verdict **out** of `ship-it`'s merge path for the control plane while still leaving a
visible, evidence-bearing verdict on the PR. (`review-code`'s historical binding-PASS +
caveat shape was retired in favor of this; the reconciliation landed with #424.)

**The first-line `@ <sha>` is omitted by design — the SHA is bound in the body's canonical
`Reviewed-head` line, and both a delegated merge actor AND `ship-it`'s §CP enqueue confirm from
that body line, not the first-line marker (ADR 0111/0151).** The advisory line deliberately
withholds the first-line `@ <sha>` so it never enters `ship-it`'s `PASS @ <sha> — merge-ready`
namespace — that withholding is exactly what makes `ship-it` refuse to *auto-merge* the §CP PR off a
first-line PASS (ADR 0053). It is **not** a missing binding: the head SHA the reviewer inspected is
recorded in the verdict **body** on the canonical `Reviewed-head: @ <sha>` line + the per-AC PASS
table, per ADR 0058. So a **delegated** control-plane merge actor — an operator hand-merging a banked
§CP PR, or `ship-it`'s ADR-0135 approval-aware enqueue acting on the maintainer's current-head
APPROVE — must **not** try to bind the first-line marker (it will read as `unverified`, the
SHA-less-by-design form #977 hit). It confirms the verdict by **reading the body**: the
`Reviewed-head` `@ <sha>` against the PR's current head + every AC marked PASS, then applies
`ship-it`'s just-in-time guards (head freshness, mergeable, no failing required check) and
merges/enqueues. A namespace-isolated bindable *first-line* SHA was rejected (it would invite
automated §CP auto-merge and erode ADR 0053) — ADR 0151 instead makes the *body*'s binding canonical
and machine-read, keeping ADR 0111 intact. See
[ADR 0111](https://github.com/kamp-us/phoenix/blob/main/.decisions/0111-blocking-set-verdicts-sha-less-by-design.md)
and [ADR 0151](https://github.com/kamp-us/phoenix/blob/main/.decisions/0151-cp-advisory-body-sha-resolves-approval-aware-enqueue.md).

Because a design verdict is calibrated to FAIL conservatively (a borderline call is downgraded to
advisory), a `review-design` advisory can *also* mean "no objective prohibition hard-failed" — but
on a §CP PR the first-line advisory is always the approval-gated shape above.

---

## READBACK. Proving the marker landed clean

The three rules below govern the *emit path* and the *post-write read-back* that together make a
verdict marker's landing verifiable rather than assumed. They are cited, never re-derived, by each
gate's Step-5-family verdict step.

They moved here **byte-identically** — bytes verified against the pre-move span, not re-read — so
three of their references still carry their pre-move spellings. Read them as:

- *"the by-value form above"* → [§Posting a comment
  body](../gh-issue-intake-formats.md#posting-a-comment-body--read-it-into-body-never-gh-api--f-bodyfile-the-local-path-leak)
  of the formats contract, which stayed there.
- *"§6.6"* → [§ADVISORY](#advisory-the-canonical-advisory-line--one-form-for-all-four-gates) above —
  the same section under its mnemonic name.
- the relative link `shared/scripts/verdict-readback.sh` → [`scripts/verdict-readback.sh`](scripts/verdict-readback.sh),
  the sibling of this file (it was written from the parent directory).

### The verdict read-back guard — after posting a gate marker, re-read it and FAIL LOUD (`verdict_readback_guard`)

The by-value form above (`-f body="$BODY"`) is the *source* idiom; it prevents a `body=@<path>`
leak **at the call site**. But a source idiom cannot catch a **runtime deviation** — an agent that
hand-assembles the wrong `$BODY` (the literal temp path as the marker body, a body missing its
`Reviewed-head:` anchor, or a silently no-opped post) still lands a broken marker the by-value form
happily transmits. That is the #2148 class: the posted verdict comment's entire body was a local
temp path (`@/var/folders/…`), so no SHA-bound verdict existed for `ship-it` / the §CP merger to
bind to (a **missing** gate verdict), **and** it leaked a machine-local path into a public comment.
The source idiom alone can't see it; only a **post-write read-back** can.

So every gate that posts a verdict marker — `review-code`, `review-doc`, `review-skill`,
`review-design` — closes the loop with **one** canonical read-back guard: after the post/upsert
lands, **re-read the comment you just wrote** and assert three invariants, failing **loud**
(fail-closed, ADR
[0092](https://github.com/kamp-us/phoenix/blob/main/.decisions/0092-gates-fail-closed-on-zero-scope.md) §ZS)
on any miss — never a silent pass. This is the single source; each review skill **references it**
(it does not re-derive its own copy — the three-copy drift is exactly what this contract exists to
prevent):

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/verdict-readback.sh"                                  # §SHARED: both guards, one source
verdict_readback_guard "$CID" review-code "$HEAD_SHA" || …          # <gate> ∈ review-{code,doc,skill,design}
```

[`shared/scripts/verdict-readback.sh`](shared/scripts/verdict-readback.sh) carries the four checks and
their reasons: **(0)** a non-empty body, **(1)** a canonical `<gate>:` marker — the bindable
`PASS|FAIL @ <sha>` first line or the SHA-less `advisory` one, **(2)** the SHA-source-aware head
binding, **(3)** no local-filesystem-path leak. Any miss returns non-zero and names the cause.

Gate it exactly like the by-value post it follows: right after the `PATCH`/`POST` upsert returns the
comment id, call `verdict_readback_guard "$CID" <gate> "$HEAD_SHA"` and, on non-zero, **re-post the
real verdict and re-assert** — if it still cannot land clean, surface it as a **posting failure** in
the run ledger (the PR is genuinely ungated; a consumer must not read it as verified), never swallow
it as a silent success. A moved `HEAD_SHA` between the post and the read-back means the head advanced
*during* the review — re-resolve the head, re-verify against it (the gate is stateless), and re-post;
never loosen the match to paper over a moved head. (In practice a gate never calls this primitive with
a hand-carried id — it calls the unconditional `verdict_post_verify` wrapper below, which resolves the
landed comment id by re-scanning PR state and passes it here.)

Check (2) is **SHA-source-aware** (#2272): the read-back fires on every verdict type without
false-failing a legitimate non-blocking PASS. The bindable PASS/FAIL first line satisfies (1) via its
`@ <sha>` — that SHA **is** the head binding, so (2) requires no separate `Reviewed-head:` line (the
non-blocking binding templates carry the SHA only on the first line; this is the branch that keeps a
clean non-blocking doc/skill PASS from false-failing under the unconditional `verdict_post_verify …
|| exit 1`). The advisory blocking-set path carries no first-line `@ <sha>` by design (ADR 0111),
which is why (1) accepts the `<gate>: advisory` first line; it binds the head **in the body** via the
canonical `Reviewed-head: @ <sha>` line, which §6.6/ADR 0151 mandates on **all four gates'** advisories
— **review-code included** (#2329: the earlier "review-code's §CP advisory carries NONE by design →
accept its absence" carve-out contradicted §6.6's MUST and blinded (2) to a drifted `**Reviewed head:**`
variant, which ship-it's §6.6 enqueue matcher then rejects; the carve-out is removed, so a missing or
drifted advisory head-binding fails **loud at emission** rather than surfacing as a ship-it refusal on
an approved PR). Any `Reviewed-head:` line present but bound to the wrong sha is always fatal. The
canonical-marker check (1) and the leak check (3) are **unconditional** on every verdict type — the
#2148/#2264 path-leak protection is never relaxed.

### Make the read-back UNCONDITIONAL — resolve the landed verdict from PR state, never a carried id (`verdict_post_verify`)

`verdict_readback_guard` above is correct but only fires **if it is reached with the right comment
id**. The #2264 recurrence (after #2148/#2153 already "fixed" the leak) proves that condition is the
real gap: the guard was invoked as `verdict_readback_guard "$MINE" …`, and `$MINE` is populated on
**one** posting branch only (the APPROVE-failed comment-upsert `else` fallback). A verdict that lands
by any **other** path — the native `APPROVE`, a first-verdict `POST` on a branch that didn't set
`$MINE`, or an agent hand-rolling `gh api -f body=@file` — reaches the guard with an **empty** id, so
the guard reads nothing and the broken/leaking marker sails through. A guard you can skip by taking a
different post branch is not a guard.

The fix is to **stop trusting a carried variable and re-derive the landed verdict from live PR
state**, then run the read-back **unconditionally** on whatever landed. This is the single wrapper
every gate calls after posting — it resolves the marker comment id by re-scanning, proves *a* verdict
actually landed for the head, and **hard-fails (non-zero)** on absent / broken / leaking so a garbled
or path-leaking marker is a **fatal** error the gate cannot silently pass:

```bash
KP_SHARED="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)/claude-plugins/kampus-pipeline}/skills/shared/scripts"
. "$KP_SHARED/verdict-readback.sh"                                  # §SHARED: the wrapper and the guard it calls
verdict_post_verify "$PR" review-code "$HEAD_SHA" || exit 1         # UNCONDITIONAL, after ANY post/upsert
```

It resolves the landed verdict from live PR state — **(A)** my SHA-bound or advisory marker comment,
**(B)** a native `APPROVE` whose `commit_id` is this head — never from a carried `$MINE`/`$CID`; then
**(C)** hard-fails when nothing bound to the head landed, **(D)** runs the read-back on the landed
comment whichever branch posted it, and **(E)** leak-checks the native-`APPROVE` body too. Returns 0
only on a proven-clean landed verdict.

**Why this closes the #2264 recurrence — the post-path enumeration.** Every way a gate can land a
verdict now routes through the same unconditional read-back, because `verdict_post_verify` resolves
the landed surface from PR state instead of from a branch-local variable:

- **native `APPROVE`** → resolved by (B); its body is leak-checked by (E); commit_id is its SHA anchor.
- **comment `PATCH`-upsert** (the old `$MINE` branch) → resolved by (A); shape+leak by (D).
- **comment `POST`** (first verdict, `$MINE` empty) → resolved by (A); shape+leak by (D). *This is the
  branch the carried-`$MINE` call silently skipped.*
- **advisory comment** (§CP blocking-set) → resolved by (A) via the `<gate>: advisory` arm; shape+leak by (D).
- **hand-rolled `gh api -f body=@file`** (the literal path as the whole body) → has **no** `<gate>:`
  first line, so (A) resolves empty and (B) is 0 ⇒ **(C) fatal** (`ungated`). A garbled marker is fatal.

The single **fatal** exit on absent/broken/leaking is the load-bearing change: the prior Step-4c
presence check merely *echoed* a warning and re-posted without a non-zero exit, so a garble read as
green. Callers **must** propagate the non-zero — `verdict_post_verify … || exit 1` — so the gate
cannot report itself done over an ungated PR.

Gate it exactly like the by-value post it follows: right after the last of the Step-5/4a-4b upsert
branches runs, call `verdict_post_verify "$PR" <gate> "$HEAD_SHA" || exit 1`. On a moved `HEAD_SHA`
between post and verify the head advanced *during* review — re-resolve the head, re-verify against it
(the gate is stateless), and re-post; never loosen the match to paper over a moved head.

### The guarded emit path is MANDATORY — never hand-post a verdict marker off the guard

`verdict_post_verify` above is the *read-back*: it re-scans PR state **after** a post and fails loud
on a marker that landed broken or leaking. But a read-back cannot police a post it never sees. An
agent that **hand-posts** the verdict marker with a raw `gh api …/comments` or `gh pr comment` call
bypasses the verdict lib entirely, so `emissionDefect` never fires — and, worse, the marker often
never resolves through `verdict_post_verify`'s re-scan either, so nothing catches it. That is the
**emit-side hole** the recurrences rode: #2789 (the whole body was an `@filepath`), #2816 / #2818 (a
`/var/folders` mktemp path glued into the `@ <sha>` field) — each leaked because the marker was
hand-posted off the verdict lib, not because the lib's guard was wrong. Code cannot force a hand-post
through a guard the reviewer never invokes; the **emit path itself** must be mandated, not just
described.

So for **all four PR gates** — `review-code`, `review-doc`, `review-skill`, `review-design` — routing
every verdict-marker post through the guarded path is a **hard invariant, not a suggestion**:

- **MUST** post every verdict marker through `pipeline-cli verdict post` — the single marker-emit
  choke point that runs `emissionDefect` (the body-wide machine-local-path scan added by #2823, plus
  the 40-hex `@ <sha>` field guards, #2683) and **refuses fail-closed** on a leaking or malformed
  body. For the native `APPROVE` review body (which `verdict post` cannot emit), run the **same** gate
  as an explicit read-back assertion — `verdict validate` — **before** the `APPROVE`, so a
  malformed/leaking marker fails loud rather than landing in a public review body.
- **FORBIDDEN:** a bare `gh api …/comments` / `gh pr comment` hand-post of a verdict marker that skips
  the guard. The guarded tool is the **only** sanctioned emit path; a free-form raw post is a bypass,
  never an equivalent — a reviewer must not free-form the marker even when the body "looks clean."
- **The one escape hatch, itself guarded:** if a raw post is genuinely unavoidable, the body **MUST**
  first pass `pipeline-cli leak-guard scan-comment` (the standalone pre-post net #2823 added — reads
  the body on stdin / `--body-file`, exits non-zero on a machine-local path) **before** the post. A
  raw post whose body was never scanned is the forbidden case; a scanned one is the escape hatch.

This is the **enforcement complement** to #2823: #2823 hardened the guard *code* (`emissionDefect`'s
body-wide scan + the `leak-guard scan-comment` CLI); this mandate closes the emit-side hole by
forbidding the reviewer from routing around it — the two together are what actually close #2796. Each
review gate **references this rule as the single source** (it does not re-derive the *why* per skill).
Per #2393 the guard stays generic path-shape patterns, never a named-path deny-list.
