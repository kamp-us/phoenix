/**
 * The `lane` verb group — `fabrika lane <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flags (`--help` is the interface,
 * so each carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision lives in the verb modules beside it, which is what makes each refusal testable without
 * spawning a process.
 */
import {fileURLToPath} from "node:url";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runBrief} from "./brief-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {runHistory} from "./history-verb.ts";
import {type LaneKey, laneRef, parseKey, templateFile} from "./key.ts";
import {runOpen} from "./open-verb.ts";
import {runPrint} from "./print-verb.ts";
import {runProve} from "./prove-verb.ts";
import {keyRefusal} from "./refusals.ts";
import {DEFAULT_STALE_MINUTES} from "./stale.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT, type LaneRef} from "./store.ts";
import {runTransition} from "./transition-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const laneArgument = Argument.string("lane").pipe(
	Argument.withDescription(
		"the lane key — the issue number the lane drives, or `chore:<name>` for a chore lane",
	),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		`the lanes root directory (default: ${DEFAULT_LANES_ROOT}, or ${DEFAULT_CHORES_ROOT} for a chore key)`,
	),
);

/**
 * Resolve the `lane` argument to a key and its directory, or refuse it — the one step every keyed
 * verb shares, so a malformed key is caught before any verb reads or writes anything.
 */
