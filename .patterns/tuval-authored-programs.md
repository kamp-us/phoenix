# Authoring a Tuval program

How a program is written with `defineProgram`, and what a compiled row still owes the kernel that
the authoring layer does not write for you. Everything here is `apps/tuval/src/authoring/`; the row
it compiles to is [`registry/program.ts`](../packages/tuval/src/registry/program.ts), and where a
program's Effects live is [`tuval-program-row-effects.md`](./tuval-program-row-effects.md) — this
doc is the layer above it.

The worked example is
[`authoring/example/pr-review.ts`](../apps/tuval/src/authoring/example/pr-review.ts), thirty-odd
lines end to end. Copy that first; read this when the copy runs out.

## What you write, and what compiles

`defineProgram` takes an authored record and answers one registry row. Each field of the record is
compiled by one entry of `FIELD_COMPILERS` in
[`define-program.ts`](../packages/tuval/src/authoring/define-program.ts), one row field per key:

| You write | The row gets | Module |
|---|---|---|
| `ports` | `ports` + a `receive` per arriving port | [`port.ts`](../packages/tuval/src/authoring/port.ts) |
| `init` / `update` / `subs` | `core` (a Demlik machine) | `define-program.ts` |
| effects returned from `update` | `handlers` | [`effect.ts`](../packages/tuval/src/authoring/effect.ts) |
| `args` | `args` | [`args.ts`](../packages/tuval/src/authoring/args.ts) |
| `commands` | `spells` | [`commands.ts`](../packages/tuval/src/authoring/commands.ts) |
| `key` cell in `update` | `takesKeys` | [`keys.ts`](../packages/tuval/src/authoring/keys.ts) |
| `title` / `status` | the two self-report out-ports | [`view.ts`](../packages/tuval/src/authoring/view.ts) |
| `renderer` | `renderer` — a module specifier, straight through | [`define-program.ts`](../packages/tuval/src/authoring/define-program.ts) |
| `resume` | `resume` | [`resume.ts`](../packages/tuval/src/authoring/resume.ts) |

The row is a plain object, so **anything the table above does not cover is reached by spreading the
compiled row**: `{...defineProgram({...}), restorable, checkpointWorthy, configChanged}`.

## Giving a program a window

