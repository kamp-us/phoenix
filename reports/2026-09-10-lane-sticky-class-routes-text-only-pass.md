# A lane's sticky `ui` class routes a text-only `PASS` into `review:ui`

Finding for investigation [#8000](https://github.com/kamp-us/phoenix/issues/8000), which reported
three lanes (7882, 7989, 7983) whose text-only pull request folded from `review` into `review:ui`
instead of `ship`, on a `PASS` recorded with no `--class` flag.

The guard is not defaulting true and reads nothing outside the lane. It reads
[`TaskState.classes`](../packages/fabrika-cli/src/lane/machine.ts), which is sticky, and `ui` was
already standing there.

## The path, named

Three sites, in the order the value travels:

| Site | What it does |
|---|---|
| [`lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts), `classesForEvent` | An empty `--class` answers `classes: null`, and [`report-verb.ts`](../packages/fabrika-cli/src/lane/report-verb.ts) omits the field from the appended line. |
| [`lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts), `withPayload` | `msg.classes === undefined` leaves the standing set alone. An omitted field means "no opinion", not "no class". |
| [`lane/machine.ts`](../packages/fabrika-cli/src/lane/machine.ts), the `class:<name>` cell in `compileRegion` | `c.classes.includes("ui")` picks the `review:ui` arm off that standing set, never off the head. |

Two things put `ui` into the standing set, and only one of them writes an event line:

- **An event that carried `--class ui`.** `lane report` and `lane transition` are the only verbs
  that write the field. This is the path
  [the third comment on #8000](https://github.com/kamp-us/phoenix/issues/8000#issuecomment-5555545534)
  records for lane 7983: its `ISSUE.WIP` carried `classes: ["ui"]`, because
  [`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) tells the driver to relay the
  ticket's class there.
- **The lane document's own seed.** `lane open` reads the issue's `class:ui` label and writes
  `context.<task>.classes` through
  [`class-seed.ts`](../packages/fabrika-cli/src/lane/class-seed.ts), and the compiler seats that as
  the task's initial `classes`. Every event line is then classless and the lane still routes `ui`.

## Reproduced

Driving the committed
[`coder.workflow.json`](../packages/fabrika-cli/src/lane/templates/coder.workflow.json) through
`applyEvent`, one row per starting condition:

| Lane | `WIP` | `DONE` | `PASS` (no `--class`) |
|---|---|---|---|
| No class anywhere | `build` | `review` | **`ship`** |
| `WIP` carried `--class ui` | `build:ui` | `review` | **`review:ui`** |
| Document seeded `["ui"]`, no class on any line | `build:ui` | `review` | **`review:ui`** |
| Document seeded `["ui"]`, `PASS` carried `--class code` | `build:ui` | `review` | **`ship`** |

The last row is the part nothing in the pipeline uses: a `PASS` carrying the head's own derived
class set *replaces* the standing one, and a text-only head then walks to `ship` with no machine
change. Rows 3 and 4 are pinned in
[`machine.unit.test.ts`](../packages/fabrika-cli/src/lane/machine.unit.test.ts); row 2 was already
pinned there and row 1 is the report's own control.

## What the filer could not see

Row 1 is why #8000's body reports the two observations as unreproducible: a lane with no class in
its document and none on any line routes to `ship`, and the filer read the *committed* template's
`"classes": []` rather than lane 7882's own `workflow.json` context.

The document seed did not exist on 2026-09-05, when 7882 and 7989 were observed — it landed
2026-09-10 with [#9137](https://github.com/kamp-us/phoenix/pull/9137). So on that date the only
producer was an event line, which is exactly what lane 7983's comment shows. Whether 7882 and 7989
also carried one cannot be settled: both ledgers are machine-local and gone. What is settled is that
the symptom needs no unexplained mechanism — two ordinary paths produce it, and both are reproduced
above.

Going forward the seed is the more common of the two, because `triage apply --class ui` on a ticket
is all it takes.

## ADR 0317's stickiness is the mechanism, and it is doing its job

[ADR 0317](../.decisions/0317-ui-lane-carries-its-own-shells.md) puts the UI-ness on the lane state
because a `build` state has no pull request, so there is no diff to classify from when the build
shell is chosen. Stickiness is what carries that early read forward. Take it away and the first-pass
`build:ui` route — the failure 0317 opens by naming — comes back.

So the sticky rule is not wrong; it is under-specified at one boundary. Once the `PASS` exists there
*is* a head, and `review scope` has derived the class set from it. At that point the ticket-time
read and the head-time read are two different facts, and the machine has only one field.

The two contracts have already picked opposite sides of it.
[`operate`](../claude-plugins/fabrika/skills/operate/SKILL.md) says the class "stands from there —
the `PASS` out of `review` routes to `review:ui` without you naming it again."
[`review`](../claude-plugins/fabrika/skills/review/SKILL.md) says to pass `--class ui` "only when §1
printed a `routed	review-ui` row, and never otherwise". A `class:ui` ticket with a text-only fix
satisfies both and still takes the rendered arm — the reviewer omits the flag by instruction, not by
mistake.

Narrowing it is a decision, not a defect fix: it changes what an absent `--class` means, and every
caller of `lane report` reads that. It is filed as
[#9169](https://github.com/kamp-us/phoenix/issues/9169).

## Its relationship to #6768

Independent causes; one of them now feeds the other.

[#6768](https://github.com/kamp-us/phoenix/issues/6768) was the mirror image — the seed field had no
producer, so a rendered lane's *first* build ran in the plain builder. Its fix (#9137, 2026-09-10)
added the producer. That does not explain #8000: lane 7983's class arrived on an event line, and
lanes 7882 and 7989 predate the producer entirely.

What the fix does is make #8000's symptom more reachable. Before it, only a driver passing
`--class ui` could put the class on a lane; after it, a `class:ui` label does, on every lane, with
nothing in the event log to show for it. The two findings constrain each other in exactly the way
#8000 guessed: closing one widened the other.
