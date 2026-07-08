# pipeline-crew

The **pipeline-crew** plugin ships three battle-tested crew agent defs that *conduct* the
[`kampus-pipeline`](../kampus-pipeline/) skills as a **crew** — three coordinated Claude Code
sessions, one per seam, that turn the pipeline's report → triage → plan-epic → write-code →
review → ship-it skills into a standing operation a single operator runs from a tmux window.

This README is the **front door for a second operator**: everything below lets you stand up
the same three-session crew *alone*, with your own people and machine, without copying anyone
else's personal config. Every example here uses **fictional placeholders** — substitute your
own values at stand-up.

## What the crew is — three sessions across three seams

The pipeline is a conveyor from a raw observation to a merged PR. The crew is the three
standing roles that *drive* that conveyor, each owning one seam of it:

```
    intake seam            execution seam               human seam
  ┌──────────────┐      ┌─────────────────────┐      ┌────────────────┐
  │  triage-guy  │ ───▶ │ engineering-manager │ ───▶ │  exec-assistant│
  │  (intake)    │      │    (execution)      │      │   (EA / human) │
  └──────────────┘      └─────────────────────┘      └────────────────┘
   report → triage        coder → reviewer →            situational-
   → plan-epic →          shipper, under                awareness,
   canon/adr routing      WIP caps, QUEUED≠MERGED        single-owner
                          verification, stall            notification,
                          recovery                       §CP bank-and-relay
```

- **triage-guy — the intake seam** ([`agents/triage-guy.md`](agents/triage-guy.md)). The
  standing intake session: it runs the report → triage loop over the target repo's
  `status:needs-triage` queue and owns the **planning/canon seam** — spawning the `planner`
  agent over freshly-triaged epics and the `canon`/`adr` agents for canon/decision-shaped work
  (mirroring how the execution seam spawns `coder`/`reviewer`/`shipper`), rather than running
  those skills inline. It hands `status:triaged` issues forward to the execution seam.
- **engineering-manager — the execution seam**
  ([`agents/engineering-manager.md`](agents/engineering-manager.md)). The execution conductor:
  it drives each triaged issue to a *landed* merge by spawning the ephemeral kampus-pipeline
  subagents (`coder` → `reviewer` → `shipper`) under **bounded WIP caps**, verifies a merge
  actually landed (a merge-queue enqueue is never "done"), recovers stalled lanes, and banks
  control-plane (§CP) PRs for human merge instead of shipping them.
- **exec-assistant — the human seam** ([`agents/exec-assistant.md`](agents/exec-assistant.md)).
  The executive assistant / chief-of-staff: it fronts the pipeline for the operator, gives
  situational-awareness reads, routes execution to the engineering-manager session (it never
  runs the pipeline itself), owns the **single-owner human-notification protocol**, and runs
  the **§CP bank-and-relay** protocol for control-plane PRs.

The seams are one-directional: intake feeds execution, execution surfaces control-plane work
and blockers to the human. Each session is a *conductor* — it spawns the ephemeral pipeline
agents that write, review, and merge; it never does their work by hand.

## Relationship to kampus-pipeline — a one-way dependency

pipeline-crew **consumes** [`kampus-pipeline`](../kampus-pipeline/) and never the reverse:

- The crew defs conduct the pipeline's shipped **skills** and spawn its ephemeral **agents**
  (`coder`, `reviewer`, `shipper`, `reporter`, `triager`, `planner`, `canon`, `adr`) **by their
  shipped names** — they never re-implement, fork, or edit any file under
  [`../kampus-pipeline/`](../kampus-pipeline/).
