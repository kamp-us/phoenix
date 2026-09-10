# The fabrika verb reference

This page orients readers to each command group. The complete verb list comes from runtime help,
which reads the same registry that dispatches commands.

```bash
node packages/fabrika-cli/src/bin.ts --help
node packages/fabrika-cli/src/bin.ts ship --help
node packages/fabrika-cli/src/bin.ts ship checks --help
```

Use group help to choose a verb, then that verb's help for invocation, inputs, answer bytes and exit
meanings. Prefix the short commands below with `node packages/fabrika-cli/src/bin.ts`, as above.
The group sections below link to implementation contracts where one exists. Read a
contract by heading:

```bash
node packages/fabrika-cli/src/bin.ts wire doc-section --heading 'ship checks' < claude-plugins/fabrika/skills/ship/contract.md
```

The package front door is [the README](../README.md). For what Fabrika is and how to run it, read
[the guide](../../../claude-plugins/fabrika/guide/README.md).

## The interface every verb meets

The [interface convention](../../../claude-plugins/fabrika/docs/interface-convention.md) owns the
shared calling rules.
[Command documentation ownership](../../../claude-plugins/fabrika/docs/interface-convention.md#command-documentation-ownership)
defines what belongs in help, contracts, skills and this reference.

## The shared exit table

Read the command's own `--help` for the codes it can return. The
[exit-status convention](../../../claude-plugins/fabrika/docs/interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is)
explains reserved codes and how groups allocate their own meanings.

## The `adr` group

Record an architecture decision, from allocating its number to resolving citations and updating
older records' status. Use `adr --help` for the verbs and the
[ADR contract](../../../claude-plugins/fabrika/skills/adr/contract.md) for implementation requirements.

## The `build` group

Construct one issue or repair an existing PR. This group owns claims, worktree proofs, branches,
validation and guarded publication. Use `build --help` and the
[build contract](../../../claude-plugins/fabrika/skills/build/contract.md).

For cleanup, `build retire` addresses one issue's held worktree, `build reap` scans finished agent
worktrees, and `build retire-branch` handles an epic child's superseded branches. Read each verb's
help before selecting which work to retire.

## The `campaign` group

Read and change the roadmap's campaign table. Use `campaign --help` and the
[campaign contract](../../../claude-plugins/fabrika/skills/campaign/contract.md).

## The `ci` group

Release and build workflow plumbing, including changelog derivation, release-PR bodies, typecheck
annotations and run evidence. Use `ci --help`.

`ci annotate` is a streaming filter, so its implementation writes its own streams. The
[ci-required entrypoint](../src/ci/required-bin.ts) is a separate dependency-free binary used by the
workflow aggregator. It does not run through the Effect command tree.

## The `config` group

Keep the editor's JSON Schema for `.fabrika.jsonc` aligned with the
[config-key registry](../src/config/registry.ts). Use `config --help`.

## The `decision` group

Record a ruling on a decision issue and read whether it still applies to the issue's text.
Use `decision --help`. The
[approval formats](../../../claude-plugins/fabrika/docs/wire-formats.md) describe the stored agreement.

## The `glossary` group

Maintain a repository's domain and architecture vocabulary registers. Use `glossary --help` and
the [glossary contract](../../../claude-plugins/fabrika/skills/glossary/contract.md).

## The `governance` group

Read decision records and changed guard instructions for a PR or commit range, then record the
reviewer's judgment. Use `governance --help` and the
[governance contract](../../../claude-plugins/fabrika/skills/governance/contract.md).

## The `graduate` group

Turn a cleared decision trail into one buildable issue. Use `graduate --help` and the
[graduate contract](../../../claude-plugins/fabrika/skills/graduate/contract.md).

## The `grill` group

Keep questions, answers and founder rulings in a session issue's comments. Use `grill --help` and
the [grilling contract](../../../claude-plugins/fabrika/skills/grilling/contract.md).

## The `guard` group

Repository checks used by CI. This group nests each check under its own command, so discovery has
one more level:

```bash
node packages/fabrika-cli/src/bin.ts guard --help
node packages/fabrika-cli/src/bin.ts guard readme-guard --help
node packages/fabrika-cli/src/bin.ts guard readme-guard check --help
```

Shared implementations resolve [workspace members](../src/guard/members.ts),
[changed files](../src/guard/changed-files.ts) and [verdicts](../src/guard/verdict.ts).

## The `handoff` group

Record work so another session can resume it. The caller writes the explanation; the command
captures the Git and board state. Use `handoff --help` and the
[handoff contract](../../../claude-plugins/fabrika/skills/handoff/contract.md).

## The `heal-ci` group

Diagnose stalled PRs, read failed-job logs and apply the supported retry. Use `heal-ci --help`
and the [heal-ci contract](../../../claude-plugins/fabrika/skills/heal-ci/contract.md).

## The `hook` group

Read Claude Code hook envelopes and provision worktrees. Use `hook --help` and the
[hook convention](../../../claude-plugins/fabrika/docs/hook-surface.md).

Captured envelopes and their capture methods live under
[hook fixtures](../src/hook/__fixtures__/). Repository-specific worktree provisioning is declared
by the consuming repository; the plugin's [hook declarations](../../../claude-plugins/fabrika/hooks.json)
are a separate installation concern.

Model-selection history is recorded in the
[retirement decision](../../../.decisions/0374-retire-unused-model-vocabulary.md).

## The `lane` group

Drive a workflow from its local event log. Each command replays the log; lane state stays local and
uncommitted. Use `lane --help` for command details and the
[operator skill](../../../claude-plugins/fabrika/skills/operate/SKILL.md) for the driving loop.
[Codex dispatch](./codex-dispatch.md) documents running a task in its dedicated worktree.

A template can also be inspected without opening a live issue lane:

```bash
mkdir -p .fabrika/lanes/5673
cp packages/fabrika-cli/src/lane/templates/coder.workflow.json .fabrika/lanes/5673/workflow.json
node packages/fabrika-cli/src/bin.ts lane transition 5673 WIP
node packages/fabrika-cli/src/bin.ts lane status 5673
```

The [coder template](../src/lane/templates/coder.workflow.json) declares the workflow.
Use `lane print --help` to inspect its compiled transitions.

## The `ledger` group

Write an epic's plan, children and dependency edges. Use `ledger --help` and the
[plan-epic contract](../../../claude-plugins/fabrika/skills/plan-epic/contract.md).
The `plan` group handles the plan's checks.

## The `map` group

Track an undecided destination through a map issue, its question tickets and their native
dependency edges. Use `map --help` and the
[wayfinding contract](../../../claude-plugins/fabrika/skills/wayfinding/contract.md).

## The `pattern` group

Read and update the repository's pattern library. Use `pattern --help` and the
[write-pattern contract](../../../claude-plugins/fabrika/skills/write-pattern/contract.md).
The read verbs inspect a fetched base; the authoring verbs write the current working tree.

## The `plan` group

Check an epic plan and admit its children for construction. Use `plan --help` and the
[plan-gate contract](../../../claude-plugins/fabrika/skills/check-epic-plan/contract.md).

## The `recipe` group

Apply the supported driver repairs and map their results to workflow events. Use `recipe --help`
for command details and the [operator skill](../../../claude-plugins/fabrika/skills/operate/SKILL.md)
for when to apply a recipe.

## The `report` group

File an observation for later triage, check for an existing report, or append to one. Use
`report --help` and the [report contract](../../../claude-plugins/fabrika/skills/report/contract.md).

## The `review` group

Read a text change and its acceptance criteria, then post a judgment tied to that version.
Use `review --help` and the [review contract](../../../claude-plugins/fabrika/skills/review/contract.md).

## The `review-ui` group

Capture rendered pages and record a visual judgment tied to the PR's version. Use `review-ui --help`
and the [review-ui contract](../../../claude-plugins/fabrika/skills/review-ui/contract.md).

## The `ship` group

Read merge requirements and drive an approved PR through landing. Use `ship --help` and the
[ship contract](../../../claude-plugins/fabrika/skills/ship/contract.md).

For CI results, start with `ship checks --help`. Its contract section explains workflow coverage,
count derivation and waiting behavior; the
[ship skill](../../../claude-plugins/fabrika/skills/ship/SKILL.md) owns what to do with the answer.

## The `spend` group

Measure token spend from a transcript or aggregate recorded runs. Use `spend --help`.
The measurement definition is
[ADR 0112](../../../.decisions/0112-token-measurement-no-quality-compromise-methodology.md);
the [transcript reader](../src/spend/token-spend.ts) implements it.

### The spend ledger

Recorded measurements live in the gitignored `.fabrika/spend-ledger.jsonl`. There is no in-repo
producer today; an operator or another producer supplies the rows.
The [ledger module](../src/spend/ledger.ts) owns the stored row format and version handling.

```bash
node packages/fabrika-cli/src/bin.ts spend rollup
node packages/fabrika-cli/src/bin.ts spend rollup --since 2026-08-01 --until 2026-08-09
node packages/fabrika-cli/src/bin.ts spend rollup --json
```

Read `spend rollup --help` for the date-window rules and how the answer reports unread measurements.

## The `spike` group

Run throwaway code to answer one empirical question and preserve the result before disposing of
the workspace. Use `spike --help` and the
[prototyping contract](../../../claude-plugins/fabrika/skills/prototyping/contract.md).

## The `status` group

Read the board, settings and installed skill roster for a new session. Use `status --help` and the
[front-door contract](../../../claude-plugins/fabrika/skills/front-door/contract.md).

## The `triage` group

Turn an intake issue into work with a clear scope, home and audience. Use `triage --help` and the
[triage contract](../../../claude-plugins/fabrika/skills/triage/contract.md).

For an existing acceptance-criteria block with a damaged heading or list shape, see
`triage repair-criteria --help`. Content changes belong to the triage authoring flow.

## The `ui` group

Read design rules, capture a local build and compare it with a golden image. Use `ui --help` and
the [build-ui contract](../../../claude-plugins/fabrika/skills/build-ui/contract.md).
Construction claims and branches remain the `build` group's responsibility.

The [browser provisioner](../scripts/provision-browser.mjs) runs during installation.
For a managed browser installation or a skipped install step, `ui render --help` is the caller's
starting point; an unavailable browser is diagnosed by the capture command.

## The `wire` group

Compose and read the stored text formats commands share. Use `wire --help` and the
[format reference](../../../claude-plugins/fabrika/docs/wire-formats.md).
The [registry](../src/wire/registry.ts) owns the format list; each format module owns its parsing
and serialization rules.

The acceptance-criteria writer can feed its checker directly:

```bash
printf 'the read is total\n[x] the registry is the seam\n' \
  | node packages/fabrika-cli/src/bin.ts wire emit --format acceptance-criteria \
  | node packages/fabrika-cli/src/bin.ts wire check --format acceptance-criteria
```

## The capture machinery

A library subpath, `@kampus/fabrika-cli/capture`, used by `ui` and `review-ui` for screenshots,
golden images and image comparisons. Its [own README](../src/capture/README.md) documents the library.

```ts
import {captureAndUpload, diffRasters, loadGoldenPointer} from "@kampus/fabrika-cli/capture";
```

Golden images and their storage credentials belong to the consuming repository.
Storage is injected through `StoreLeg`; the package ships the capture code.
Installing the package also installs `@playwright/test`; browser provisioning is described under
[the ui group](#the-ui-group).
