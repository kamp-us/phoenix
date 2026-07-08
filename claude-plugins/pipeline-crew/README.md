# pipeline-crew

The **pipeline-crew** plugin ships the three battle-tested crew agent defs that *conduct*
the [`kampus-pipeline`](../kampus-pipeline/) skills as a **crew** — three coordinated
sessions spanning the intake → execution → human seams:

- **EA / chief-of-staff** — the human interface + situational-awareness role (single-owner
  notification, §CP bank-and-relay). *(agent def: issue #2360)*
- **engineering-manager** — the execution conductor over ephemeral pipeline subagents (WIP
  caps, queued-vs-merged verification, stall recovery). *(agent def: issue #2354)*
- **triage-guy** — the intake loop + the planning/canon seam. *(agent def: issue #2355)*

kampus-pipeline ships the *skills* (report → triage → plan-epic → write-code → review →
ship-it) and the ephemeral agent defs that wrap them; pipeline-crew ships the proven way of
*driving* them as three standing sessions, so a second operator can stand up the same setup
alone instead of copying anyone's personal config.

## Boundary — one-directional dependency

pipeline-crew **consumes** kampus-pipeline's shipped agents and skills by name; **nothing
under `claude-plugins/kampus-pipeline/` references or depends on pipeline-crew.** The
dependency direction is structural and one-way (epic #2342): the crew is an optional layer
over the pipeline, never a prerequisite of it.

## Personalization — zero operator data ships

Everything operator-specific — the operator/founder name, the control-plane approver, the
notification channel/handle, tmux/session naming, and model-tier preferences — is supplied
**per install** through the [personalization seam](PERSONALIZATION.md), never baked into
plugin content. The shipped plugin carries only `<placeholders>`; an operator fills their
own people and machine once at stand-up. That doc is the contract the three agent defs
write against.

## Layout

```
pipeline-crew/
├── .claude-plugin/plugin.json   # manifest (no version — continuous-ship, ADR 0110)
├── agents/                      # the three crew defs land here (#2360 / #2354 / #2355)
├── PERSONALIZATION.md           # the personalization seam — the def contract
├── crew.config.template.jsonc   # placeholder-only per-install config template
└── README.md
```

## Status

This is the **scaffold** (Phase-2, issue #2349): the manifest, the empty `agents/` dir, the
personalization seam, and this stub. The three agent defs (Phase 3), the marketplace catalog
entry (issue #2353), the full topology + tmux stand-up README (issue #2356), and the leak-check
CI guard (issue #2357) land on this shape.
