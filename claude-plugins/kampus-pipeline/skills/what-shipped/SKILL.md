---
name: what-shipped
description: The founder's on-demand "what did we ship" readout. Gather the merged work over a window (git log + `gh` REST, never GraphQL), join each PR to its issue → milestone/type, tag the product/infra section from the PR `area:*` label, resolve each item's live-vs-dark release state from authoritative Cloudflare Flagship values (via `anka-ops`), then invoke `pipeline-cli ship-digest derive` and present the grouped digest — what merged AND what is actually live to users, in one glanceable pull. Trigger on "what shipped", "what did we ship", "ship digest", "what's live", "what's still dark", "/what-shipped".
---

# what-shipped

You are the **gather-and-present** layer of the founder-facing ship digest (epic #1586). The
pure projection core — grouping merged work product/infra → milestone → type, and rendering the
live/dark axis — already lives in `pipeline-cli ship-digest` (`packages/pipeline-cli/src/tools/ship-digest/`,
issues #1595/#1597/#1598). That core is **deliberately IO-free**: it consumes a pre-gathered
entries JSON and renders. This skill does the IO the core refuses to — read git, read `gh`, read
Flagship — assemble the entries JSON, hand it to the tool, and show the founder the result.

**Pull-first, on demand.** The founder runs `/what-shipped` when they want the readout; there is no
cron and no auto-posted Discussion (an explicit non-goal of this surface — a push mode, if ever
built, adds a `.github/workflows/` cron, which is control-plane and human-merged per ADR 0053, not
part of this skill).

**You gather and present; you never flip a flag.** The live/dark axis is *read* from Flagship, never
written — the human remains the sole releaser (ADR 0083; ADR 0123 Consequences). This skill reads
authoritative state to *report* it; it does not automate release.

## All `gh` via REST — never GraphQL

Every issue/PR/label read goes through `gh api` REST. The kamp-us org runs a legacy
Projects-classic integration that errors out GraphQL issue/PR queries, so this is a hard
constraint. Resolve the target repo once, up front (this skill is repo-agnostic — every call
targets `$REPO`), per the shared contract's target-repo rule
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), ADR 0062):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

## Resolve the `ship-digest` command once — in-repo-first, published-fallback

