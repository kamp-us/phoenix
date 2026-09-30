/**
 * The `lane` verb group — `fabrika lane <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flags (`--help` is the interface,
 * so each carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision lives in the verb modules beside it, which is what makes each refusal testable without
 * spawning a process.
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {Effect, type FileSystem, Option, Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {claimReader} from "../build/claimants-verb.ts";
import {claimStanding} from "../build/dead-claim.ts";
import {childLaneBranches} from "../build/lane.ts";
import {assemblyRefreshKey} from "../config/keys/assembly-refresh.ts";
import {laneConcurrencyCapKey} from "../config/keys/lane-concurrency-cap.ts";
import {machineryLapsKey} from "../config/keys/machinery-laps.ts";
import {parkCauseKey} from "../config/keys/park-cause.ts";
import {readKey} from "../config/read-key.ts";
import {resolveEntrypoint} from "../delegate/entrypoint.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {localBranches} from "../io/git.ts";
import {readStdin} from "../io/stdin.ts";
import {SHIP_CLASS_NAMES} from "../review/classes.ts";
import {sizeStopOnGitHub} from "../table/size-stop.ts";
import {runSync, syncBoard} from "../table/sync-verb.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {DEFAULT_ORIGIN, ORIGINS} from "../wire/lane-record.ts";
import {admitBoardKey, admitKey} from "./admission.ts";
import {claimOwnership, runAmend} from "./amend-verb.ts";
import {closedReader} from "./archive-move.ts";
import {runArchiveSweep} from "./archive-sweep-verb.ts";
import {boardClaimSeams, runArchive} from "./archive-verb.ts";
import {runAssemblyBody} from "./assembly-body-verb.ts";
import {FIELDS, runAssemblyPr} from "./assembly-pr-verb.ts";
import {runAssembly} from "./assembly-verb.ts";
import {runAttachIntegrate} from "./attach-integrate-verb.ts";
import {boardRecorder, boardSeatReader} from "./board-seat.ts";
import {runBrief} from "./brief-verb.ts";
import {claimHoldReader} from "./claim-hold.ts";
import {runLaneAdopt, runLaneClaim, runLaneRelease} from "./claim-verb.ts";
import {runClear} from "./clear-verb.ts";
import {closureReader} from "./closure.ts";
import {CLASS_UNRECOGNISED} from "./codes.ts";
import {runDispatch} from "./dispatch-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {expectationReader} from "./expectation.ts";
import {
	configRootOrRefuse,
	deriveRepoRoot,
	onGround,
	repoGroundRefusal,
	resolveRootOrRefuse,
} from "./ground.ts";
import {laneHelp, ROOT_EXITS} from "./help.ts";
import {runHistory} from "./history-verb.ts";
import {runIntegrate} from "./integrate-verb.ts";
import {
	archivedRoot,
	defaultRoot,
	keyIssue,
	type LaneKey,
	laneRef,
	parseKey,
	resolveKeyIssue,
	templateFile,
} from "./key.ts";
import {runMigrate} from "./migrate-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runPrint} from "./print-verb.ts";
import {priorLaneReader} from "./prior-lane.ts";
import {proveDispatched, runProve} from "./prove-verb.ts";
import {pullsReader} from "./pulls-reader.ts";
import {runPush} from "./push-verb.ts";
import {type ReconcileRoot, runReconcile} from "./reconcile-verb.ts";
import {LEDGER_SPEND} from "./record.ts";
import {recordBoard, runRecord} from "./record-verb.ts";
import {runRecover} from "./recover-verb.ts";
import {runRefresh} from "./refresh-verb.ts";
import {keyRefusal} from "./refusals.ts";
import {AXIS_ISSUE_CAUSES, classesForEvent, PARK_CAUSE_TOKENS} from "./report.ts";
import {runReport} from "./report-verb.ts";
import {runRetrigger} from "./retrigger-verb.ts";
import {runLaneScratch} from "./scratch-verb.ts";
import {runSeats} from "./seats-verb.ts";
import {boardReaders, runSettle} from "./settle-verb.ts";
import {BUILD_CLAIM_BUDGET_MINUTES, DISPATCH_BUDGET, SHELL_BUDGETS} from "./shell-budget.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {
	DEFAULT_ARCHIVED_LANES_ROOT,
	DEFAULT_CHORES_ROOT,
	DEFAULT_LANES_ROOT,
	type LaneRef,
} from "./store.ts";
import {runTransition} from "./transition-verb.ts";
import {runWait} from "./wait-verb.ts";

const laneArgument = Argument.string("lane").pipe(
	Argument.withDescription(
		"the lane key — the issue number the lane drives, or `chore:<name>` for a chore lane. A key is one directory leaf: a separator or a traversal is refused at 21 before any path is joined or any board read is sent. A padded number is canonicalized on read, so `05673` and `5673` name one lane, one claim target and one directory. A directory name carrying a dot-separated suffix after the number (`8012.frozen-deadlock-<stamp>`) still names issue 8012, so a quarantined lane is addressable by every verb here",
	),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		`the lanes root directory (default: the owning repository's ${DEFAULT_LANES_ROOT}, derived off the primary checkout so every worktree reads the same ledger; or ${DEFAULT_CHORES_ROOT} for a chore key). One that resolves inside a linked worktree is a copy of that ledger and is refused at 65, absolute or relative`,
	),
);

/** Seat the shared key admission at this process's cwd — the adapter's one job here. */
const onKey = <R>(
	verb: string,
	raw: string,
	root: Option.Option<string>,
	run: (key: LaneKey, ref: LaneRef) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	admitKey(verb, raw, Option.getOrNull(root), process.cwd(), run);

/** The same admission for a board-ground verb, which reaches no root at all. */
const onBoardKey = <R>(
	raw: string,
	run: (key: LaneKey) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R> => admitBoardKey(raw, run);

const dispatch = leafCommand(
	"dispatch",
	{
		lane: laneArgument,
		root: rootFlag,
		harness: Flag.string("harness").pipe(
			Flag.withDescription("dispatch adapter; codex is supported"),
		),
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("active lane task; required on multi-task lanes"),
		),
		skills: Flag.string("skills").pipe(
			Flag.withDescription("absolute installed Fabrika skills directory"),
		),
		worktree: Flag.string("worktree").pipe(
			Flag.withDescription(
				"absent absolute path outside the primary checkout; retained after dispatch",
			),
		),
	},
	Effect.fn(function* ({lane, root, harness, task, skills, worktree}) {
		const entrypoint = yield* resolveEntrypoint();
		yield* emit(
			yield* onKey("dispatch", lane, root, (_key, ref) =>
				runDispatch(
					{
						...ref,
						harness,
						task: Option.getOrNull(task),
						skills,
						worktree,
						cwd: process.cwd(),
						env: process.env,
						repo: null,
						entrypoint,
						sizeStop: sizeStopOnGitHub("fabrika lane brief", process.cwd()),
					},
					runBrief,
					proveDispatched,
					runRefresh,
				),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Dispatch one active lane task to Codex in a verified worktree."),
	Command.withDescription(
		laneHelp(
			"dispatch",
			"Runs one lane task under Codex in a fresh worktree and prints {harness, task, event, worktree}.",
			{
				11: "input, isolation, process or state failure",
				18: "unsupported harness or inactive state",
				22: "no unique new terminal",
				39: ROOT_EXITS[39],
				42: "assembly refresh conflicted, nothing created",
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{
			command:
				"fabrika lane dispatch 5673 --harness codex --skills /installed/fabrika/skills --worktree /scratch/lane-5673",
		},
	]),
);

const status = leafCommand(
	"status",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey("status", lane, root, (_key, ref) => runStatus(ref)));
	}),
).pipe(
	Command.withShortDescription("One lane's derived state, folded fresh from its event log."),
	Command.withDescription(
		laneHelp(
			"status",
			"Prints one lane's derived status JSON, folded fresh from its whole event log.",
			{
				4: "workflow.json or events.jsonl is not the shape",
				7: "no lane",
				11: "read failed, UNKNOWN",
				21: "bad key",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane status 5673"},
		{command: "fabrika lane status chore:park-sweep"},
	]),
);

/**
 * Why a lane parked, on the two verbs that can append a `BLOCKED` — the shell's `report` and the
 * driver's `transition`. Closed vocabulary, so the listing comes off the module that owns it.
 */
const causeFlag = Flag.string("cause").pipe(
	Flag.optional,
	Flag.withDescription(
		`why the lane parked, on a BLOCKED only — one of: ${PARK_CAUSE_TOKENS.join(", ")}. It is the key \`recipe unpark\` seats the park against, and each token carries a route (\`driver\` or \`founder\`) saying whose failure the park is. Omit it and the park stays novel and routes to a human — unless \`.fabrika.jsonc\` declares \`parkCause.uncaused: "refuse"\`, which refuses the cause-less park at exit 52 with the log unappended.`,
	),
);

/** The issue a `render-axis-missing` park waits on, on the same two verbs `--cause` rides. */
const axisIssueFlag = Flag.integer("axis-issue").pipe(
	Flag.optional,
	Flag.withDescription(
		`the open issue tracking the render axis this park waits on — required with --cause ${[...AXIS_ISSUE_CAUSES].join("/")} and refused with any other cause, both at exit 35 with the log unappended. \`recipe unpark\` reads it and clears the park once that issue is closed.`,
	),
);

/**
 * The lane classes standing at the event being recorded, on the same two appending verbs.
 *
 * Relayed from a shipped verb's answer, never derived by the caller — `ship scope` and
 * `review scope` name the classes a head raises, and before a head exists the class is the one the
 * lane document seeded. It rides the event line because that is where every other
 * observed-at-record-time fact rides, and because `lane prove`, the other candidate writer, writes
 * nothing by design.
 *
 * Validated against {@link SHIP_CLASS_NAMES} at the verb, not here: a bare string flag over a
 * routing table that falls through on a miss is a silent miss — `--class UI` would build a plain
 * lane and never ask for the rendered-visual verdict it owed.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9169#issuecomment-5688656577
 */
/**
 * Why a park was cleared, on the one verb a driver clears one from.
 *
 * Free prose rather than a closed vocabulary, and deliberately: a cause is a fact about machinery
 * that a recipe keys on, while a rationale is the judgment the driver made, which nothing downstream
 * routes on and only a reader consumes. The verb checks the one thing it can — that it says
 * something, on an event that is a clearance.
 */
const rationaleFlag = Flag.string("rationale").pipe(
	Flag.optional,
	Flag.withDescription(
		"why this park was cleared, on an UNBLOCKED only — the driver's own recommendation, recorded on the line that clears the park. It is what `recipe unpark` passes when it clears a driver-routed park, and what makes that clearance reviewable afterwards; a blank one is refused at exit 53 with the log unappended.",
	),
);

const classFlag = Flag.string("class").pipe(
	Flag.atLeast(0),
	Flag.withDescription(
		`a lane class standing at this event (repeatable) — the fact a \`class:<name>\` transition arm routes on, one of: ${SHIP_CLASS_NAMES.join(", ")}. Pass every class the head raises, because a non-empty set replaces the standing one outright and a class you leave off that set is cleared; omitting the flag entirely is the separate act that keeps what stands, and it belongs only before a head exists, where the lane document's seed is the whole answer. A spelling outside the set is refused, never routed as unclassed, and a standing class routing this event into a cell the head derives nothing for is refused at exit 67.`,
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
		cause: causeFlag,
		axisIssue: axisIssueFlag,
		classes: classFlag,
		grantWait: Flag.integer("grant-wait").pipe(
			Flag.optional,
			Flag.withDescription(
				"waits this resume grants, on an UNBLOCKED only — the human fallback for a `human:queue-stall` whose `recipe unpark` proving read cannot run. The grant rides this same line, so the clear and the budget are one recorded event.",
			),
		),
		rationale: rationaleFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name the proof reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({
		lane,
		event,
		root,
		task,
		cause,
		axisIssue,
		classes,
		grantWait,
		rationale,
		repo,
	}) {
		const configRoot = yield* configRootOrRefuse("fabrika lane transition", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const parkCause = yield* readKey(configRoot, parkCauseKey);
		yield* emit(
			yield* onKey("transition", lane, root, (_key, ref) =>
				runTransition(
					{
						...ref,
						event,
						task: Option.getOrNull(task),
						cause: Option.getOrNull(cause),
						axisIssue: Option.getOrNull(axisIssue),
						parkCause,
						classes,
						waitGrant: Option.getOrNull(grantWait),
						rationale: Option.getOrNull(rationale),
						repo: Option.getOrNull(repo),
						cwd: process.cwd(),
						env: process.env,
					},
					runProve,
				),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Record one operator event, proven first, refused unappended otherwise.",
	),
	Command.withDescription(
		laneHelp(
			"transition",
			"Records one proven operator event; prints {previous, event, current, taskAffected}.",
			{
				4: "bad lane record",
				7: "no lane",
				8: "not appended",
				11: "read failed, UNKNOWN",
				12: "event refused",
				13: "unknown task",
				21: "bad key",
				22: "no artifact",
				23: "no binding verdict",
				24: "FAIL or link stands",
				25: "ambiguous",
				35: "bad cause",
				36: "unbudgeted resume",
				38: "bad --class",
				40: "ledger lock held",
				47: "bad --grant-wait",
				52: "uncaused BLOCKED",
				53: "bad --rationale",
				67: "head derives no route",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane transition 5673 DONE"},
		{command: "fabrika lane transition 5673 UNBLOCKED --grant-wait 1"},
	]),
);

const attachIntegrate = leafCommand(
	"attach-integrate",
	{
		lane: laneArgument,
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription(
				"the epic child's task (issue_<n>) whose integrate FAIL takes the pair; omittable on a single-task lane",
			),
		),
		at: Flag.string("at").pipe(
			Flag.withDescription(
				"the `at` of the recorded integrate FAIL line the pair attaches to, exactly as `lane history` prints it",
			),
		),
		integrateExit: Flag.integer("integrate-exit").pipe(
			Flag.withDescription("the lane integrate exit that FAIL stood on: 42, 43 or 44"),
		),
		assemblyHead: Flag.string("assembly-head").pipe(
			Flag.withDescription("the assembly branch head that integrate FAIL was refused against"),
		),
	},
	Effect.fn(function* ({lane, root, task, at, integrateExit, assemblyHead}) {
		yield* emit(
			yield* onKey("attach-integrate", lane, root, (_key, ref) =>
				runAttachIntegrate({
					...ref,
					task: Option.getOrNull(task),
					at,
					integrateExit,
					assemblyHead,
					now: () => new Date(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Attach the exit and assembly head to a pair-less integrate FAIL."),
	Command.withDescription(
		laneHelp(
			"attach-integrate",
			"Appends a CORRECTED line pairing a pair-less integrate FAIL with its exit and head; prints JSON.",
			{
				4: "bad lane record, or the log does not replay",
				7: "no lane",
				8: "append unlanded, pair NOT attached",
				11: "read failed, UNKNOWN",
				13: "task not in the machine, or --task missing",
				21: "bad key",
				39: ROOT_EXITS[39],
				40: "ledger lock held",
				65: ROOT_EXITS[65],
				68: "that line may not take the pair, or it is malformed",
			},
		),
	),
	Command.withExamples([
		{
			command:
				"fabrika lane attach-integrate 900 --task issue_4312 --at 2026-09-20T18:04:11.000Z --integrate-exit 43 --assembly-head 03135b9",
		},
	]),
);

const clear = leafCommand(
	"clear",
	{
		lane: laneArgument,
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task the grant addresses; omittable on a single-task lane"),
		),
		rationale: Flag.string("rationale").pipe(
			Flag.withDescription(
				"why this round is granted — the driver's own recommendation, recorded on the CLEARED line AND posted on the lane's pull request as the grant's dated authorization. Required: a grant nobody can review afterwards is not one.",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name the PR-side half reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, task, rationale, repo}) {
		yield* emit(
			yield* onKey("clear", lane, root, (_key, ref) =>
				runClear({
					...ref,
					task: Option.getOrNull(task),
					rationale,
					repo: Option.getOrNull(repo),
					env: process.env,
					now: () => new Date(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Grant one repair round on both of a lane's repair budgets."),
	Command.withDescription(
		laneHelp(
			"clear",
			"Grants one repair round; prints {answer, lane, task, round, budget, rationale, pr}.",
			{
				4: "bad lane record",
				5: "--rationale carries a machine-local path",
				6: "--rationale is a bare @ path",
				7: "no lane",
				8: "a write did not land",
				9: "the marker does not read back",
				11: "read failed, UNKNOWN",
				13: "unknown task",
				20: "several open PRs link the issue",
				21: "bad key",
				47: "budget not spent",
				53: "--rationale says nothing",
				66: "this account may not grant",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{
			command:
				'fabrika lane clear 8820 --task issue --rationale "the three FAILs were one finding"',
		},
	]),
);

const report = leafCommand(
	"report",
	{
		lane: laneArgument,
		token: Flag.string("token").pipe(
			Flag.withDescription(
				"the shell's terminal token, exactly as its skill's closed vocabulary spells it",
			),
		),
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task the event addresses; omittable on a single-task lane"),
		),
		pr: Flag.string("pr").pipe(
			Flag.optional,
			Flag.withDescription("the PR URL the terminal names, recorded on the event line"),
		),
		comment: Flag.string("comment").pipe(
			Flag.optional,
			Flag.withDescription("the comment URL the terminal names, recorded on the event line"),
		),
		cause: causeFlag,
		axisIssue: axisIssueFlag,
		classes: classFlag,
		integrateExit: Flag.integer("integrate-exit").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane integrate exit (42, 43 or 44) a FAIL out of an epic child's integrate cell stands on; required there with --assembly-head, refused on every other line",
			),
		),
		assemblyHead: Flag.string("assembly-head").pipe(
			Flag.optional,
			Flag.withDescription(
				"the assembly branch head that integrate FAIL was refused against; required with --integrate-exit",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name the proof reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({
		lane,
		token,
		root,
		task,
		pr,
		comment,
		cause,
		axisIssue,
		classes,
		integrateExit,
		assemblyHead,
		repo,
	}) {
		const configRoot = yield* configRootOrRefuse("fabrika lane report", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const parkCause = yield* readKey(configRoot, parkCauseKey);
		yield* emit(
			yield* onKey("report", lane, root, (_key, ref) =>
				runReport(
					{
						...ref,
						token,
						task: Option.getOrNull(task),
						pr: Option.getOrNull(pr),
						comment: Option.getOrNull(comment),
						cause: Option.getOrNull(cause),
						axisIssue: Option.getOrNull(axisIssue),
						integrateExit: Option.getOrNull(integrateExit),
						assemblyHead: Option.getOrNull(assemblyHead),
						parkCause,
						classes,
						repo: Option.getOrNull(repo),
						cwd: process.cwd(),
						env: process.env,
					},
					runProve,
				),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Record a shell's terminal token, mapped to one operator event."),
	Command.withDescription(
		laneHelp(
			"report",
			"Appends a token's proven event; prints {token, previous, event, current, taskAffected}.",
			{
				4: "bad lane record",
				7: "no lane",
				8: "not appended",
				11: "read failed, UNKNOWN",
				12: "event refused",
				13: "unknown task",
				21: "bad key",
				22: "no artifact",
				23: "no binding verdict",
				24: "FAIL or link stands",
				25: "ambiguous",
				32: "unknown token",
				35: "bad cause",
				38: "bad --class",
				40: "lock held",
				52: "uncaused BLOCKED",
				55: "queue floor unmet",
				67: "head derives no route",
				68: "bad integrate pair",
				72: "token unserved",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane report 5736 --token SHIPPED-PR --pr <pr-url>"},
		{command: "fabrika lane report 8810 --task issue_8819 --token REPLAY-COLLIDED"},
	]),
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
		pr: Flag.string("pr").pipe(
			Flag.optional,
			Flag.withDescription(
				"the PR URL the event names; the ship stage's closure is read off exactly this PR",
			),
		),
		classes: classFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, event, root, task, pr, classes, repo}) {
		const classed = classesForEvent(classes);
		if (classed._tag === "Rejected") {
			yield* emit(refuse(CLASS_UNRECOGNISED, `fabrika lane prove: ${classed.reason}.`));
			return;
		}
		yield* emit(
			yield* onKey("prove", lane, root, (_key, ref) =>
				runProve({
					...ref,
					event,
					task: Option.getOrNull(task),
					classes: classed.classes,
					pr: Option.getOrNull(pr),
					repo: Option.getOrNull(repo),
					cwd: process.cwd(),
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Prove a lane event against the board before recording it."),
	Command.withDescription(
		laneHelp(
			"prove",
			"Reads the artifact a lane event claims and writes nothing; prints JSON with its proof.",
			{
				4: "bad lane record",
				7: "no lane",
				11: "read failed, UNKNOWN",
				13: "unknown task",
				21: "bad key",
				22: "no artifact",
				23: "no binding verdict",
				24: "FAIL or link stands",
				25: "ambiguous",
				38: "bad --class",
				67: "head derives no route",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane prove 5673 DONE"}]),
);

const history = leafCommand(
	"history",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey("history", lane, root, (_key, ref) => runHistory(ref)));
	}),
).pipe(
	Command.withShortDescription("The lane's append-only event log, verbatim."),
	Command.withDescription(
		laneHelp(
			"history",
			"Prints the lane's event log verbatim as a JSON array of {task, event, at} lines.",
			{
				4: "bad lane record",
				7: "no lane",
				11: "read failed, UNKNOWN",
				21: "bad key",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane history 5673"}]),
);

const print = leafCommand(
	"print",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey("print", lane, root, (_key, ref) => runPrint(ref)));
	}),
).pipe(
	Command.withShortDescription("The lane's compiled machine topology, as data."),
	Command.withDescription(
		laneHelp(
			"print",
			"Prints the lane's compiled machine topology as JSON, per task its legal events.",
			{
				4: "workflow.json is not the shape",
				7: "no lane",
				11: "read failed, UNKNOWN",
				21: "bad key",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane print 5673"}]),
);

const templatePath = (kind: LaneKey["_tag"]): string =>
	fileURLToPath(new URL(`./templates/${templateFile(kind)}`, import.meta.url));

const open = leafCommand(
	"open",
	{
		lane: laneArgument,
		root: rootFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the epic check reads (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote); read only for an issue key",
			),
		),
		fromBoard: Flag.boolean("from-board").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"seat the lane from what the board proves when its prior ledger is unreachable: one open PR with every derived namespace answered at head, booted with its repair budget declared spent and the adoption recorded on the issue",
			),
		),
		origin: Flag.string("origin").pipe(
			Flag.withDefault(DEFAULT_ORIGIN),
			Flag.withDescription(
				`where the lane came from, one of ${ORIGINS.join(", ")} (default: ${DEFAULT_ORIGIN}); recorded as the lane's first fact and shown on its record`,
			),
		),
	},
	Effect.fn(function* ({lane, root, repo, fromBoard, origin}) {
		const configRoot = yield* configRootOrRefuse("fabrika lane open", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const cap = yield* readKey(configRoot, laneConcurrencyCapKey);
		yield* emit(
			yield* onKey("open", lane, root, (key, ref) =>
				runOpen({
					...ref,
					templatePath: templatePath(key._tag),
					issue: keyIssue(key),
					expectation: expectationReader(Option.getOrNull(repo), process.env),
					priorLane: priorLaneReader(Option.getOrNull(repo), process.env),
					fromBoard,
					boardSeat: boardSeatReader(Option.getOrNull(repo), process.env),
					record: boardRecorder(Option.getOrNull(repo), process.env),
					cap,
					claimed: claimHoldReader(Option.getOrNull(repo), process.env),
					origin,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Boot a lane from the committed template its key selects."),
	Command.withDescription(
		laneHelp(
			"open",
			"Boots one lane by placing the template its key selects as <root>/<key>/workflow.json.",
			{
				8: "a write did not land; a missing origin fact reads as driver-pick",
				11: "read failed, UNKNOWN",
				14: "the lane already exists",
				21: "bad key",
				38: "an unsupported class label",
				46: "an epic; use lane emit",
				48: "a child; drive its parent lane",
				51: "the concurrency cap is full",
				63: "the board says it already had a lane",
				70: "--origin is outside the closed set",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane open 5673"},
		{command: "fabrika lane open chore:park-sweep"},
	]),
);

const emitLane = leafCommand(
	"emit",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the type:epic issue whose plan topology becomes the machine"),
		),
		root: rootFlag,
		children: Flag.boolean("children").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"start from the board's live sub-issue list: drop every topology ref it does not name instead of refusing at 16",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
		origin: Flag.string("origin").pipe(
			Flag.withDefault(DEFAULT_ORIGIN),
			Flag.withDescription(
				`where the epic lane came from, one of ${ORIGINS.join(", ")} (default: ${DEFAULT_ORIGIN}); recorded as the lane's first fact and shown on its record`,
			),
		),
	},
	Effect.fn(function* ({epic, root, children, repo, origin}) {
		const configRoot = yield* configRootOrRefuse("fabrika lane emit", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const cap = yield* readKey(configRoot, laneConcurrencyCapKey);
		const machinery = yield* readKey(configRoot, machineryLapsKey);
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane emit",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("emit", [resolvedRoot], process.cwd(), () =>
				runEmit({
					epic,
					root: resolvedRoot,
					repo: Option.getOrNull(repo),
					env: process.env,
					cap,
					machinery,
					children,
					claimed: claimHoldReader(Option.getOrNull(repo), process.env),
					origin,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Generate an epic's lane machine from its board topology."),
	Command.withDescription(
		laneHelp(
			"emit",
			"Emits an epic's lane machine; prints {answer, epic, origin, workflow, phases, children, …}.",
			{
				4: "the topology does not parse",
				7: "the epic is absent or closed",
				8: "write did not land",
				11: "read failed, UNKNOWN",
				14: "the lane exists; retire it to re-emit",
				15: "no topology to emit",
				16: "the topology names a non-child",
				17: "the topology holds a cycle",
				38: "an unsupported class label",
				51: "the concurrency cap is full",
				70: "--origin is outside the closed set",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane emit 5680"},
		{command: "fabrika lane emit 5817 --children"},
	]),
);

const amend = leafCommand(
	"amend",
	{
		epic: Argument.integer("lane").pipe(
			Argument.withDescription("the epic issue whose running lane takes the amended topology"),
		),
		root: rootFlag,
		defer: Flag.string("defer").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a task id this amendment DEFERS out of the plan (`issue_<n>`); repeatable, requires --defer-reason, and it is the only way a task carrying history may be dropped",
			),
		),
		deferReason: Flag.string("defer-reason").pipe(
			Flag.optional,
			Flag.withDescription(
				"why the deferred tasks are leaving the plan; recorded verbatim on each deferral row, and required with --defer",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({epic, root, defer, deferReason, repo}) {
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane amend",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("amend", [resolvedRoot], process.cwd(), () =>
				runAmend({
					epic,
					lane: String(epic),
					root: resolvedRoot,
					repo: Option.getOrNull(repo),
					env: process.env,
					now: new Date().toISOString(),
					defer,
					deferReason: Option.getOrNull(deferReason),
					ownership: claimOwnership,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Re-derive a running epic's machine from its current topology."),
	Command.withDescription(
		laneHelp(
			"amend",
			"Re-derives a running epic lane's machine from its topology; prints {answer, lane, epic, …}.",
			{
				4: "bad lane record or replay",
				7: "no lane, or epic absent or closed",
				8: "a write did not land",
				11: "read failed, UNKNOWN",
				15: "no readable topology",
				16: "the topology names a non-child",
				17: "the topology holds a cycle",
				40: "ledger lock held",
				60: "a LANDED task has no phase",
				61: "a task history does not replay",
				62: "malformed epic topology",
				64: "bad --defer",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane amend 7499"}]),
);

const assembly = leafCommand(
	"assembly",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly worktree"),
		),
		remove: Flag.boolean("remove").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"remove the run's assembly worktree instead of placing it — the lane's terminal step; fetches nothing and never forces",
			),
		),
		root: rootFlag,
	},
	Effect.fn(function* ({epic, remove, root}) {
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane assembly",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("assembly", [resolvedRoot], process.cwd(), () =>
				runAssembly({
					epic,
					remove,
					root: resolvedRoot,
					lane: String(epic),
					repo: null,
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Place, resume or remove an epic run's assembly worktree."),
	Command.withDescription(
		laneHelp(
			"assembly",
			"Places, resumes or removes an epic run's assembly worktree and prints its absolute path.",
			{
				4: "lane record is not the shape",
				7: "no lane",
				8: "placement or removal did not read back, UNKNOWN",
				11: "read failed, nothing placed or removed",
				33: "epic/<n> is checked out in the main tree",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane assembly 5680"},
		{command: "fabrika lane assembly 5680 --remove"},
	]),
);

const assemblyPr = leafCommand(
	"assembly-pr",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run opens the assembly PR"),
		),
		field: Flag.string("field").pipe(
			Flag.withDescription(
				`which piece of the PR's prose to print: ${FIELDS.join(" or ")} — one bare value per call, so the caller interpolates rather than parses; about prints nothing, reason on stderr, when the epic has no Pitch Problem paragraph`,
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({epic, field, repo}) {
		yield* emit(
			yield* runAssemblyPr({epic, field, repo: Option.getOrNull(repo), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("The assembly PR's title and About section, derived from the epic."),
	Command.withDescription(
		laneHelp(
			"assembly-pr",
			"Prints one bare piece of an epic run's assembly PR prose: its title or its About section.",
			{
				7: "epic absent or closed",
				11: "epic unreadable, UNKNOWN",
				56: "issue is not type:epic",
				57: "section still carries a closing keyword or classification",
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane assembly-pr 8070 --field title"},
		{command: "fabrika lane assembly-pr 8070 --field about"},
	]),
);

const assemblyBody = leafCommand(
	"assembly-body",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue the assembly PR must close"),
		),
	},
	Effect.fn(function* ({epic}) {
		yield* emit(yield* runAssemblyBody({epic, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription(
		"Relay an assembly PR body, refusing one that does not close the epic.",
	),
	Command.withDescription(
		laneHelp(
			"assembly-body",
			"Relays an assembly PR body from stdin to stdout unchanged when it closes the epic.",
			{
				3: "stdin held nothing",
				5: "body carries a machine-local path",
				6: "body is a bare @ path reference",
				58: "no closing keyword aims at the epic",
			},
		),
	),
	Command.withExamples([
		{
			command:
				'fabrika lane assembly-body 8070 < body.md | gh pr create --draft --head epic/8070 --title "<title>" --body-file -',
		},
	]),
);

const integrate = leafCommand(
	"integrate",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly branch"),
		),
		child: Flag.string("child").pipe(
			Flag.withDescription(
				"the child's branch to land, taken off `lane prove`'s PASS evidence (`evidence.branch`)",
			),
		),
		root: rootFlag,
	},
	Effect.fn(function* ({epic, child, root}) {
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane integrate",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("integrate", [resolvedRoot], process.cwd(), () =>
				runIntegrate({epic, child, root: resolvedRoot, lane: String(epic)}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Merge one reviewed child into an epic run's assembly and prove it holds.",
	),
	Command.withDescription(
		laneHelp(
			"integrate",
			"Merges a reviewed child into the assembly worktree and validates it; ends on INTEGRATE-VERDICT.",
			{
				4: "bad lane record",
				7: "no lane",
				8: "reset or read-back unlanded, UNKNOWN",
				11: "read failed or no codeValidators, UNKNOWN",
				22: "no such child branch",
				33: "epic/<n> in the main tree",
				39: ROOT_EXITS[39],
				41: "no worktree holds epic/<n>",
				42: "child conflicts, reset",
				43: "merged lockfile does not install",
				44: "merged tree fails a validator",
				45: "assembly worktree was dirty",
				54: "child branch did not follow the replay",
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane integrate 7140 --child build/7162-app-bootstrap-5558c9a2"},
	]),
);

const refresh = leafCommand(
	"refresh",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly branch"),
		),
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription(
				"the ref to merge in, resolved AFTER the fetch (default: the trunk, origin/<the repo's GitHub default branch>)",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name whose default branch is the trunk (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
		onReview: Flag.boolean("on-review").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"this is the automatic call on the tail's way into review, so `assemblyRefresh.onReview` gates it — under the shipped `off` it declines and merges nothing. A hand call omits this and is never gated.",
			),
		),
		root: rootFlag,
	},
	Effect.fn(function* ({epic, base, repo, onReview, root}) {
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane refresh",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		const configRoot = yield* configRootOrRefuse("fabrika lane refresh", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const assemblyRefresh = yield* readKey(configRoot, assemblyRefreshKey);
		yield* emit(
			yield* onGround("refresh", [resolvedRoot], process.cwd(), () =>
				runRefresh({
					epic,
					base: Option.getOrNull(base),
					repo: Option.getOrNull(repo),
					env: process.env,
					gate: onReview ? "onReview" : null,
					assemblyRefresh,
					root: resolvedRoot,
					lane: String(epic),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Merge the trunk into an epic run's assembly branch, proving the head.",
	),
	Command.withDescription(
		laneHelp(
			"refresh",
			"Merges the trunk into an epic run's assembly worktree; ends on a REFRESH-VERDICT line.",
			{
				4: "bad lane record",
				7: "no lane",
				8: "reset or head read-back unlanded, UNKNOWN",
				11: "read failed or the trunk is unresolvable, UNKNOWN",
				21: "assemblyRefresh is malformed",
				22: "--base names no commit",
				33: "epic/<n> in the main tree",
				39: ROOT_EXITS[39],
				41: "no worktree holds epic/<n>",
				42: "trunk conflicts, branch proven back",
				45: "assembly worktree was dirty",
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane refresh 8810"},
		{command: "fabrika lane refresh 8810 --on-review"},
	]),
);

const retrigger = leafCommand(
	"retrigger",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly branch"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name the sweep reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({epic, repo}) {
		yield* emit(yield* runRetrigger({epic, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription(
		"Schedule fresh checks on the children an assembly push left stale.",
	),
	Command.withDescription(
		laneHelp(
			"retrigger",
			"Updates each open PR based on epic/<n> so its checks rerun; ends on a RETRIGGER-VERDICT line.",
			{
				8: "a head did not move, or a read failed after a write",
				11: "read failed before any write, UNKNOWN",
				42: "the assembly branch does not merge into a head",
			},
		),
	),
	Command.withExamples([{command: "fabrika lane retrigger 8716"}]),
);

const pushLane = leafCommand(
	"push",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly branch"),
		),
		root: rootFlag,
	},
	Effect.fn(function* ({epic, root}) {
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane push",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("push", [resolvedRoot], process.cwd(), () =>
				runPush({epic, root: resolvedRoot, lane: String(epic)}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Publish an epic run's assembly branch, confirming the ref moved."),
	Command.withDescription(
		laneHelp(
			"push",
			"Pushes an epic run's assembly branch and reads the remote ref back; ends on PUSH-VERDICT: MOVED.",
			{
				4: "lane record is not the shape",
				7: "no lane",
				8: "pushed, remote ref unreadable, UNKNOWN",
				11: "read failed, nothing pushed",
				26: "tree not on the assembly branch",
				29: "push would drop remote commits",
				30: "proven: the remote ref did not move",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane push 5680"}]),
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
		const entrypoint = yield* resolveEntrypoint();
		yield* emit(
			yield* onKey("brief", lane, root, (_key, ref) =>
				runBrief({
					...ref,
					task: Option.getOrNull(task),
					repo: Option.getOrNull(repo),
					env: process.env,
					entrypoint,
					sizeStop: sizeStopOnGitHub("fabrika lane brief", process.cwd()),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("The spawn prompt for one task's current leaf state."),
	Command.withDescription(
		laneHelp(
			"brief",
			"Prints the lane-brief spawn prompt for one task's current state, to hand over verbatim.",
			{
				4: "bad lane record",
				7: "no lane",
				11: "UNKNOWN; a missing scope skips",
				13: "task not in the machine, or --task missing",
				18: "state routes to no shell",
				19: "no issue, or the issue is absent",
				20: "not exactly one open PR where one is needed",
				21: "bad key",
				22: "no branch carries the child's commits",
				25: "several branches carry them",
				39: ROOT_EXITS[39],
				59: "the assembly branch lacks a briefed verb",
				65: ROOT_EXITS[65],
				71: "size stop; nothing briefed",
			},
		),
	),
	Command.withExamples([{command: "fabrika lane brief 5680 --task issue_5729"}]),
);

const laneTokenFlag = Flag.string("token").pipe(
	Flag.optional,
	Flag.withDescription("the lane-claim token `lane claim` handed this driver — its identity"),
);

const claim = leafCommand(
	"claim",
	{
		lane: laneArgument,
		token: Flag.string("token").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane-claim token this driver already holds; a lane it owns then answers won and writes nothing",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, token, repo}) {
		yield* emit(
			yield* onBoardKey(lane, (key) =>
				runLaneClaim({
					key,
					lane,
					token: Option.getOrNull(token),
					repo: Option.getOrNull(repo),
					env: process.env,
					uuid: randomUUID(),
					at: new Date().toISOString(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Race the driver's claim on a lane and win it or name the winner."),
	Command.withDescription(
		laneHelp(
			"claim",
			"Races this driver's lane-claim marker on the lane's issue; prints the win or the winner as JSON.",
			{
				8: "marker write failed, UNKNOWN",
				9: "marker does not read back",
				11: "markers unreadable, UNKNOWN",
				21: "bad key",
				31: "proven lost",
			},
		),
	),
	Command.withExamples([{command: "fabrika lane claim 5492"}]),
);

const release = leafCommand(
	"release",
	{
		lane: laneArgument,
		token: laneTokenFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, token, repo}) {
		yield* emit(
			yield* onBoardKey(lane, (key) =>
				runLaneRelease({
					key,
					lane,
					token: Option.getOrNull(token),
					repo: Option.getOrNull(repo),
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Retract this driver's own lane-claim marker."),
	Command.withDescription(
		laneHelp(
			"release",
			"Retracts this driver's own lane-claim and lane-adopt markers; prints JSON.",
			{
				8: "retraction failed, UNKNOWN",
				11: "markers unreadable, UNKNOWN",
				21: "bad key",
				31: "held by another driver, or nothing of this driver stands",
			},
		),
	),
	Command.withExamples([{command: "fabrika lane release 5492 --token lane:s-9f2e:c1a4d6f8-…"}]),
);

const scratch = leafCommand(
	"scratch",
	{
		lane: laneArgument,
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, no path separators"),
		),
		token: Flag.string("token").pipe(
			Flag.withDescription("the lane-claim token `lane claim` handed this driver — its identity"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, slug, token, repo}) {
		yield* emit(
			yield* onBoardKey(lane, (key) =>
				runLaneScratch({
					key,
					lane,
					slug,
					token,
					repo: Option.getOrNull(repo),
					env: process.env,
					tmpRoot: tmpdir(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("The driver's per-lane scratch directory path."),
	Command.withDescription(
		laneHelp(
			"scratch",
			"Prints this driver's per-lane scratch directory path, creating it if absent.",
			{
				10: "--slug is not a kebab-case leaf",
				11: "markers unreadable, UNKNOWN",
				21: "bad key",
				31: "no live lane claim of this token stands",
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane scratch 5492 --slug helpers --token lane:s-9f2e:c1a4d6f8-…"},
	]),
);

const adopt = leafCommand(
	"adopt",
	{
		lane: laneArgument,
		session: Flag.string("session").pipe(
			Flag.withDescription(
				"the session whose stranded seat this run adopts — this run's own is the ordinary case here",
			),
		),
		reason: Flag.string("reason").pipe(
			Flag.withDescription("why the succession is taken; recorded on the marker, required"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, session, reason, repo}) {
		yield* emit(
			yield* onBoardKey(lane, (key) =>
				runLaneAdopt({
					key,
					lane,
					session,
					reason,
					repo: Option.getOrNull(repo),
					env: process.env,
					uuid: randomUUID(),
					at: new Date().toISOString(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Inherit a stranded seat's lane claim by attesting on the board."),
	Command.withDescription(
		laneHelp(
			"adopt",
			"Posts the lane-adopt succession marker for a stranded seat's lane claim; prints JSON.",
			{
				8: "marker write failed, UNKNOWN",
				9: "marker does not read back",
				21: "bad key",
			},
		),
	),
	Command.withExamples([
		{
			command:
				'fabrika lane adopt 5648 --session 99162fc1-3d99-416e-98b3-99dd423ade39 --reason "the seat driving this lane was killed by the 2026-08-19 outage"',
		},
	]),
);

const stale = leafCommand(
	"stale",
	{
		root: rootFlag,
		olderThan: Flag.integer("older-than").pipe(
			Flag.optional,
			Flag.withDescription(
				`override the horizon for every lane, in non-negative minutes (default: each lane's own shell budget — ${SHELL_BUDGETS.build.minutes} for a build, ${SHELL_BUDGETS.review.minutes} for a review, ${SHELL_BUDGETS.ship.minutes} for a ship, ${DISPATCH_BUDGET.minutes} for a task awaiting dispatch)`,
			),
		),
		claims: Flag.boolean("claims").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"additionally read the board and pair each non-terminal lane with the claim standing on its issue — the one thing here that makes a network call (default: false)",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the --claims pairing reads (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote); read only with --claims",
			),
		),
	},
	Effect.fn(function* ({root, olderThan, claims, repo}) {
		let roots: ReadonlyArray<string>;
		if (Option.isSome(root)) {
			roots = [root.value];
		} else {
			const ground = yield* deriveRepoRoot(process.cwd());
			if (ground._tag !== "Derived") {
				yield* emit(repoGroundRefusal("fabrika lane stale", ground));
				return;
			}
			roots = [
				`${ground.repoRoot}/${DEFAULT_LANES_ROOT}`,
				`${ground.repoRoot}/${DEFAULT_CHORES_ROOT}`,
			];
		}
		yield* emit(
			yield* onGround("stale", roots, process.cwd(), () =>
				runStale({
					roots,
					olderThanMinutes: Option.getOrNull(olderThan),
					now: new Date().toISOString(),
					claims: claims ? claimReader(Option.getOrNull(repo), process.env) : null,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Which lanes have gone quiet with something owed on them."),
	Command.withDescription(
		laneHelp(
			"stale",
			"Prints which lanes on disk have gone silent past their horizon as JSON, oldest silence first.",
			{
				11: "a root could not be listed, UNKNOWN",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane stale"},
		{command: "fabrika lane stale --older-than 120"},
		{command: "fabrika lane stale --claims"},
	]),
);

const seats = leafCommand(
	"seats",
	{
		root: rootFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the claim-marker read uses (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({root, repo}) {
		const configRoot = yield* configRootOrRefuse("fabrika lane seats", process.cwd());
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		const cap = yield* readKey(configRoot, laneConcurrencyCapKey);
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane seats",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* onGround("seats", [resolvedRoot], process.cwd(), () =>
				runSeats({
					root: resolvedRoot,
					cap,
					claimed: claimHoldReader(Option.getOrNull(repo), process.env),
					now: new Date().toISOString(),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"How full the lanes root is against laneConcurrencyCap, booting nothing.",
	),
	Command.withDescription(
		laneHelp(
			"seats",
			"Prints how many seats the lanes root holds against laneConcurrencyCap, booting nothing.",
			{
				11: "cap or root unreadable, UNKNOWN",
				39: ROOT_EXITS[39],
				65: ROOT_EXITS[65],
			},
			[
				"Non-directory and dot-prefixed entries under the root are not lanes, so they hold no seat.",
			],
		),
	),
	Command.withExamples([
		{command: "fabrika lane seats"},
		{command: "fabrika lane seats --root .fabrika/lanes"},
	]),
);

const migrate = leafCommand(
	"migrate",
	{
		// Optional, and the group's own positional grammar rather than a `--lane` flag: every other
		// per-lane verb here binds `laneArgument`, and one exception would be the only lane a caller
		// has to address differently.
		lane: Argument.optional(laneArgument),
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"judge the swept lanes and report, writing nothing; composes with a lane key",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the shape judgement reads (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, check, repo}) {
		let base: string | undefined;
		if (Option.isSome(root)) {
			base = root.value;
		} else {
			const ground = yield* deriveRepoRoot(process.cwd());
			if (ground._tag !== "Derived") {
				yield* emit(repoGroundRefusal("fabrika lane migrate", ground));
				return;
			}
			base = ground.repoRoot;
		}
		const roots = Option.match(root, {
			onNone: () => [
				{root: `${base}/${DEFAULT_LANES_ROOT}`, templatePaths: [templatePath("Issue")]},
				{root: `${base}/${DEFAULT_CHORES_ROOT}`, templatePaths: [templatePath("Chore")]},
			],
			// A relocated root holds whatever was opened into it, so both templates are
			// candidates and the lane's own machine id picks — never the root's position.
			onSome: (only) => [
				{root: only, templatePaths: [templatePath("Issue"), templatePath("Chore")]},
			],
		});
		yield* emit(
			yield* onGround(
				"migrate",
				roots.map((swept) => swept.root),
				process.cwd(),
				() =>
					runMigrate({
						roots,
						check,
						lane: Option.getOrNull(lane),
						expectations: expectationReader(Option.getOrNull(repo), process.env),
					}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Bring booted lane machines up to the committed template; a key narrows.",
	),
	Command.withDescription(
		laneHelp(
			"migrate",
			"Brings booted lane machines up to their committed template where nothing moves; prints JSON.",
			{
				7: "the lane key matches no lane",
				11: "template or root unreadable, UNKNOWN",
				37: "a lane cannot take the template without moving",
				39: ROOT_EXITS[39],
				46: "a lane runs a machine its issue does not call for",
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane migrate --check"},
		{command: "fabrika lane migrate"},
		{command: "fabrika lane migrate 6457 --check"},
		{command: "fabrika lane migrate chore:park-sweep"},
	]),
);

const archive = leafCommand(
	"archive",
	{
		lane: Argument.optional(laneArgument),
		sweep: Flag.boolean("sweep").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"walk the lanes root and archive EVERY lane both gates already clear, reporting one row per lane examined. Takes no lane argument — a key and this flag together name two different jobs",
			),
		),
		retriaged: Flag.boolean("retriaged").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"move a lane whose log replays to `diagnosed` with no pull request and no spent round, so a re-triaged issue can boot a fresh lane. Every other final refuses at 73; a later move of the same key takes the next free <lane>.archived-<n> slot",
			),
		),
		root: rootFlag,
		archivedRoot: Flag.string("archived-root").pipe(
			Flag.optional,
			Flag.withDescription(
				`where the lane moves to (default: the owning repository's ${DEFAULT_ARCHIVED_LANES_ROOT}, a sibling of the lanes root and swept by nothing)`,
			),
		),
		token: Flag.string("token").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane-claim token, when the driver holding this lane is the one archiving it",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the claim read and retraction read (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, sweep, retriaged, root, archivedRoot: archived, token, repo}) {
		if (sweep && retriaged) {
			yield* emit(
				refuse(
					FAILED,
					"fabrika lane archive: --retriaged names one lane an operator judged re-triaged, and --sweep walks every lane on the unreplayable gate — the two are different jobs, so nothing was moved. Drop one.",
				),
			);
			return;
		}
		if (sweep && Option.isSome(lane)) {
			yield* emit(
				refuse(
					FAILED,
					`fabrika lane archive: --sweep walks the whole lanes root and "${lane.value}" names one lane — the two are different jobs, so nothing was moved. Drop one.`,
				),
			);
			return;
		}
		if (!sweep && Option.isNone(lane)) {
			yield* emit(
				refuse(
					FAILED,
					"fabrika lane archive: name the lane to archive, or pass --sweep to walk the lanes root. Nothing was moved.",
				),
			);
			return;
		}
		const parsed = Option.isSome(lane) ? parseKey(lane.value) : null;
		if (parsed !== null && parsed._tag === "Malformed") {
			yield* emit(keyRefusal(parsed));
			return;
		}
		const path = yield* Path.Path;
		// A relocated root holds whatever was opened into it, so both templates are candidates and the
		// lane's own machine id picks — never the root's position.
		const templatePaths = [templatePath("Issue"), templatePath("Chore")];
		let source: string;
		let destination: string;
		if (Option.isSome(root) && Option.isSome(archived)) {
			source = root.value;
			destination = archived.value;
		} else {
			const ground = yield* deriveRepoRoot(process.cwd());
			if (ground._tag !== "Derived") {
				yield* emit(repoGroundRefusal("fabrika lane archive", ground));
				return;
			}
			// The sweep addresses the lanes root itself, so it has no key to take a default from — a
			// chore lane drives no issue and can never clear the closed-issue gate.
			source = Option.getOrElse(root, () =>
				path.join(ground.repoRoot, parsed === null ? DEFAULT_LANES_ROOT : defaultRoot(parsed.key)),
			);
			destination = Option.getOrElse(archived, () => path.join(ground.repoRoot, archivedRoot()));
		}
		if (parsed === null) {
			yield* emit(
				yield* onGround("archive", [source, destination], process.cwd(), () =>
					runArchiveSweep({
						root: source,
						archivedRoot: destination,
						templatePaths,
						closed: closedReader(Option.getOrNull(repo), process.env),
					}),
				),
			);
			return;
		}
		const ref = laneRef(parsed.key, source);
		const seams = boardClaimSeams(Option.getOrNull(repo), process.env);
		yield* emit(
			yield* onGround("archive", [ref.root, destination], process.cwd(), () =>
				runArchive({
					ref,
					route: retriaged ? "retriaged" : "unreplayable",
					archivedRoot: destination,
					templatePaths,
					issue: keyIssue(parsed.key),
					token: Option.getOrNull(token),
					claims: seams.claims,
					retract: seams.retract,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Move an unreplayable or re-triaged diagnosed lane out of the swept root.",
	),
	Command.withDescription(
		laneHelp(
			"archive",
			"Moves an unreplayable lane aside, or sweeps; --retriaged moves a diagnosed no-PR one; prints JSON.",
			{
				4: "bad lane record",
				7: "no lane",
				8: "move or claim retraction unlanded",
				9: "moved, destination does not read back",
				11: "read failed, UNKNOWN",
				14: "archived root already holds this key",
				21: "bad key",
				31: "a lane claim this caller did not name",
				39: ROOT_EXITS[39],
				50: "the log replays, nothing to move",
				65: ROOT_EXITS[65],
				73: "--retriaged: not diagnosed, or a PR or spent round",
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane archive 6037"},
		{command: "fabrika lane archive 10054 --retriaged --token <your lane-claim token>"},
		{command: "fabrika lane archive 8810 --token <the token `fabrika lane claim` printed>"},
		{command: "fabrika lane archive --sweep"},
	]),
);

const settle = leafCommand(
	"settle",
	{
		lane: laneArgument,
		root: rootFlag,
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the task the terminal addresses; omittable on a single-task lane"),
		),
		token: Flag.string("token").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane-claim token, when the driver holding this lane is the one settling it",
			),
		),
		landedBy: Flag.integer("landed-by").pipe(
			Flag.optional,
			Flag.withDescription(
				"the merged pull request that discharged this lane, where no body links the issue — supplies the link, never the merge",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the closure, pull-request and claim reads read (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, task, token, landedBy, repo}) {
		const readers = boardReaders(Option.getOrNull(repo), process.env);
		yield* emit(
			yield* onKey("settle", lane, root, (key, ref) =>
				runSettle({
					...ref,
					issue: resolveKeyIssue(key),
					task: Option.getOrNull(task),
					token: Option.getOrNull(token),
					landedBy: Option.getOrNull(landedBy),
					closure: readers.closure,
					pulls: readers.pulls,
					claims: readers.claims,
					sha: readers.sha,
					asserted: readers.asserted,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("End a lane against its issue's own closure, as a recorded event."),
	Command.withDescription(
		laneHelp("settle", "Appends the terminal the issue's own board closure proves; prints JSON.", {
			4: "bad lane record",
			7: "no lane",
			8: "append unlanded",
			11: "read failed or no terminal proven",
			12: "already terminal",
			13: "bad task or --task missing",
			19: "key names no issue",
			21: "bad key",
			22: "--landed-by: no such PR",
			23: "--landed-by: PR unmerged",
			31: "an unnamed lane claim",
			39: ROOT_EXITS[39],
			40: "ledger lock held",
			49: "the issue is open",
			65: ROOT_EXITS[65],
		}),
	),
	Command.withExamples([
		{command: "fabrika lane settle 5983"},
		{command: "fabrika lane settle 6100 --landed-by 6878"},
	]),
);

const reconcile = leafCommand(
	"reconcile",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"judge every lane and report, appending nothing; the next sweep pays the same board reads again",
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the closure read uses (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({root, check, repo}) {
		let roots: ReadonlyArray<ReconcileRoot>;
		if (Option.isSome(root)) {
			// A relocated root holds whatever was opened into it, so both templates are candidates and
			// the lane's own machine id picks — never the root's position.
			roots = [{root: root.value, templatePaths: [templatePath("Issue"), templatePath("Chore")]}];
		} else {
			const ground = yield* deriveRepoRoot(process.cwd());
			if (ground._tag !== "Derived") {
				yield* emit(repoGroundRefusal("fabrika lane reconcile", ground));
				return;
			}
			roots = [
				{
					root: `${ground.repoRoot}/${DEFAULT_LANES_ROOT}`,
					templatePaths: [templatePath("Issue")],
				},
				{
					root: `${ground.repoRoot}/${DEFAULT_CHORES_ROOT}`,
					templatePaths: [templatePath("Chore")],
				},
			];
		}
		yield* emit(
			yield* onGround(
				"reconcile",
				roots.map((swept) => swept.root),
				process.cwd(),
				() =>
					runReconcile({
						roots,
						check,
						closures: closureReader(Option.getOrNull(repo), process.env),
						now: new Date().toISOString(),
					}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Which lanes folded on a merge the board says closed nothing."),
	Command.withDescription(
		laneHelp(
			"reconcile",
			"Appends the correction to each lane whose merge closure the board disagrees with; prints JSON.",
			{
				8: "an append did not land, UNKNOWN",
				11: "template or root unreadable, UNKNOWN",
				39: ROOT_EXITS[39],
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane reconcile --check"},
		{command: "fabrika lane reconcile"},
	]),
);

const recover = leafCommand(
	"recover",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription("judge every lane and report what would be appended, appending nothing"),
		),
		spawns: Flag.boolean("spawns").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				`also park every lane whose builder is provably gone: a build claim standing past the ${SHELL_BUDGETS.build.minutes}-minute build budget, no lane branch in this clone, and nothing on the surface that lane's role publishes to — an open PR linking the issue on a single lane or an epic tail, the lane branch itself on an epic child, which opens no PR. Recorded as BLOCKED --cause spawn-dead. It retracts nothing here; the spawn-dead unpark row ends the claim on the same proof, one verb later and with no human between the two. Costs board reads per lane standing in build or build:ui, which is why it is opt-in`,
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the proof reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({root, check, spawns, repo}) {
		const parkCause = yield* readKey(process.cwd(), parkCauseKey);
		let roots: ReadonlyArray<string>;
		if (Option.isSome(root)) {
			roots = [root.value];
		} else {
			const ground = yield* deriveRepoRoot(process.cwd());
			if (ground._tag !== "Derived") {
				yield* emit(repoGroundRefusal("fabrika lane recover", ground));
				return;
			}
			roots = [
				`${ground.repoRoot}/${DEFAULT_LANES_ROOT}`,
				`${ground.repoRoot}/${DEFAULT_CHORES_ROOT}`,
			];
		}
		// One memoized claim reader for the whole sweep, and one instant every lane's claim is measured
		// against: a clock read per lane would age two lanes swept seconds apart against two horizons.
		const claimants = claimReader(Option.getOrNull(repo), process.env);
		const nowEpochMs = Date.now();
		const spawnReads = spawns
			? {
					claim: (issue: number) =>
						Effect.gen(function* () {
							const read = yield* claimants(issue);
							return claimStanding(issue, read, nowEpochMs, BUILD_CLAIM_BUDGET_MINUTES);
						}),
					branches: (issue: number) =>
						Effect.gen(function* () {
							const read = yield* localBranches;
							return read._tag === "Failure"
								? ({_tag: "Unknown", reason: read.reason} as const)
								: ({_tag: "Read", branches: childLaneBranches(issue, read.value)} as const);
						}),
					pulls: pullsReader(Option.getOrNull(repo), process.env),
				}
			: null;
		yield* emit(
			yield* onGround("recover", roots, process.cwd(), () =>
				runRecover({
					roots,
					check,
					spawns: spawnReads,
					prove: runProve,
					parkCause,
					repo: Option.getOrNull(repo),
					cwd: process.cwd(),
					env: process.env,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Which lanes their own artifact already proves an event for."),
	Command.withDescription(
		laneHelp(
			"recover",
			"Records the event each lane's own artifact proves but its ledger never learned; prints JSON.",
			{
				8: "an append did not land, UNKNOWN",
				11: "a root could not be listed, UNKNOWN",
				39: ROOT_EXITS[39],
				65: ROOT_EXITS[65],
			},
		),
	),
	Command.withExamples([
		{command: "fabrika lane recover --check"},
		{command: "fabrika lane recover"},
		{command: "fabrika lane recover --spawns --check"},
		{command: "fabrika lane recover --spawns"},
	]),
);

const wait = leafCommand(
	"wait",
	{
		lane: laneArgument,
		root: rootFlag,
		on: Flag.string("on").pipe(
			Flag.withDescription(
				"what the lane is waiting on, in one line — a person, a release, another issue",
			),
		),
		until: Flag.string("until").pipe(
			Flag.withDescription(
				"the ISO date or instant the wait holds until; it must still be to come",
			),
		),
	},
	Effect.fn(function* ({lane, root, on, until}) {
		yield* emit(yield* onKey("wait", lane, root, (_key, ref) => runWait({...ref, on, until})));
	}),
).pipe(
	Command.withShortDescription("Record what a lane is waiting on, and until when."),
	Command.withDescription(
		laneHelp(
			"wait",
			'Records a waiting fact on the lane; prints {"answer":"waiting",lane,on,until}.',
			{
				4: "bad lane record or facts",
				7: "no lane",
				8: "the append did not land",
				11: "read failed, UNKNOWN",
				21: "bad key",
				40: "the ledger lock is held; retry",
				70: "a bad --on or an --until not still to come",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([
		{command: 'fabrika lane wait 5673 --on "the design review" --until 2026-10-05'},
	]),
);

const record = leafCommand(
	"record",
	{
		lane: laneArgument,
		root: rootFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the record is posted to (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, repo}) {
		const board = recordBoard(Option.getOrNull(repo), process.env);
		yield* emit(
			yield* onKey("record", lane, root, (key, ref) =>
				runRecord({
					...ref,
					issue: resolveKeyIssue(key),
					spent: LEDGER_SPEND,
					board,
					syncTable: (issue) =>
						runSync({
							repo: Option.getOrNull(repo),
							cwd: process.cwd(),
							env: process.env,
							issues: [issue],
							board: syncBoard,
							dryRun: false,
						}),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Post a terminal lane's record to its issue, once per terminal."),
	Command.withDescription(
		laneHelp(
			"record",
			"Posts a terminal lane's record to its issue; prints {answer, lane, issue, commentId, …}.",
			{
				4: "a record, fact or comment does not read",
				5: "a machine-local path survived scrubbing",
				7: "no lane",
				8: "the post failed; re-run",
				9: "the comment does not read back",
				11: "read failed, UNKNOWN",
				19: "the key names no issue",
				21: "bad key",
				69: "the lane is not terminal",
				...ROOT_EXITS,
			},
		),
	),
	Command.withExamples([{command: "fabrika lane record 5673"}]),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([
		status,
		transition,
		clear,
		report,
		attachIntegrate,
		prove,
		history,
		print,
		open,
		emitLane,
		amend,
		brief,
		dispatch,
		assembly,
		assemblyPr,
		assemblyBody,
		integrate,
		refresh,
		pushLane,
		retrigger,
		stale,
		seats,
		migrate,
		reconcile,
		recover,
		archive,
		settle,
		claim,
		release,
		adopt,
		scratch,
		wait,
		record,
	]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's events. A lane is keyed by the issue number it drives, or by name as `chore:<name>` for a chore that has no issue number",
	),
);