- **Nothing under `claude-plugins/kampus-pipeline/` references or depends on pipeline-crew.**
  The dependency direction is structural and one-way (epic #2342): the crew is an optional
  layer *over* the pipeline, never a prerequisite of it. You can install kampus-pipeline and
  run the skills by hand with no crew at all; the crew is the proven way to run them
  continuously.

### The crew is deliberately outside the §CP boundary

kampus-pipeline carries a **control-plane (§CP)** boundary: PRs that touch the agent control
plane bank for a human merge behind a hard GitHub gate (ADR
[0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)),
never auto-shipping on green. **pipeline-crew's `agents/` is deliberately *not* part of that
boundary** — a founder ruling recorded in epic #2342's resolved questions: the crew is an
optional/extra surface whose PRs **auto-ship on green** by design, with no extension of the
§CP path set or CODEOWNERS to this directory.

The operational consequence for you: **edits to the crew defs in this directory merge
automatically once their review gate passes** — they do not wait on a human merge. (PRs that
touch kampus-pipeline's own §CP surfaces still bank for human merge — the ruling covers only
this `pipeline-crew/` directory, not the pipeline it consumes.)

## Install by name from the kampus marketplace

The crew ships through the same self-hosted **kampus** marketplace as kampus-pipeline
([`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)). Add the
marketplace once, then install the plugin by name:

```
/plugin marketplace add kamp-us/phoenix
/plugin install pipeline-crew@kampus
```

The plugin carries **no `version`** — it is content-addressed by commit SHA (continuous-ship,
ADR [0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md)), so def edits
reach installed operators on the normal update path. Install kampus-pipeline the same way
(`/plugin install kampus-pipeline@kampus`) — the crew conducts its skills, so you want both.

## Personalize — fill the seam once (fictional examples only)

The shipped plugin carries **zero real operator data** — the three defs, this README, and the
config template hold only `<placeholders>`. Everything operator-specific enters through the
**[personalization seam](PERSONALIZATION.md)**: at stand-up you copy the placeholder-only
template to an operator-owned config file and fill it once. Each crew def resolves that file at
spawn and addresses *your* people and machine.

```bash
# 1. Copy the placeholder-only template to your operator-owned config (default path).
cp "${CLAUDE_PLUGIN_ROOT}/crew.config.template.jsonc" .claude/crew.config.jsonc
#    (or keep it anywhere and point $CREW_CONFIG at it).

# 2. Fill EVERY <placeholder>. Leave no <...> behind.

# 3. Git-ignore your copy — it holds your operator data and must never be committed.
echo ".claude/crew.config.jsonc" >> .gitignore
```

Resolution order mirrors kampus-pipeline's repo-as-config seam (ADR
[0062](../../.decisions/0062-repo-as-config-plugin.md)): **`$CREW_CONFIG`** if set, else the
working repo's **`.claude/crew.config.jsonc`**. A def that can't resolve a filled config
**stops and asks you to run stand-up** — there is no baked-in default human.

### The seam dimensions — what to fill

Every operator-specific dimension is enumerated once, canonically, in
[`PERSONALIZATION.md`](PERSONALIZATION.md#the-personalization-dimensions--enumerated-here-in-one-place).
Below is a worked fill using **entirely fictional** values — *never* a real operator, handle,
or channel; substitute your own:

| Dimension | Config keys | Fictional example |
|---|---|---|
| **Operator / founder** — the human the crew serves and reports to | `operator.name`, `operator.handle` | `"Robin Operator"`, `"@robin"` |
| **Control-plane approver** — who reviews/approves/merges §CP PRs (the second human the EA banks §CP work for, ADR 0135) | `controlPlaneApprover.name`, `controlPlaneApprover.login` | `"Sam Approver"`, `"sam-approver"` |
| **Notification channel / handle** — where the single-owner notification protocol delivers pings | `notification.channel`, `notification.handle` | `"#crew-pings"`, `"@robin"` |
| **tmux / session naming** — the session + the three per-role windows the roles address each other by | `tmux.session`, `tmux.windows.ea`, `tmux.windows.engineeringManager`, `tmux.windows.triage` | `"crew"`, `"ea"`, `"em"`, `"triage"` |
| **Model tiers** — the tier each role runs on (planning-tier intake vs execution/build-tier conductor, so a role never silently downgrades a spawned subagent) | `modelTiers.ea`, `modelTiers.engineeringManager`, `modelTiers.triage` | `"planning-tier"`, `"build-tier"`, `"planning-tier"` |
| **WIP caps** — the engineering-manager's bounded concurrent-lane count per class (product vs platform/pipeline) | `wipCaps.productLanes`, `wipCaps.platformLanes` | `2`, `2` |

A filled [`crew.config.template.jsonc`](crew.config.template.jsonc) with these fictional values
looks like:

```jsonc
{
  "operator": { "name": "Robin Operator", "handle": "@robin" },
  "controlPlaneApprover": { "name": "Sam Approver", "login": "sam-approver" },
  "notification": { "channel": "#crew-pings", "handle": "@robin" },
  "tmux": {
    "session": "crew",
    "windows": { "ea": "ea", "engineeringManager": "em", "triage": "triage" }
  },
  "modelTiers": { "ea": "planning-tier", "engineeringManager": "build-tier", "triage": "planning-tier" },
  "wipCaps": { "productLanes": 2, "platformLanes": 2 }
}
```

The model tiers are load-bearing, not cosmetic: because the ephemeral pipeline agents are
`model: inherit`, a conductor session brought up on the wrong tier silently downgrades every
subagent it spawns. Bring the **engineering-manager** up on the build tier and the intake
session on the planning tier — the config records which is which so no role guesses.

## Stand up the three tmux sessions

Once the config is filled, bring up one tmux session with one window per seam and start a
Claude Code session in each. The window names come from your `tmux.*` config — the fictional
fill below uses session `crew` with windows `triage`, `em`, `ea`:

```bash
# Create the session with the intake window, then add the execution + human windows.
# Window names are your tmux.windows.* values (fictional here: triage / em / ea).
tmux new-session -d -s crew -n triage
tmux new-window  -t crew   -n em
tmux new-window  -t crew   -n ea
```

Then, in each window, start Claude Code on that role's configured model tier and give it the
matching spawn prompt. Which session runs what:

- **`triage` window — the intake seam.** Bring the session up on `modelTiers.triage` (the
  planning tier). Spawn prompt:

  > *You are the pipeline-crew intake session. Follow the `triage-guy` agent def. Run the
  > report → triage loop over the `status:needs-triage` queue and plan freshly-triaged epics
  > (spawning the `planner`). Resolve the personalization seam from `.claude/crew.config.jsonc`
  > before acting; hand triaged issues to the `em` window.*

- **`em` window — the execution seam.** Bring the session up on
  `modelTiers.engineeringManager` (the build tier — the one that must not downgrade its
  subagents). Spawn prompt:

  > *You are the pipeline-crew execution conductor. Follow the `engineering-manager` agent def.
  > Drive triaged issues to landed merges by spawning `coder` → `reviewer` → `shipper`
  > (`isolation:worktree`) under the configured WIP caps, verify each merge landed, and bank
  > §CP PRs for the control-plane approver. Resolve the personalization seam first.*

- **`ea` window — the human seam.** Bring the session up on `modelTiers.ea`. Spawn prompt:

  > *You are the pipeline-crew EA / chief-of-staff. Follow the `exec-assistant` agent def. Give
  > me situational-awareness reads, route execution to the `em` window (never run the pipeline
  > yourself), own the single-owner notification protocol, and run §CP bank-and-relay for
  > control-plane PRs. Resolve the personalization seam first.*

Each session resolves the personalization config at spawn and addresses your people and windows
by *their* configured names — never a literal. From there the crew runs the pipeline
continuously: triage-guy feeds triaged work to the engineering-manager, which drives it to
merged PRs and surfaces control-plane work and blockers to the EA, which is your single point
of contact.

## Layout

```
pipeline-crew/
├── .claude-plugin/plugin.json    # manifest (no version — continuous-ship, ADR 0110)
├── agents/
│   ├── triage-guy.md             # intake seam
│   ├── engineering-manager.md    # execution seam
│   └── exec-assistant.md         # human seam (EA / chief-of-staff)
├── PERSONALIZATION.md            # the personalization seam — the def contract + dimension table
├── crew.config.template.jsonc    # placeholder-only per-install config template
└── README.md                     # this file
```

## See also

- [`PERSONALIZATION.md`](PERSONALIZATION.md) — the seam mechanism, the canonical dimension
  table, and the stand-up contract the three defs write against.
- [`../kampus-pipeline/`](../kampus-pipeline/) — the pipeline this crew conducts (the skills +
  ephemeral agents).
- ADR [0062](../../.decisions/0062-repo-as-config-plugin.md) — the repo-as-config seam this
  crew's personalization mirrors.
- ADR [0110](../../.decisions/0110-plugin-carries-no-version-continuous-ship.md) — why neither
  plugin carries a `version`.
- ADR [0135](../../.decisions/0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)
  — the §CP hard gate the crew is deliberately outside of.
