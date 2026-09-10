# Authoring a Tuval program

How a program is written with `defineProgram`, and what a compiled row still owes the kernel that
the authoring layer does not write for you. Everything here is `apps/tuval/src/authoring/`; the row
it compiles to is [`registry/program.ts`](../apps/tuval/src/registry/program.ts), and where a
program's Effects live is [`tuval-program-row-effects.md`](./tuval-program-row-effects.md) — this
doc is the layer above it.

The worked example is
[`authoring/example/pr-review.ts`](../apps/tuval/src/authoring/example/pr-review.ts), thirty-odd
lines end to end. Copy that first; read this when the copy runs out.

## What you write, and what compiles

`defineProgram` takes an authored record and answers one registry row. Each field of the record is
compiled by one entry of `FIELD_COMPILERS` in
[`define-program.ts`](../apps/tuval/src/authoring/define-program.ts), one row field per key:

| You write | The row gets | Module |
|---|---|---|
| `ports` | `ports` + a `receive` per arriving port | [`port.ts`](../apps/tuval/src/authoring/port.ts) |
| `init` / `update` / `subs` | `core` (a Demlik machine) | `define-program.ts` |
| effects returned from `update` | `handlers` | [`effect.ts`](../apps/tuval/src/authoring/effect.ts) |
| `args` | `args` | [`args.ts`](../apps/tuval/src/authoring/args.ts) |
| `commands` | `spells` | [`commands.ts`](../apps/tuval/src/authoring/commands.ts) |
| `key` cell in `update` | `takesKeys` | [`keys.ts`](../apps/tuval/src/authoring/keys.ts) |
| `title` / `status` / `window` | `renderer` + the self-report out-ports | [`view.ts`](../apps/tuval/src/authoring/view.ts) |
| `resume` | `resume` | [`resume.ts`](../apps/tuval/src/authoring/resume.ts) |

The row is a plain object, so **anything the table above does not cover is reached by spreading the
compiled row**: `{...defineProgram({...}), restorable, checkpointWorthy, configChanged}`.

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
[`durability/restore.ts`](../apps/tuval/src/durability/restore.ts) for the two halves:

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

## Two gaps to know before you wire one

Both bite at the seams where authored programs meet each other, and both have workarounds that look
like mistakes if you meet them cold:

- **A shaped arg's `spawn` resolves the arg's own service key through the registry**, not a filled
  program id, so `spawn(args.reviewer, …)` only lands if something is registered under
  `tuval/arg/<program>/<arg>`. [#8762](https://github.com/kamp-us/phoenix/issues/8762) carries it.
- **Two authored programs cannot be routed to each other in a config graph.** `portKind` derives a
  port's `kind` from the declaring program's id, and `ports/compile.ts` compiles a route only when
  both ends' kinds are identical, so an authored `a.out` can never reach an authored `b.in`. Until
  [#8923](https://github.com/kamp-us/phoenix/issues/8923) lands, the other end is a plain registry
  row hand-declaring the authored program's own kind.

## Testing one

Two tiers, and they answer different questions:

- **Unit** — [`testProgram`](../apps/tuval/src/authoring/test-program.ts) drives an authored program
  with no kernel, no desk and no Effect runtime: `testProgram(prReview).send("pr", 8690)` answers
  the new state and the effects it asked for. Use it for everything about the program's own logic.
- **Integration** — boot a config layer over a temp project directory and drive the real kernel.
  Reach for this only when the claim is about a seam the program does not own: the reload path, the
  checkpoint path, the wiring. The shape is
  [`reload-proof.unit.test.ts`](../apps/tuval/src/reload-proof.unit.test.ts)'s: the config layer
  reads its generation out of a JSON file the test rewrites between loads, so a second load is a
  genuinely different config rather than a second call over one.