const onKey = <R>(
	raw: string,
	root: Option.Option<string>,
	run: (key: LaneKey, ref: LaneRef) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R> => {
	const parsed = parseKey(raw);
	return parsed._tag === "Malformed"
		? Effect.succeed(keyRefusal(parsed))
		: run(parsed.key, laneRef(parsed.key, Option.getOrNull(root)));
};

const status = leafCommand(
	"status",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey(lane, root, (_key, ref) => runStatus(ref)));
	}),
).pipe(
	Command.withShortDescription("One lane's derived state, folded fresh from its event log."),
	Command.withDescription(
		"One lane's derived state, folded fresh from the whole events.jsonl every invocation — no resident process, no snapshot. stdout is the operator's status JSON: compound `stateValue` (active phase → per-task leaf state, future phases \"waiting\", or a bare terminal), `status` active/done, and per-task `{retries, maxRetries, …}` context with the tripped tasks in `errors`. Exits 4 (workflow.json or events.jsonl read in full and not the shape — every defect on stderr), 7 (no lane there — copy a workflow template to open it), 11 (the lane could not be read — its state is UNKNOWN, never fresh), 21 (the key is not a lane key). Examples: fabrika lane status 5673 · fabrika lane status chore:park-sweep",
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
			yield* onKey(lane, root, (_key, ref) =>
				runTransition({...ref, event, task: Option.getOrNull(task)}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Record one operator event, refusing an invalid one unappended."),
	Command.withDescription(
		"Record one operator event on the lane's append-only log — after the machine accepts it, never before. stdout is `{previous, event, current, taskAffected}` with the two stateValues around the fold. An invalid event — no cell in the task's current state (tea's NoCellError, surfaced verbatim), outside the operator's six, a task outside the active phase, a finished workflow — is refused loudly and the log is left byte-identical. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (the lane could not be read), 12 (the event is refused, log unappended), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 21 (the key is not a lane key). Example: fabrika lane transition 5673 DONE",
	),
);

const prove = leafCommand(
	"prove",
	{
		lane: laneArgument,
		event: Argument.string("event").pipe(
			Argument.withDescription("the operator event about to be recorded"),
		),
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task the event addresses; omittable on a single-task lane"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, event, root, task, repo}) {
		yield* emit(
			yield* onKey(lane, root, (_key, ref) =>
				runProve({
					...ref,
					event,
					task: Option.getOrNull(task),
					repo: Option.getOrNull(repo),
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Prove a lane event against the board before recording it."),
	Command.withDescription(
		"Read the artifact a lane event claims — artifacts over self-reports, the rule the retired epic conductor held against a conducted branch. Two events carry a claim, and which artifact answers them is the task's shape. On a single-issue lane and on an epic run's tail: a DONE out of `build` claims an open PR whose body links the task's issue (or, for an investigation, the diagnosis comment a no-PR builder posted since the task entered build), and a PASS out of `review` claims a current-head verdict in every namespace that PR's diff derives, governance included. On an epic run's child, which opens no PR at all (ADR 0285): a DONE out of `build` claims the commits its lane branch adds over `epic/<n>` in THIS tree, and a PASS out of `review` claims a range-scoped verdict on the child issue still bound to the content that range carries now (ADR 0276). Every other event answers `not-required` at exit 0. Writes nothing — the append stays `lane transition`'s. The refusals are artifact-independent, so the range arms take no new seat. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (a lane, board or tree read failed — the proof is UNKNOWN, never proven; an epic branch this tree does not carry is UNKNOWN too), 13 (the task is not in the machine, or names no issue), 21 (the key is not a lane key), 22 (the artifact is provably not there), 23 (a required namespace has no current or still-binding verdict — re-read, record nothing), 24 (a FAIL under a claimed PASS), 25 (several open PRs link the issue, or several lane branches carry the child's commits). Example: fabrika lane prove 5673 DONE",
	),
);

const history = leafCommand(
	"history",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey(lane, root, (_key, ref) => runHistory(ref)));
	}),
).pipe(
	Command.withShortDescription("The lane's append-only event log, verbatim."),
	Command.withDescription(
		"The lane's append-only event log, verbatim — one `{task, event, at}` per recorded event, in append order; the log IS the history, and `from`/`to` are reconstructible by folding, never stored. A lane with no events yet answers `[]`. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key). Example: fabrika lane history 5673",
	),
);

const print = leafCommand(
	"print",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey(lane, root, (_key, ref) => runPrint(ref)));
	}),
).pipe(
	Command.withShortDescription("The lane's compiled machine topology, as data."),
	Command.withDescription(
		"The lane's compiled machine topology — phases in order, the two workflow terminals, and per task its initial state, retry budget, and each state's legal events (everything absent refuses at transition time). Exits 4 (workflow.json read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key). Example: fabrika lane print 5673",
	),
);

const templatePath = (key: LaneKey): string =>
	fileURLToPath(new URL(`./templates/${templateFile(key)}`, import.meta.url));

const open = leafCommand(
	"open",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(
			yield* onKey(lane, root, (key, ref) => runOpen({...ref, templatePath: templatePath(key)})),
		);
	}),
).pipe(
	Command.withShortDescription("Boot a lane from the committed template its key selects."),
	Command.withDescription(
		"Boot one lane: create `<root>/<key>/` and place a byte-identical copy of the committed template the key selects as its workflow.json — the coder template for an issue number, the chore template for a `chore:<name>` key. An existing lane dir is refused loudly with nothing written — resuming needs no boot, and overwriting a machine mid-drive would corrupt a live fold. Exits 8 (the write did not land — the lane is NOT booted), 11 (the template or the lane dir's existence could not be read — UNKNOWN, never a boot), 14 (the lane already exists), 21 (the key is not a lane key). Examples: fabrika lane open 5673 · fabrika lane open chore:park-sweep",
	),
);

