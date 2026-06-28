# The dimension contract

This is the **extension point** of the rite-audit harness. A *dimension* is one self-contained
vertical of the audit — its surfaces, its explorer steps, and its pass/fail rubric — that runs
over the same provisioned stage and emits its own raw findings. The harness runs every registered
dimension and unions their findings; the verdict report (#1516) aggregates them into a dated
archive.

This file is the **contract** the dimensions plug into: the accessibility dimension (#1514) and
the sandbox-leak dimension (#1515) are written *to this spec* from this file alone, and #1516
reads the `Finding` / `DimensionResult` shapes defined here. It is the interface, not a
suggestion — keep it the single source of these shapes; do not redefine them per dimension.

## What a dimension declares (the four parts)

A dimension is one Markdown file, `dimensions/<id>.md`, that declares exactly four things:

1. **`id`** — a stable kebab-case identifier (`functional-rite`, `a11y`, `sandbox-leak`). This is
   the verdict key #1516 groups on and the value the SKILL.md *Active dimensions* table registers.
   It must equal the file's basename.
2. **`surfaces`** — the subset of the SKILL.md route map this dimension walks. Naming them up
   front bounds the dimension and lets a reader see its blast radius.
3. **`probe`** — the explorer steps it runs, each as `drive → observe`. These are instructions to
   the LLM driving the Playwright MCP, expressed against the **shared primitives** below — never
   re-deriving the run context, route map, or driver.
4. **`rubric`** — an **ordered list of named checks**. Each check is one falsifiable assertion and
   emits **exactly one** `Finding`. The check name is stable across runs so findings are
   comparable run-over-run (#1516 diffs on `dimension` + `check`).

## The shared primitives (consumed, never re-derived)

Every dimension consumes these from the harness — a dimension never re-implements them:

- **The run context** `{ baseUrl, testMod, stage, target }` — the `AuditRunInput` the
  `@kampus/audit-stage` lifecycle hands the run hook (#1512). The source of the stage URL and the
  minted test-mod. **A dimension must read these off the context, never hardcode a URL or
  credential** (the stage is ephemeral; a literal is stale next run).
- **The route map** — the canonical surface table in [`SKILL.md`](./SKILL.md). A dimension names
  the subset it walks; it does not restate paths.
- **The Playwright-MCP driver** — the browser tools, used per SKILL.md *Playwright MCP wiring*
  (navigate by `${baseUrl}<path>`, anchor on `data-testid`, one context per identity,
  observe-before-assert).
- **The `Finding` record + the record-don't-judge rule** — defined below; identical for every
  dimension.

## The `Finding` record (the atom every check emits)

Each check emits exactly one `Finding`. This is the **raw** output the harness unions and hands
to #1516 — its fields are the contract #1516 structures and archives:

```ts
interface Finding {
  dimension: string;   // the dimension's id
  check: string;       // the rubric check name (stable across runs)
  surface: string;     // the route walked, or "n/a"
  status: "PASS" | "FAIL" | "BLOCKED";
  expected: string;    // what the rubric asserts should hold
  observed: string;    // what the explorer actually saw
  evidence: string;    // screenshot ref / selector / quoted text backing `observed`
}
```

### Status semantics — the story-11 invariant, shared by all dimensions

- **PASS** — the assertion held; the explorer observed the expected state.
- **FAIL** — the assertion was falsified; the transition is broken or the surface misbehaved.
- **BLOCKED** — the check **could not be evaluated**: a precondition transition failed, a surface
  404'd when it should have resolved, the driver could not reach the state, or the action produced
  no observable change. **BLOCKED is never a pass.** It rolls up as FAIL at the dimension level.

A check is **never** silently omitted and a "couldn't tell" is **never** recorded as PASS — the
audit exists to make a broken rite unmistakable (story 11). When the choice is between PASS and
BLOCKED, it is BLOCKED.

## The `DimensionResult` (what a dimension emits)

After running its rubric, a dimension emits:

```ts
interface DimensionResult {
  dimension: string;       // the id
  status: "PASS" | "FAIL"; // PASS iff EVERY finding is PASS; any FAIL or BLOCKED ⇒ FAIL
  findings: Finding[];     // one per rubric check, in rubric order
}
```

The roll-up rule is fixed and shared: **`status = PASS` iff every `Finding` is PASS; otherwise
FAIL** (a single FAIL or BLOCKED fails the dimension). #1516 may present per-check detail, but the
dimension's headline status is this roll-up.

## Running a dimension

The harness runs each active dimension over the *one* provisioned stage:

1. Load the dimension file; read its `surfaces`, `probe`, and `rubric`.
2. Walk its `probe` steps with the Playwright MCP, against the run context.
3. For each rubric check, `drive → observe → assert → record` one `Finding`.
4. Compute the `DimensionResult` roll-up and return it.

Dimensions are **independent** — order does not change any dimension's verdict — but they share
the single stage and the single self-registered çaylak the functional rite creates, so run the
functional rite first when a later dimension wants to observe its artifacts (e.g. sandbox-leak
inspecting the çaylak's sandboxed content). A dimension that needs its own fixture self-registers
it through the UI rather than depending on another dimension's state.

## Adding a dimension (the extension procedure)

To add the a11y (#1514) or sandbox-leak (#1515) dimension, or any future one:

1. **Write `dimensions/<id>.md`** declaring the four parts (`id`, `surfaces`, `probe`, `rubric`),
   consuming the shared primitives — do not redefine the `Finding`/`DimensionResult` shapes or the
   run context; reference them here.
2. **Register it** in the *Active dimensions* table in [`SKILL.md`](./SKILL.md) with its `id` and
   file, flipping its status from planned to active.
3. **Emit `Finding`s in the shape above**, with stable `check` names, so #1516 can aggregate and
   diff run-over-run with no per-dimension special-casing.

That is the whole interface: a new dimension is one file plus one table row. The harness loop,
the `Finding` shape, the roll-up rule, and the raw-findings hand-off to #1516 are unchanged by
adding one.