Prefer the on-disk consolidated `packages/pipeline-cli/src/bin.ts` when it exists (phoenix-local:
no network, no published-artifact dependency); otherwise invoke the **published**
`@kampus/pipeline-cli` CLI via `pnpm dlx` (ADR 0064; epic #994). Build it once:

```bash
if [ -f packages/pipeline-cli/src/bin.ts ]; then
  DIGEST="node packages/pipeline-cli/src/bin.ts ship-digest"   # phoenix-local: the in-repo consolidated bin
else
  # foreign install: the PUBLISHED consolidated CLI; the pin is the single source-of-truth version
  # shared with the other skills' published-fallback (epic #994) — bump in lockstep on release.
  DIGEST="pnpm dlx @kampus/pipeline-cli@0.2.0 ship-digest"
fi
```

---

## Step 0 — Fix the window

Default the window to a recent, glanceable span — the last **7 days** unless the founder names
another (`/what-shipped since 2026-06-01`, `/what-shipped last 30 days`). The window is two ISO
dates the digest heading reports over:

```bash
SINCE="${SINCE:-$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)}"
UNTIL="${UNTIL:-$(date -u +%Y-%m-%d)}"
echo "window: $SINCE → $UNTIL"
```

`ship-digest derive` needs `--since` (required) and optional `--until` (defaults to today), so
`$SINCE`/`$UNTIL` flow straight through at Step 4.

---

## Step 1 — Gather the merged PRs in the window

Get the PRs merged into `main` since `$SINCE`. The **merged-PR number is the primary key** of
every entry (`ShipEntry.pr` is always present); everything else is joined onto it.

Read merged PRs via `gh api` REST (never GraphQL). The `search/issues` endpoint filters on
`merged:` directly:

```bash
# merged PRs in the window — REST search, never GraphQL. `is:merged` + `merged:$SINCE..$UNTIL`.
gh api -X GET search/issues \
  -f q="repo:$REPO is:pr is:merged merged:$SINCE..$UNTIL" \
  -f per_page=100 --jq '.items[] | .number'
```

If you prefer to anchor on the merge commits rather than trust the search index, cross-check with
`git log --since "$SINCE" --until "$UNTIL" --merges --first-parent origin/main` and extract the
`#NNN` from each squash/merge subject — the two should agree; the REST search is authoritative for
the metadata join below.

For each merged PR number, read the fields the entry needs:

```bash
# per merged PR: title, its `area:*` label (join-free product/infra signal, #1598), and the
# linked issue via the `Fixes #N` / `Closes #N` in the PR body.
gh api "repos/$REPO/pulls/$PR" --jq '{title: .title, body: .body, labels: [.labels[].name]}'
```

- **`title`** → the entry's `title` (prefer the linked-issue title once resolved in Step 2).
- **`area:*` label** → the entry's **`area`** (`product` from `area:product`, `infra` from
  `area:infra`) — the PR-signal-preferred, **join-free** section source (the convention documented
  in [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md); #1598). Absent is well-formed
  — leave `area` unset and let the Step-2 join supply `joinedArea`.

---

## Step 2 — Join each PR → its issue → milestone / type (the fallback section source)

Parse the PR body for its `Fixes #N` / `Closes #N` / `Resolves #N` backlink to find the linked
issue, then read that issue's metadata:

```bash
# the linked issue's title, milestone, and type:* — the entry's title (preferred), milestone, and type.
gh api "repos/$REPO/issues/$ISSUE" \
  --jq '{title: .title, milestone: (.milestone.title // null), type: ([.labels[].name | select(startswith("type:")) | sub("^type:";"")] | first // null)}'
```

Populate each entry from the join:

- **`issue`** — the linked issue number (omit when the PR closes no issue).
- **`title`** — prefer the **closed-issue title**; fall back to the PR title when there is no link.
- **`milestone`** — the issue's milestone title, or omit (→ `Uncategorized`).
- **`type`** — the bare `type:*` value (`feature` / `bug` / `chore` / …), or omit (→ `Uncategorized`).
- **`joinedArea`** — the **fallback** product/infra signal recovered from the join: derive
  `product` / `infra` from the milestone / issue surface when the PR carried no `area:*` label.
  The core prefers the PR `area` and only consults `joinedArea` when `area` is absent
  (`resolveSection`), degrading cleanly to the pre-`area:*` join behavior, never worse.

A PR that closes no issue is not dropped — carry it with just `pr` + `title` (+ `area` if labeled);
the core surfaces it under `Product` / `Uncategorized`, flagged, never dropped.

---

## Step 3 — Resolve each entry's live-vs-dark release state (authoritative Flagship read)

This is the axis that answers **"what is actually LIVE to users,"** not just what merged. Per ADR
[0123](https://github.com/kamp-us/phoenix/blob/main/.decisions/0123-ship-digest-live-axis-from-authoritative-flagship-state.md)
the state is sourced from **authoritative Cloudflare Flagship values** (the ADR-0081 substrate),
read via `anka-ops` — **not** from repo-declared flag defaults and **not** from the
`status:awaiting-release` label, because only the authoritative read reflects the human's
out-of-band release flip (ADR 0083), which leaves no in-repo trace.

Read the live flag × env matrix once via `anka-ops flag list` (its `FlagshipRead` client reads each
flag's **effective serving** per env — rules → no-match split → default, the `SERVES` column;
credentials come from the ambient environment, never source). Real releases are performed as a
**no-match percentage split**, never a `defaultVariation` flip (#1726), so only the effective
serving is truthful — a split-released flag's `defaultVariation` stays `off` forever:

```bash
# authoritative Flagship state — every flag × env with its enabled/default value (ADR 0081/0123).
# in-repo-first, published-fallback, same idiom as $DIGEST above.
if [ -f packages/anka-ops/src/bin.ts ]; then
  node packages/anka-ops/src/bin.ts flag list
else
  pnpm dlx @kampus/anka-ops@0.1.0 flag list
fi
```

Assign each merged entry a **`releaseState`** — one of `live` / `awaiting-release` / `dark` /
`unknown` (`RELEASE_STATE_ORDER`), by this rule:

- **Flag-gated feature** (the merged work rides a Flagship flag — the authorship-loop /v1-membrane
  class, #1202): look up that flag's **effective serving** (`SERVES`) for the prod env in the
  `flag list` output.
  - **`on@100% (split)` or `on (default)`** → `live` (a split-released flag is live even though its
    `defaultVariation` is off — never read the default as the release state, #1726).
  - **`on@N% (ramping)`, 0 < N < 100** → `live` (partially released — note the ramp share).
  - **`off (default)` (no split serving, not yet released)** → `dark` (merged behind a default-off
    flag; live only once a human releases it — ADR 0083).
  - queued for release but the flip is imminent / staged → `awaiting-release` (use when the
    release-handoff signal says so and the flag is not yet on).
- **Non-flag-gated work** (internal / refactor / infra / docs — the ADR-0083 exemptions, no flag to
  read): **merged is live** → `live`. This is the trivial merge-equals-live default the ADR names.
- **No resolvable flag/release state** — a feature that *should* be flag-gated but you cannot map to
  a flag, or the read is inconclusive → **`unknown`**. Never silently treat it as `live` (ADR 0123;
  the core's `resolveReleaseState` default is `unknown`, and the acceptance criterion is explicit
  that unmapped work surfaces as unknown).

Map a merged feature to its flag key by the feature's flag declaration
(`apps/web/worker/features/flagship/`) and the flag grammar in `.patterns/` — the flag key is the
join between "this merged feature" and "this Flagship row." When that map is ambiguous, prefer
`unknown` over a guess.

---

## Step 4 — Assemble the entries JSON and invoke `ship-digest derive`

Write the gathered entries to a JSON array — the exact shape `ship-digest derive` decodes at its
trust boundary (`packages/pipeline-cli/src/tools/ship-digest/command.ts`, validated by
`.patterns/effect-schema-validation.md`). Each entry:

```jsonc
[
  {
    "pr": 1574,                      // required — the merged-PR number (primary backlink)
    "issue": 1572,                   // optional — the closed issue, when linked
    "title": "isolate the shipper dispatch in drive-issue.js to a worktree",
    "type": "chore",                 // optional — bare type:* value; absent ⇒ Uncategorized
    "milestone": "Pipeline hardening", // optional — issue milestone; absent ⇒ Uncategorized
    "area": "infra",                 // optional — PR area:* signal (preferred, join-free)
    "joinedArea": "infra",           // optional — join fallback; consulted only when area absent
    "releaseState": "live"           // optional — live/awaiting-release/dark/unknown; absent ⇒ unknown
  }
]
```

Write it to a scratch file (never a repo path — this is throwaway gather output, not a committed
artifact), then invoke:

```bash
ENTRIES="$(mktemp -t what-shipped-entries.XXXXXX.json)"
# … write the gathered array to "$ENTRIES" …
$DIGEST derive --entries "$ENTRIES" --since "$SINCE" --until "$UNTIL"
```

`ship-digest derive` decodes the entries, runs the pure `deriveShipDigest` core, and prints the
grouped digest (product/infra → milestone → type, with the per-entry live/dark annotation and the
"currently dark — awaiting your release" callout) to stdout. A malformed entries file is a typed
`EntriesReadError` (non-zero exit), not a crash — fix the JSON and re-run.

---

## Step 5 — Present the digest to the founder

Show the rendered markdown digest directly. It already carries both axes in one readout:

- **What merged** — grouped `## Product` / `## Infra` → `### <milestone>` → `#### <Type>`, each
  merged item a `- <title> (#PR)` line.
- **What is live vs dark** — the inline release-state annotation per entry, plus the distinct
  **"currently dark — awaiting your release"** section listing the not-yet-live work (`dark` +
  `awaiting-release`). This is the founder's release-action list: features that merged but wait on
  a human flag flip to reach users.

Add a one-line lead-in naming the window (`Since <SINCE>: N merged, M live, K still dark`) so the
readout is glanceable at the top, then the digest. If the dark section is populated, call it out —
that is the founder's cue to flip flags (`anka-ops flag open … --execute`, the human release act).

Do **not** commit anything, open a PR, or post a Discussion — this is a read-only pull surface. The
only writes this skill makes are to the scratch entries file; clean it up when done (`rm -f "$ENTRIES"`).