const emitLane = leafCommand(
	"emit",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the type:epic issue whose plan topology becomes the machine"),
		),
		root: rootFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({epic, root, repo}) {
		yield* emit(
			yield* runEmit({
				epic,
				root: Option.getOrNull(root) ?? DEFAULT_LANES_ROOT,
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Generate an epic's lane machine from its board topology."),
	Command.withDescription(
		"Generate a lane machine from the epic's board state: read the epic body's `## Dependencies` topology (the shape `ledger topology` stages) and emit `<root>/<epic>/workflow.json` — one region per child in the coder template's exact shape, phase-sequenced, parallel within a phase. A closed child boots its region in a final state (`completed` → `shipped`, any other close → `frozen`), so a partly-built epic's machine can still terminate. Deterministic: the same epic body bytes and the same child links (number, state and close reason per child) emit the same machine bytes. Exits 4 (the topology was read in full and does not parse — the defective line, duplicate placement or unplaced requires subject is named), 7 (the epic is proven absent or closed), 8 (the write did not land), 11 (the epic, its child list or the lane dir could not be read — UNKNOWN), 14 (the lane already exists — remove it to regenerate), 15 (no `## Dependencies` topology — plan the epic first), 16 (the topology references a non-child, named), 17 (the topology holds a cycle, path named). Example: fabrika lane emit 5680",
	),
);

const brief = leafCommand(
	"brief",
	{
		lane: laneArgument,
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task to brief; omittable on a single-task lane"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, task, repo}) {
		yield* emit(
			yield* onKey(lane, root, (_key, ref) =>
				runBrief({
					...ref,
					task: Option.getOrNull(task),
					repo: Option.getOrNull(repo),
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("The spawn prompt for one task's current leaf state."),
	Command.withDescription(
		"Print the spawn prompt for one task's current leaf state, folded fresh from the ledger — so a driver pastes a brief rather than composing one. stdout is the `lane-brief` wire format: which lane, task, state and shell, the resolved issue and PR URLs (URLs only — the spawned shell re-reads its own ground), and the format's byte-fixed rules. On an epic lane a child's state resolves no PR at all and briefs the epic issue, the epic branch and the range to judge, while the tail task briefs the run's single PR under the same refusals (ADR 0285). Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane, the issue or its PRs could not be read — UNKNOWN), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 18 (the leaf state routes to no shell — `queued`, `blocked`, `human:*`, a final), 19 (neither the task nor the lane names an issue, or that issue is proven absent), 20 (zero open PRs where the state needs one, or several where one is required), 21 (the key is not a lane key). Example: fabrika lane brief 5680 --task issue_5729",
	),
);

const stale = leafCommand(
	"stale",
	{
		root: rootFlag,
		olderThan: Flag.integer("older-than").pipe(
			Flag.optional,
			Flag.withDescription(
				`minutes of silence before a lane something is owed on is stale (default: ${DEFAULT_STALE_MINUTES})`,
			),
		),
	},
	Effect.fn(function* ({root, olderThan}) {
		yield* emit(
			yield* runStale({
				roots: Option.match(root, {
					onNone: () => [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT],
					onSome: (only) => [only],
				}),
				olderThanMinutes: Option.getOrElse(olderThan, () => DEFAULT_STALE_MINUTES),
				now: new Date().toISOString(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Which lanes have gone quiet with something owed on them."),
	Command.withDescription(
		`Sweep every lane on disk and answer which ones nothing is driving. A lane's ledger records state, not liveness, so a shell that dies leaves the lane reading active forever (#5897); the age here comes off the \`at\` every event line already carries — nothing new is stored. stdout is {now, olderThanMinutes, scanned, summary, lanes}, oldest silence first, each lane carrying its folded stateValue, its last event's timestamp, its age in minutes and one verdict: "stale" (non-terminal, unparked and silent past the threshold), "moving", "parked" (blocked or a human:* hold — a park is meant to sit), "terminal", "unstarted" (a lane with no events at all, so no age to judge) or "unreadable" (the lane is there and its record is not readable — it is reported, never dropped). Both default roots are swept unless --root names one; an absent root holds no lanes and is not a fault, and zero lanes is an empty answer at exit 0. Stale lanes exit 0 too — this reports, it never resumes. Exits 1 (--older-than is not a non-negative number of minutes), 11 (a root is there and could not be listed — the lane set is UNKNOWN, never a short list). Examples: fabrika lane stale · fabrika lane stale --older-than 30`,
	),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([
		status,
		transition,
		prove,
		history,
		print,
		open,
		emitLane,
		brief,
		stale,
	]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's six events (#5673). A lane is keyed by the issue number it drives, or by name as `chore:<name>` for a chore that has no issue number (#5840)",
	),
);
