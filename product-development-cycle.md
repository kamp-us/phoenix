# Product development cycle

The cycle the pipeline skills interpret for **phoenix**. The skills (`plan-epic`,
`write-code`, `review-code`, `ship-it`) are flag-agnostic cycle-*interpreters*: they consult
this repo-owned doc at a well-known path and follow its prose (ADR
[0083](.decisions/0083-agents-deploy-humans-release.md)). This file is what makes phoenix's
instance of the pipeline **flag-gated**; a foreign repo with no such doc gets the same skills
behaving with the cycle steps no-op'd (ADR [0062](.decisions/0062-repo-as-config-plugin.md),
repo-as-config — the process is config, not skill logic).

This is the **current-state** surface for builders: what the cycle *is* today, not its
history. The *why* and the superseded approaches live in the ADRs; the flag *mechanics* live
in `.patterns/feature-flags-*.md` — this doc **points at** them, it does not copy them.

## The principle: agents deploy, humans release

**Agents own deployment; humans own release** (ADR
[0083](.decisions/0083-agents-deploy-humans-release.md)).

- **Deploy = agents.** The autonomous pipeline ships and merges continuously on a green gate
  stack (`review-*` + CI + e2e), with **no per-PR human eyeball**. A user-facing change merges
  **dark, behind a default-off flag** — it reaches `main` and production *off*. Merging is
  deployment; it is the agent boundary.
- **Release = humans.** Flipping the flag so users see the feature is a deliberate **human**
  act, performed by an **infra-admin** via the **Cloudflare (Flagship) dashboard**. Release
  authority equals infra-admin. No agent flips a flag.

This **refines** the no-eyeball auto-ship model rather than reversing it: the human checkpoint
moves from merge-time (slow, per-PR) to **release-time** (lower-friction, not per-PR) and is
*safer* — a bad autonomous merge stays dark until a human chooses to release it, so nothing
reaches users without a human flip.

## The default rule: user-facing ships behind a default-off flag

**A user-facing behavior change ships behind a default-off flag by default.** That is the
containment that makes the autonomous merge safe (ADR 0083; the containment argument is in
[.patterns/feature-flags-agent-workflow.md](.patterns/feature-flags-agent-workflow.md)).

- **User-facing → flag (default-off).** Any change a user could perceive — a new surface,
  changed behavior, a different result — ships dark behind a boolean flag defaulting off.
- **Internal / refactor / infra / docs → exempt.** A change with no user-visible behavior
  delta (a refactor, a build/infra change, a docs or `.decisions`/`.patterns` edit, a
  pipeline/skill change) is **exempt** — it needs no flag.
- **Opt out only with a stated reason.** A user-facing change *may* ship un-flagged, but only
  with an explicit, recorded reason (e.g. the flag substrate itself can't gate its own
  bootstrap). The reason is stated on the work item; silence is not opt-out.

### How the rule maps to the containment marker

`plan-epic` stamps each child issue with a `**Containment:**` line (alongside `**Stories:**`
and `**TDD:**`) derived from this rule; `write-code` and `review-code` read it. The marker is
defined once in the formats contract
([`skills/gh-issue-intake-formats.md`](claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md) §2); this
doc supplies the *rule* it encodes. The canonical values map directly:

| This rule | Containment marker | What the executor does |
|---|---|---|
| User-facing change | `flag (default-off)` | Ship dark behind a default-off flag. |
| Internal / refactor / infra / docs | `exempt (<reason>)` | No flag; the reason names why it's exempt. |
| Opt-out of flagging a user-facing change | `exempt (<reason>)` | Allowed only with the stated reason. |
| Foreign install (no cycle doc) | `none (no cycle doc)` | Graceful absence — no containment required. |

A missing `**Containment:**` line reads as `none` (tolerant default) — "no containment
required." In phoenix, where this doc exists, `plan-epic` always stamps an explicit value; the
`none` value is the graceful-absence state for a repo without this doc.

## Deploy → release → retire, end to end

1. **plan-epic** consults this doc and stamps each child's `**Containment:**` marker from the
   default rule above.
2. **write-code** ships the marked-`flag` work **dark** — declares a default-off flag and
   gates the new code path behind it, per
   [.patterns/feature-flags-agent-workflow.md](.patterns/feature-flags-agent-workflow.md)
   (declare → gate → ship dark).
3. **review-code** verifies the gating (flag is default-off, the read carries the safe default,
   nothing leaks the new path on by default).
4. **ship-it** merges dark on a green gate — **deployment complete, the agent boundary** — and
   surfaces the merged feature on the **release queue** for the humans (below).
5. **A human (infra-admin) flips the flag** on the Cloudflare dashboard once validated. This is
   the **release** — the only place a human decision is load-bearing.
6. **Retirement** returns to agents as a drainable chore (below).

The full mechanics of steps 2–5 (declare, gate, ship dark, validate in prod, flip, kill on
regression) are the workflow lane of
[.patterns/feature-flags-agent-workflow.md](.patterns/feature-flags-agent-workflow.md); the
naming grammar and lifecycle discipline are
[.patterns/feature-flags-schema-lifecycle.md](.patterns/feature-flags-schema-lifecycle.md).
Read those for the *how* — this doc does not restate them.

## The release queue: the deploy → release handoff

A deployed-dark feature surfaces to the human releasers via a **`status:awaiting-release`
label** on the linked issue (the surface defined in
[#602](https://github.com/kamp-us/phoenix/issues/602)). `ship-it` applies it post-dark-merge;
an infra-admin filters open issues by it to find what's ready, flips the flag on the Cloudflare
dashboard, then clears the label as the release completes.

This label is **orthogonal to the `status:*` pickability spine** — it is a post-merge
*release* state, not a pickability state, so `write-code` never keys on it. The release flip is
human (CF dashboard, infra-admins), per ADR 0083.

## Retirement: a flag is not forever

A flag is a *temporary* decoupling of deploy from release; left to accumulate, flags rot into
dead, untested conditionals. The **retirement trigger** is: **the flag is at 100% and stable
for one release** — at that point reverting is no longer realistic and the flag's job is done.

When the trigger fires, retirement **returns to agents as a drainable chore**
([#604](https://github.com/kamp-us/phoenix/issues/604)): a `type:chore` issue is filed (via the
`report` skill, per CLAUDE.md) so `write-code` drains it like any other chore — delete the flag
declaration, delete the `getBoolean` read and its dead `else` branch, and inline the
now-permanent path. The retirement *mechanics* are step 7 of
[.patterns/feature-flags-agent-workflow.md](.patterns/feature-flags-agent-workflow.md) and the
lifecycle's third stage in
[.patterns/feature-flags-schema-lifecycle.md](.patterns/feature-flags-schema-lifecycle.md);
the per-flag metadata recorded at declaration (owner, originating issue, removal trigger) is
what makes a later agent able to retire it.
