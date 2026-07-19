# How-to — operate a pipeline-crew install

> **Diátaxis mode: how-to** (task-oriented). One mode per doc — goal-focused recipes for an
> operator who already knows the shape. Meet the crew and stand it up from the
> [README](README.md) front door; look up an exact contract in the [Reference](REFERENCE.md);
> understand the design rationale in the [Explanation](EXPLANATION.md).

Step recipes for the recurring operator tasks against a **running crew**. Each is
goal-oriented and links into the [Reference](REFERENCE.md) for the exact contract and the
[Explanation](EXPLANATION.md) for the *why*, rather than re-deriving either here — when a step
needs a config key, a roster fact, or the §CP rationale, follow the link.

These recipes assume a filled operator config (`$CREW_CONFIG`, else the working repo's
`.claude/crew.config.jsonc`) — if you have not stood the crew up yet, do the
[README stand-up](README.md#personalize-then-stand-up) and the
[personalization seam](PERSONALIZATION.md) first.

## Add a role

**Goal:** bring one more member into the already-running crew — a scaled-up extra engine, or
the human-in-the-loop cartographer for a `wayfinder chart` — without a whole-crew re-boot.

`/stand-up` boots the self-driving roster and deliberately *excludes* the cartographer; adding
a single member on demand is [`/spawn-role`](commands/spawn-role.md), the thin front for the
substrate's `spawn-role` subcommand.

1. **Confirm a crew is up.** `spawn-role` *adds* to a running crew and fails closed if none is
   — [`/stand-up`](commands/stand-up.md) first if the crew is down.
2. **Spawn the member by role:**

   ```bash
   pipeline-crew-mcp spawn-role cartographer      # the HITL cartographer — boots idle
   pipeline-crew-mcp spawn-role engineering-manager --instance <id>   # one more engine
   ```

   The launcher does the full bind (per-pane channel scope, tmux placement, model tier, agent
   def) so the new member is live on the channel, never channel-inert — never hand-launch a
   `claude …` to route around it.
3. **Mind the cardinality rule.** Only the engine scales by `count`/`--instance`; each bridge
   is singleton, so a second one is a `RoleUniquenessError`, not shared occupancy — that is the
   roster law ([Explanation → roster law](EXPLANATION.md#roster-law); the bridge-vs-engine
   split is catalogued in [Reference → role roster](REFERENCE.md#role-roster--bridges-and-the-engine)).
4. **A HITL role boots idle.** The cartographer comes up waiting for you to give it a turn — it
   is handed no self-driving loop, so it never confabulates work.

> **Adding a brand-new role *kind* to the roster** (not just another member of an existing one)
> is a config + runtime change, not a spawn: one entry in the `roles` map plus one kind in the
> runtime's role source, per the [personalization seam](PERSONALIZATION.md#the-personalization-dimensions--enumerated-here-in-one-place).
> The spawn recipe above launches a member of a role the roster *already* declares.

## Configure personalization

**Goal:** point the crew at *your* people and machine — the operator, the §CP approver, model
tiers, engine count/WIP caps, and the human-notification transports.

The shipped plugin carries **zero** operator data; every operator-specific value enters through
the one [personalization seam](PERSONALIZATION.md). You fill it once at stand-up and edit it
whenever a dimension changes.

1. **Copy the placeholder-only template to your operator-owned, git-ignored config:**

   ```bash
   cp "${CLAUDE_PLUGIN_ROOT}/crew.config.template.jsonc" .claude/crew.config.jsonc
   echo ".claude/crew.config.jsonc" >> .gitignore
   ```
2. **Fill every `<placeholder>`.** The full key-by-key contract — types, which are required,
   the enumerations for `tier`/`channels.mode`, and the ref grammar — is
   [Reference → config keys](REFERENCE.md#config-keys--crewconfigjsonc); the rationale for each
   dimension is the [seam dimension table](PERSONALIZATION.md#the-personalization-dimensions--enumerated-here-in-one-place).
   Leave no `<...>` behind — the launcher fails closed on a missing or malformed dimension,
   naming it.
3. **Change one dimension later** — a new WIP cap, a swapped notification transport, a bumped
   engine `count` — by editing that key in your config and re-standing-up (below). The plugin
   knows nothing of the channel behind a `notification.*.command`, so switching a human from
   iMessage to Slack is a config swap, never a code change.
4. **Keep the pin optional.** `cliVersion` is the only optional key — omit it for an unpinned
   launch (so a frequent Claude Code auto-update never fail-closes the boot); set it only to
   deliberately lock a version.

## Reboot the crew

**Goal:** cycle the crew — after a config change, a CLI update, or a wedged session — with no
partial-crew left behind.

Reboot is teardown then stand-up. Pick the scope: one member, or the whole crew.

1. **One wedged member** — retire just it and re-spawn, leaving the rest running:

   ```bash
   pipeline-crew-mcp retire-role engineering-manager --instance <id>   # engine needs --instance
   pipeline-crew-mcp retire-role cartographer                          # a bridge takes none
   pipeline-crew-mcp spawn-role  engineering-manager --instance <id>
   ```

   `retire-role` kills that member's pane and reclaims its artifacts; its role lease frees by
   TTL. Re-spawn with [Add a role](#add-a-role).
2. **The whole crew** — tear down, then stand back up:

   ```bash
   pipeline-crew-mcp stand-down    # symmetric teardown of stand-up's per-pane scope + approvals
   pipeline-crew-mcp stand-up      # re-derive the roster from the (possibly edited) config
   ```

   `stand-up` re-reads the config, so a reboot is how a [personalization](#configure-personalization)
   edit takes effect. It is fail-loud with **no partial crew** — a drifted CLI pin or a bad
   dimension aborts before any session starts, naming the cause.
3. **Never hand-launch to "finish" a partial boot.** Fix the named precondition (crew up, config
   filled, CLI pin matched) and re-run the command — a hand-rolled `claude …` comes up
   channel-inert.

## Carry a §CP PR

**Goal:** get a control-plane (§CP) PR the crew built across its one human gate and merged —
without hand-merging it.

A §CP PR touches the agent control plane, so it cannot auto-ship: it needs a control-plane
human's **approval at the PR's current head** before the pipeline enqueues it. This is the
**approve-then-enqueue** model (ADR 0135) — the human owns the *judgment*, the pipeline owns the
*mechanics*. The flow is split across the crew exactly as
[Explanation → the §CP hard gate](EXPLANATION.md#cp-gate)
lays out; your job as operator is to move the human gate.

1. **Find the banked PR.** The engine drives a §CP lane to reviewed-ready, then **banks it on
   the board** — assigns it to the approver and labels it banked. It pings no human; the
   chief-of-staff reads banked PRs off the board and relays each to the approver as "needs your
   approval" through the [approver notification transport](REFERENCE.md#human-notification--per-recipient-transport-commands).
2. **Get the approval at the *current* head.** The §CP gate is a control-plane team approval
   bound to the exact head it reviewed — a rebase or any force-push un-binds it. So the approver
   approves the PR at its live head; if the head moved after an earlier approval, it needs a
   fresh one (the SHA-binding half of [verify-don't-relay](EXPLANATION.md#verify-dont-relay)).
   An author cannot self-approve their own control-plane change — it needs the *other*
   control-plane human (ADR 0135).
3. **Let the pipeline enqueue — do not hand-merge.** Once a current-head approval lands, the
   *engine* spawns the approval-aware shipper, which re-checks for the current-head approval and
   enqueues. Humans approve; they never hand-merge.
4. **Confirm it actually landed.** A merge-queue enqueue is **not** a merge — the queue owns the
   final async merge. Read the PR's live state (`state: merged` / `merged_at`) before calling it
   done, because an interrupted enqueue can still have landed (QUEUED ≠ MERGED).

> **The crew's own `agents/` defs are outside the §CP boundary** — they auto-ship on green by a
> founder ruling, so this recipe is for §CP work the crew *drives*, not for merges of the crew
> defs themselves (see the [README](README.md#the-crew-is-deliberately-outside-the-cp-boundary)).

## Retire a crew

**Goal:** stand the crew down — one member, or the entire crew — cleanly, reclaiming what
stand-up registered.

1. **Retire one member:**

   ```bash
   pipeline-crew-mcp retire-role <role>              # a bridge — no instance
   pipeline-crew-mcp retire-role engineering-manager --instance <id>   # one engine instance
   ```

   It kills that member's pane and reclaims its inbox/artifacts; the role lease frees by TTL,
   leaving the rest of the crew running. An engine requires `--instance`; a singleton bridge
   rejects it (the [roster law](EXPLANATION.md#roster-law) kind rule).
2. **Retire the whole crew:**

   ```bash
   pipeline-crew-mcp stand-down
   ```

   The symmetric teardown of `stand-up` — it removes the launcher-owned per-pane project scope
   (the `.mcp.json` and the server approval stand-up registered), so nothing is left dangling.
3. **Drain first if work is in flight.** A retire kills panes; it does not wait on lanes. Let
   the engine confirm its in-flight lanes **landed** (not merely "enqueued") and carry out any
   banked §CP PR ([Carry a §CP PR](#carry-a-cp-pr)) before you stand the crew down, or that work
   is left on the board for the next stand-up to pick up.

## See also

- [README.md](README.md) — the crew front door: the four roles, the flat topology, install +
  stand-up.
- [REFERENCE.md](REFERENCE.md) — the look-it-up contracts: agent-def frontmatter, the role
  roster, the config keys, the notification transports.
- [EXPLANATION.md](EXPLANATION.md) — the *why*: the roster law, the §CP hard gate,
  verify-don't-relay, single-owner comms.
- [PERSONALIZATION.md](PERSONALIZATION.md) — the personalization seam: the config mechanism and
  the dimension contract these recipes fill.
- [`commands/stand-up.md`](commands/stand-up.md), [`commands/spawn-role.md`](commands/spawn-role.md)
  — the plugin commands these recipes invoke.
