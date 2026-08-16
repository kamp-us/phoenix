/**
 * The `lane` verb group — `fabrika lane <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flags (`--help` is the interface,
 * so each carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision lives in the verb modules beside it, which is what makes each refusal testable without
 * spawning a process.
 */
import {Effect} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runHistory} from "./history-verb.ts";
import {runPrint} from "./print-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";
import {runTransition} from "./transition-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const laneArgument = Argument.string("lane").pipe(
	Argument.withDescription("the lane id under the root — by convention the issue number"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.withDefault(DEFAULT_LANES_ROOT),
	Flag.withDescription(`the lanes root directory (default: ${DEFAULT_LANES_ROOT})`),
);

const status = leafCommand(
	"status",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* runStatus({root, lane}));
	}),
).pipe(
	Command.withShortDescription("One lane's derived state, folded fresh from its event log."),
	Command.withDescription(
		"One lane's derived state, folded fresh from the whole events.jsonl every invocation — no resident process, no snapshot. stdout is the operator's status JSON: compound `stateValue` (active phase → per-task leaf state, future phases \"waiting\", or a bare terminal), `status` active/done, and per-task `{retries, maxRetries, …}` context with the tripped tasks in `errors`. Exits 4 (workflow.json or events.jsonl read in full and not the shape — every defect on stderr), 7 (no lane there — copy a workflow template to open it), 11 (the lane could not be read — its state is UNKNOWN, never fresh). Example: fabrika lane status 5673",
	),
);

const transition = leafCommand(
	"transition",
	{
		lane: laneArgument,
		event: Argument.string("event").pipe(
			Argument.withDescription("the operator event — DONE, PASS, FAIL, BLOCKED, WIP or UNBLOCKED"),
		),
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task the event addresses; omittable on a single-task lane"),
		),
	},
	Effect.fn(function* ({lane, event, root, task}) {
		yield* emit(
			yield* runTransition({
				root,
				lane,
				event,
				task: task._tag === "Some" ? task.value : null,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record one operator event, refusing an invalid one unappended."),
	Command.withDescription(
		"Record one operator event on the lane's append-only log — after the machine accepts it, never before. stdout is `{previous, event, current, taskAffected}` with the two stateValues around the fold. An invalid event — no cell in the task's current state (tea's NoCellError, surfaced verbatim), outside the operator's six, a task outside the active phase, a finished workflow — is refused loudly and the log is left byte-identical. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (the lane could not be read), 12 (the event is refused, log unappended), 13 (the task is not in the machine, or --task omitted on a multi-task lane). Example: fabrika lane transition 5673 DONE",
	),
);

const history = leafCommand(
	"history",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* runHistory({root, lane}));
	}),
).pipe(
	Command.withShortDescription("The lane's append-only event log, verbatim."),
	Command.withDescription(
		"The lane's append-only event log, verbatim — one `{task, event, at}` per recorded event, in append order; the log IS the history, and `from`/`to` are reconstructible by folding, never stored. A lane with no events yet answers `[]`. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane could not be read). Example: fabrika lane history 5673",
	),
);

const print = leafCommand(
	"print",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* runPrint({root, lane}));
	}),
).pipe(
	Command.withShortDescription("The lane's compiled machine topology, as data."),
	Command.withDescription(
		"The lane's compiled machine topology — phases in order, the two workflow terminals, and per task its initial state, retry budget, and each state's legal events (everything absent refuses at transition time). Exits 4 (workflow.json read in full and not the shape), 7 (no lane there), 11 (the lane could not be read). Example: fabrika lane print 5673",
	),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([status, transition, history, print]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's six events (#5673)",
	),
);