**A window is a separate browser module, named on the row by module specifier, and there is no
other way.** `defineProgram` is compiled by Node inside the kernel process, and the desk is a
browser tab that can reach nothing it compiled — so a program declaring its window inline never
painted from a config, and the key that let one try is gone
([#8946](https://github.com/kamp-us/phoenix/issues/8946),
[ADR 0359](../.decisions/0359-tuval-window-renderer-is-a-module-specifier.md)).

```ts
// counter-state.ts — a leaf: it imports nothing, and both halves below import it.
export type CounterState = {readonly count: number};
export const isCounterState = (value: unknown): value is CounterState => /* … */ true;

// counter.ts — the program. Reaches the kernel, and that is fine: the page never loads it.
export const counterProgram = program({
	id: "counter",
	init: (): CounterState => ({count: 0}),
	update: {bump: (state: CounterState) => [{count: state.count + 1}, []]},
	renderer: {kind: "module", ref: "@you/counter/window"},
});

// window.tsx — the module the page imports. `default` is the renderer, `admits` the predicate.
import type {ProgramEvent} from "@kampus/tuval-sdk/window";
import {windowRenderer, type WindowHost} from "@kampus/tuval-sdk/window";
import {type CounterState, isCounterState} from "./counter-state.ts";
import type {counterProgram} from "./counter.ts"; // types only — erased by the bundler

export const admits = isCounterState;
type Event = ProgramEvent<Record<string, never>, (typeof counterProgram)["update"]>;
export default windowRenderer("module", (host: WindowHost<CounterState, Event>) => /* … */ null);
```

`ref` is the window's own package entry for an installed program, resolved from the config module
that declared the row (#8262), or a root-relative path for a module in this tree
(`/src/demo/module-window.tsx`).

**A window shares state with its program two ways, and both are in the block above.** A value the
window needs at runtime — a predicate, a view function, an event constructor — lives in a leaf file
that imports nothing, and both halves import that. A *type* crosses by `import type`, which a
bundler erases before it can follow anything. What a window must never do is import its program's
file for a value: that file calls `defineProgram`, whose graph reaches `node:crypto`, and Vite
externalizes the builtin so the first property read throws where the window should be.

The worked shape in this tree is
[`demo/module-counter.ts`](../apps/tuval/src/demo/module-counter.ts) with
[`demo/module-window.tsx`](../apps/tuval/src/demo/module-window.tsx) over
[`demo/counter-state.ts`](../apps/tuval/src/demo/counter-state.ts);
`apps/tuval/src/page/boundary.unit.test.ts` walks every in-tree window module at each run, so
breaking the rule reds a test rather than a browser tab. A package's own window carries its own
walk beside its own source — `packages/tuval-notify/src/state.unit.test.ts` is the shape.

## The two lifecycle fields, and why they are written differently

A restart touches an authored program twice, and the two halves land on opposite sides of that line.

**`resume` is sugared.** It reads the checkpointed state and answers events the author's own
`update` already holds cells for, so there is nothing in it the layer would have to hide:

```ts
defineProgram({
	id: "pr-review",
	ports: {verdict: port.out(Schema.String)},
	init: (): State => ({verdict: null}),
	update: {
		republish: (s: State): Answer<State> => [s, [emit("verdict", s.verdict ?? "")]],
	},
	resume: (s: State) => (s.verdict === null ? [] : [{type: "republish" as const}]),
});
```

This matters more than it looks: a restored process starts on its loaded state **with no Cmds** —
Demlik refuses a rehydrating `init` that emits — so `resume` is the only door an authored program
has back into the world after a restart, and
[#7877](https://github.com/kamp-us/phoenix/issues/7877) is what a missing one costs. A state with
nothing to resume answers with the empty list; an author who declares no `resume` leaves the field
off the row entirely.

**`configChanged` stays a spread.** Its argument is the *replacement registry row*, which is the
shape the whole authoring layer exists to keep out of an author's file, and there is nothing honest
to hand them in its place until a program can read another generation's args as args:

```ts
type Row = AnyProgram & {readonly reviewing: number};

export const prReviewRow: Row = {
	...prReview({reviewer}),
	reviewing: declared.reviewing,
	configChanged: (next: AnyProgram) =>
		(next as Row).reviewing === declared.reviewing
			? []
			: [{type: "pr", payload: (next as Row).reviewing}],
};
```

A re-read config reaches a live process through this and nothing else
([`reload.ts`](../apps/tuval/src/reload.ts), #7509 ruling 3): nothing restarts, nothing respawns,
and a row that answers `[]` leaves its process untouched. Whatever the process was already holding
it keeps — the change is an ordinary event, not a reset.

## Which ports a restored process still has

Two spawners bring a process back, and they wire it differently. Read
[`launch/launch.ts`](../apps/tuval/src/launch/launch.ts) and
[`durability/restore.ts`](../packages/tuval/src/durability/restore.ts) for the two halves:

- **A graph node** whose checkpoint existed comes back through `launch`, with the graph's wiring
  bound to it both ways. What it emits reaches the route the config plans, exactly as before the
  restart.
- **A process the graph does not plan** — one a `spawn` effect started — comes back through
  `restore`, and the graph owns no route for it, so it is handed an **`unwired`** `ProcessPorts`
  (#7789). It comes back either way; an emit fails `PortNotWired` at the first call, naming the
  port, rather than dropping the payload.

So a `resume` that emits is safe on a graph node and loud on a spawned child. That is deliberate —
the alternative was a silent no-op — but it means a spawned child's `resume` should move state or
send, not announce.

`authoring/reload/authoring-reload.integration.test.ts` is both halves on a real kernel: the
example's `verdict` route reaching its reader after a restart, and a restored spawned child's emit
refused with the port named.

## Wiring one into a config graph

Two authored programs route to each other directly. `portKind` still derives each port's `kind`
from the declaring program's id, so two authored ends never share one — and that no longer decides
anything, because `ports/compile.ts` compiles a route on **payload fit** whenever both ends publish
a schema, which every authored port does: `port.in`, `port.out` and `port.request` are each
declared over an Effect `Schema`, and `compilePort` publishes it on the row. The relation is
`payloadFits` — exact structural equality of the two canonicalised JSON Schema documents, the same
relation that decides whether a program fills a `Program.shape` arg
([ADR 0395](../.decisions/0395-a-graph-route-compiles-on-payload-fit-not-on-kind.md),
[#8923](https://github.com/kamp-us/phoenix/issues/8923)).

Kinds are compared only when one of the two ends publishes no schema — a hand-written registry row
such as [`ai-agent/ports/ports.ts`](../packages/tuval/src/ai-agent/ports/ports.ts)'s three two-way kinds
— and then they must be identical, exactly as before. Either way the refusal happens before boot:
`IncompatibleRoute` names both ends and a `reason` saying which clause refused and why.

[`authoring/reload/fixtures/reviewing-desk.ts`](../apps/tuval/src/authoring/reload/fixtures/reviewing-desk.ts)
is the worked wiring — `desk.pr -> pr-review.pr` and `pr-review.verdict -> sink.verdict`, every end
authored, no plain registry row standing in for one.

## One gap to know before you wire one

It bites at the seam where a shaped arg meets the registry, and its workaround looks like a mistake
if you meet it cold:

- **A shaped arg's `spawn` resolves the arg's own service key through the registry**, not a filled
  program id, so `spawn(args.reviewer, …)` only lands if something is registered under
  `tuval/arg/<program>/<arg>`. [#8762](https://github.com/kamp-us/phoenix/issues/8762) carries it.

## Testing one

Two tiers, and they answer different questions:

- **Unit** — [`testProgram`](../packages/tuval/src/authoring/test-program.ts) drives an authored program
  with no kernel, no desk and no Effect runtime: `testProgram(prReview).send("pr", 8690)` answers
  the new state and the effects it asked for. Use it for everything about the program's own logic.
- **Integration** — boot a config layer over a temp project directory and drive the real kernel.
  Reach for this only when the claim is about a seam the program does not own: the reload path, the
  checkpoint path, the wiring. The shape is
  [`reload-proof.unit.test.ts`](../apps/tuval/src/reload-proof.unit.test.ts)'s: the config layer
  reads its generation out of a JSON file the test rewrites between loads, so a second load is a
  genuinely different config rather than a second call over one.
