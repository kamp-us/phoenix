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
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
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
import {runRecover} from "./recover-verb.ts";
import {DEFAULT_TRUNK_REF, runRefresh} from "./refresh-verb.ts";
import {keyRefusal} from "./refusals.ts";
import {classesForEvent, PARK_CAUSE_TOKENS} from "./report.ts";
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
	Effect.fn(function* ({lane, event, root, task, cause, classes, grantWait, rationale, repo}) {
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
				35: "bad --cause",
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
		"Attach the `lane integrate` exit and assembly head to an epic child's integrate FAIL that was recorded before `lane report` carried them. `build claim --lane` reads an integrate FAIL only off that pair, and once the pair-less FAIL folded the task back into `build`, `lane report` refuses the pair there at 68 — so a lane in that state has no builder that can take its repair. This verb appends one `<TASK>.CORRECTED` line naming the FAIL by its `at` and carrying `integrate: {exit, head}`; no recorded line is rewritten or dropped, and `build claim` and `build resume-child` read the FAIL through the correction exactly as if it had been recorded with the pair. The line is judged before the ledger lock and again under it. It is refused, log byte-identical, when the named line is not a FAIL recorded out of `integrate`, when a later DONE on the task already answered it, when `lane report` recorded it with its own pair, when no line or more than one of the task stands at that `at`, or when the exit is not 42, 43 or 44 or the head is not a commit sha. A FAIL an earlier attach already paired is not refused: a second run appends a second CORRECTED and the later pair wins, which is how a wrong exit or head is fixed. stdout is `{lane, task, event, corrects, integrate}`. Exits 4 (lane record read in full and not the shape, or the log does not replay), 7 (no lane there), 8 (the append did not land — the pair is NOT attached), 11 (the lane could not be read), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository to derive the default lanes root from), 40 (another writer held the ledger lock), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it), 68 (the named line may not take the pair, or the pair is malformed — log unappended). Example: fabrika lane attach-integrate 900 --task issue_4312 --at 2026-09-20T18:04:11.000Z --integrate-exit 43 --assembly-head 03135b9",
	),
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
			"Appends a terminal token's proven event; prints {token, previous, event, current, taskAffected}.",
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
				35: "bad --cause",
				38: "bad --class",
				40: "ledger lock held",
				52: "uncaused BLOCKED",
				55: "ship:queued floor unmet",
				67: "head derives no route",
				68: "bad integrate pair",
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
	},
	Effect.fn(function* ({lane, root, repo, fromBoard}) {
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
					boardSeat: boardSeatReader(Option.getOrNull(repo), process.cwd(), process.env),
					record: boardRecorder(Option.getOrNull(repo), process.env),
					cap,
					claimed: claimHoldReader(Option.getOrNull(repo), process.env),
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
				8: "write did not land",
				11: "read failed, UNKNOWN",
				14: "the lane already exists",
				21: "bad key",
				38: "an unsupported class label",
				46: "an epic; use lane emit",
				48: "a child; drive its parent lane",
				51: "the concurrency cap is full",
				63: "the board says it already had a lane",
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
	},
	Effect.fn(function* ({epic, root, children, repo}) {
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
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Generate an epic's lane machine from its board topology."),
	Command.withDescription(
		laneHelp(
			"emit",
			"Emits an epic's lane machine; prints {answer, epic, workflow, phases, children, dropped, bytes}.",
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
				runAssembly({epic, remove, root: resolvedRoot, lane: String(epic)}),
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
			Flag.withDefault(DEFAULT_TRUNK_REF),
			Flag.withDescription(
				`the trunk ref to merge in, resolved AFTER the fetch (default: ${DEFAULT_TRUNK_REF})`,
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
	Effect.fn(function* ({epic, base, onReview, root}) {
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
					base,
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
				11: "read failed, UNKNOWN",
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
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("The spawn prompt for one task's current leaf state."),
	Command.withDescription(
		laneHelp(
			"brief",
			"Prints the lane-brief spawn prompt for one task's current state, to hand to the spawn verbatim.",
			{
				4: "bad lane record",
				7: "no lane",
				11: "read failed, UNKNOWN",
				13: "task not in the machine, or --task missing",
				18: "state routes to no shell",
				19: "no issue, or the issue is absent",
				20: "zero or several open PRs where one is needed",
				21: "bad key",
				22: "no local branch carries the child's commits",
				25: "several branches carry the child's commits",
				39: ROOT_EXITS[39],
				59: "assembly branch lacks a verb the brief names",
				65: ROOT_EXITS[65],
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
		'Race the earliest AUTHORIZED lane-claim marker on the issue a lane drives: post this driver\'s token (lane:<session-id>:<uuid>), re-read, and win or name the winner. The namespace is the driver\'s own — `lane-claim:`/`lane:`, never `build-claim:`/`build:` — so the builder this driver spawns claims the same issue and wins; the two races never see each other. Authorization is the author\'s repository permission; marker text confers nothing. No admission test runs here — the fence is the spawned builder\'s. Prints {"answer":"won","lane":"…","number":n,"token":"…"}. --token makes the re-claim idempotent per DRIVER: handed the token this driver already holds, a lane it already owns answers won with that same marker and writes nothing, so N claims can never leave N markers for a later release to peel off one at a time; a same-session marker under another nonce is a sibling driver and races normally. A `chore:<name>` lane, or any key that is not a board number, has no thread to race on and answers {"answer":"unclaimable","lane":"…","why":"…"} at exit 0 with nothing written. A lost race retracts this run\'s own marker and exits 31, never 0 — including when the winner is another driver of THIS session, since ownership turns on the whole token and never the session id; no session id is set (FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID, PI_SUBAGENT_PARENT_SESSION), or a --token that is not a lane-claim token of this session, is 1. A lane-adopt marker of this DRIVER standing with no claim beside it refuses the --token path on 31 and names the release that retracts it, rather than racing a fresh marker past a comment nothing later would name; and an adopt older than the marker it would fence is read as adopting some earlier claim, so one stray adopt no longer fences every marker its session posts on the number and confers no later marker either — the same order on both arms, so one succession answers mine to exactly one lane. Exits 8 (the marker write failed — UNKNOWN, never a claim), 9 (the marker landed and does not read back), 11 (the marker set could not be read — UNKNOWN, never "unclaimed"; this run\'s own marker is retracted first), 21 (the key is not a lane key), 31 (proven lost). Example: fabrika lane claim 5492',
	),
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
		'Retract this DRIVER\'s OWN lane-claim marker, and only its own, so the lane is drivable again — run at both ends of the loop, the terminal fold and the park. --token says which driver that is: ownership turns on the whole token, so a sibling driver of one session is a foreign holder here and its marker is never swept. Every marker carrying this driver\'s token goes, not merely the winning one, so a duplicate a re-claim left behind cannot outlive the release. Prints {"answer":"released","lane":"…","number":n}. It ALSO retracts this driver\'s own lane-adopt marker: with a claim beside it, both comments go, answering {"answer":"released","lane":"…","number":n,"adopted":"<session>"}; with NO lane-claim marker standing — the state adopting an already-released claim leaves — that adopt is retracted alone under the same answer. That second case used to be unreachable: ownership answered "unclaimed" the moment no claim survived, so this verb said "nothing to retract" while `lane claim` went on counting the comment and losing to it, and a hand-deleted comment was the only way out. Only the driver the marker\'s "by <token>" names reaches it — a sibling driver reads the thread as unclaimed and retracts nothing, exactly as it may not sweep a sibling\'s claim. Exits 1 (no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID and PI_SUBAGENT_PARENT_SESSION consulted, --token omitted on a board number, or a --token that is not a lane-claim token of this session), 8 (the retraction failed, or a stranded adopt was not retracted — whether the lane is still held or still reads as adopted is UNKNOWN), 11 (the marker set could not be read), 21 (the key is not a lane key), 31 (proven: held by another driver, or neither a claim nor an adopt of this driver stands). Example: fabrika lane release 5492 --token lane:s-9f2e:c1a4d6f8-…',
	),
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
		"The DRIVER's per-lane scratch path, allocated fail-closed: <temp root>/fabrika-lane/<session-id>/<issue>-<lane-claim-nonce>/<slug>, one absolute path on stdout, the directory created if absent. Every script, wrapper or helper file a driver writes goes here: the session scratchpad is shared by every lane of the session, so a helper written there is rewritten by a sibling driver and every verb run through it lands in that sibling's tree. --token's nonce keys the namespace per LANE, so two drivers of one session print different paths; the `fabrika-lane` segment keeps it apart from the builders' `build scratch` namespace. The token must be a live lane claim of this session on this lane's issue — proven off the board, never trusted. A `chore:<name>` lane holds no claim and so has no namespace. The printed path is machine-local and must never reach a posted artifact — every posting verb's leak scan reds on it. Exits 1 (the directory could not be created, no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID and PI_SUBAGENT_PARENT_SESSION consulted, --token is not a lane-claim token of this session, or the key is a chore lane), 10 (--slug carries a path separator or is not kebab-case), 11 (the lane-claim markers could not be read — UNKNOWN), 21 (the key is not a lane key), 31 (proven: no live lane claim of this token stands on the issue — another driver holds it, or none does). Example: fabrika lane scratch 5492 --slug helpers --token lane:s-9f2e:c1a4d6f8-…",
	),
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
		'Post the succession marker a stranded operator seat\'s lane claim needs: lane-adopt: <session> by lane:<this-session>:<uuid> · <ISO> · reason: <text>. It writes ONE comment and posts no claim marker — "fabrika lane release <lane> --token <the token this prints>" then resolves that claim as this driver\'s and retracts both comments, after which "fabrika lane claim <lane>" wins normally. That release reaches this marker EVEN WHEN NO LANE-CLAIM MARKER STANDS, so adopt → release → claim terminates from every state, including the one where the claim was already released; it fences and confers only over a claim marker POSTED AFTER IT, since a succession adopts a claim that already stands. UNLIKE "build adopt" it ADMITS this run\'s own session, because what dies here is a SEAT and its successor boots under the same CLAUDE_CODE_SESSION_ID with only a fresh nonce, and plain release reads that same-session-other-nonce marker as foreign. It proves no seat dead, exactly as the build namespace\'s succession proves no session dead: the guards are the poster\'s repository permission, read at release time, and the marker sitting on the issue with its reason for anyone to read; an adopt from an account below write is counted, reported, and never a succession. Deleting the comment reverses it. Prints {"answer":"adopted","lane":"…","number":n,"session":"<adopted>","token":"…"}. A `chore:<name>` lane, or any key that is not a board number, was never claimable and answers {"answer":"inert","lane":"…","why":"…"} at exit 0 with nothing written. Exits 1 (CLAUDE_CODE_SESSION_ID unset, an empty --session or --reason, a --session carrying whitespace or ·, or a multi-line --reason), 8 (the marker write failed — UNKNOWN), 9 (the marker landed and does not read back), 21 (the key is not a lane key). Example: fabrika lane adopt 5648 --session 99162fc1-3d99-416e-98b3-99dd423ade39 --reason "the seat driving this lane was killed by the 2026-08-19 outage"',
	),
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
		'How many seats the lanes root is holding against `laneConcurrencyCap`, read WITHOUT booting anything — the one lane verb an operator may run before it claims a lane. It creates no lane directory, posts no claim marker and appends no log line, so running it when the cap is full costs nothing and leaves nothing to release; `lane open` is where a boot is asked for and refused at 51. The count is `lane open`\'s own, unchanged: a seat is an issue lane under this root whose log folds to active AND whose issue carries a live `lane claim` marker, plus every lane no read can account for — a record that will not load, a log that will not replay, or a claim the board would not answer for. An active lane nobody claims is IDLE and holds nothing; it is reported separately, never counted. An archived lane is under a sibling root and is already out of the count, and a chore lane is counted by nobody. stdout is {answer, root, cap, held, retryAfter, free, claimed, unaccountable, idle}: answer is "full" (held is at or past the cap — a boot would take 51, and an operator reading this before `lane claim` ends LANE-WAITING instead of spending a claim, no sooner than the retryAfter instant: one pass of a driver\'s own loop past now, since nothing on disk says when another lane will reach a terminal), "free" (a seat is available) or "uncapped" (the config declares no cap, so nothing bounds this root and free is null). `laneConcurrencyCap` is read from the `.fabrika.jsonc` of the repository that OWNS the cwd — the same checkout the lanes root derives from — so a linked worktree is counted against the primary checkout\'s declaration and not its own tracked copy. There is no override flag here either: raising the number in the config is how it changes. Exits 11 (the cap could not be read, or the root is there and could not be listed — how full it is is UNKNOWN, never zero and never free), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane seats · fabrika lane seats --root .fabrika/lanes',
	),
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
			Flag.withDescription("judge the swept lanes and report, writing nothing"),
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
		'Bring each booted lane\'s workflow.json up to the committed template its root selects, but only where the swap provably moves nothing. `lane open` places a byte-identical copy at boot and refuses to overwrite one afterwards, so a template edit reaches lanes booted after it and no lane already on disk — safe until a token→event map in code changes with it, at which point every booted lane is asked for a cell its frozen machine does not have. Two things are kept: the lane\'s own `machine.context`, which is per-lane DATA (the task\'s maxRetries, and whatever else a lane declares) and would be erased by a verbatim copy, and any lane whose machine was GENERATED rather than booted — an emitted epic document has no committed template to be brought up to, and is reported, never touched. State is the event log replayed from scratch with no snapshot, so the swap is safe exactly when the existing events.jsonl folds to the same per-task leaf state through both machines; anything else is a rewritten history, not a migration. Each lane carries one verdict: "current" (already the machine this verb would write, read past formatting), "migrated" (judged safe and written), "stale" (judged safe, --check withheld the write), "generated" (not booted from this template), "mismatched" (the machine is not the one this lane\'s issue calls for — never written), "duplicate" (this lane drives an epic\'s CHILD, whose parent\'s lane already owns the work — a second ledger booted before `lane open` refused one; reported, never written, and never migrated), "unsafe" (the log will not replay through one of the two machines, or it folds to a different state — named, never written) or "unreadable". stdout is {check, scanned, summary, lanes}. Staleness was the only wrongness this sweep could see, and a coder-template lane booted on an epic grafts cleanly and read "current" — so each ISSUE-keyed lane is additionally judged against its issue\'s type and its native sub-issue links, and every judged row carries shape: {"state":"matches"} | {"state":"mismatched",reason} | {"state":"duplicate",parent,reason} | {"state":"unknown",reason} — a board read that failed is unknown, never "matches", and a booted child lane is duplicate, never "matches". That read is the verb\'s only network call, one per issue-keyed lane; chore lanes drive no issue and are not judged. A mismatched lane is skipped ahead of every migration verdict and the sweep exits 46; a duplicate lane is skipped the same way and moves NO exit code — a stray ledger is a report, and retiring its directory is an operator\'s act this verb never takes; where unsafe lanes are present too, 37 wins as the more dangerous class. Both default roots are swept unless --root names one, which is read as a relocated root whose lanes may have booted from either committed template — the lane\'s own machine id picks, never the root\'s position; an absent root holds no lanes and is not a fault. An optional LANE KEY narrows the sweep to that one lane and changes nothing else: every other entry under the swept root(s) is neither read, judged nor written, which is what lets a driver holding one lane discharge the write its own lane needs without touching the lanes other drivers are mid-drive on. The key is matched as this verb renders it, so a chore root\'s entry is addressed `chore:<name>` and an issue lane by its directory name; a key matching nothing is exit 7, never a sweep of zero reported as clean. Unaddressed, the whole-root sweep is exactly what it has always been — the release-time shape, and still the default. --check composes with a key: judge that lane, write nothing. Exits 7 (a lane key was given and no lane under the swept root(s) carries it — nothing was judged and nothing was written), 11 (a template could not be read, or a root is there and could not be listed — the lane set is UNKNOWN, never empty), 37 (at least one lane cannot take the template without moving; those lanes are named on stderr and none of them was written, and so are the ones that were), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 46 (at least one lane runs a machine its issue does not call for; an epic\'s lane is rebuilt by retiring its directory and re-running `fabrika lane emit <n>`). Examples: fabrika lane migrate --check · fabrika lane migrate · fabrika lane migrate 6457 --check · fabrika lane migrate chore:park-sweep',
	),
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
	Effect.fn(function* ({lane, sweep, root, archivedRoot: archived, token, repo}) {
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
		"Move lanes whose logs never replay out of the swept root — one or all.",
	),
	Command.withDescription(
		'Move one lane directory from the lanes root to the archived root, so the sweeps stop reporting a lane they can never judge. `lane reconcile` reads such a lane "unreadable" and `lane migrate` "unsafe" on every run, forever: the fault is an event the machine has no cell for, and neither verb may rewrite an append-only log to fix it — sealing writes a line for something that did not happen and widening `frozen` lets a lane at its retry cap ship with no unblock. So the record moves aside instead, and nothing in it is touched. ONE gate decides the move: the log must fail to replay under the same judgement `lane migrate` makes — through the lane\'s own machine or through the committed template, and through the lane\'s own machine alone when that machine was generated by `lane emit` and binds no template. A replaying log is refused with the directory where it was, so a genuinely broken lane still shows up on every sweep. The issue does NOT have to be closed: a bricked ledger whose issue is open had no route out at all — repair needs the replay that is broken, `lane settle` needs a board closure, and the closed-issue gate refused the archive — so its `laneConcurrencyCap` seat stayed held and the only remedy left was hand-deleting an append-only log. A log no machine can fold is a lane nobody can drive, whatever the issue says, which is the whole thing that gate was protecting. The claim goes with the lane: a live `lane-claim` marker on the issue is RETRACTED before the move, so the issue does not read as held by a lane that is no longer there, and a claim this caller does not name refuses at 31 rather than being swept out from under its driver — `--token` names it; a dead seat is taken back through succession — `fabrika lane adopt <lane> --session <dead> --reason "<why>"` then `fabrika lane release <lane> --token <the token adopt printed>`, which deletes the marker — because adopt alone leaves the claim standing and the archive refuses again. Retraction runs before the move, so a move that then fails leaves an unclaimed lane where it was rather than a claim nothing can release. The replay judgement runs before either, because it is local and free, so a replaying lane costs no board read at all. The archived root is a SIBLING of the lanes root, never a directory under it, which is why no sweep needs a skip rule: `reconcile` and `migrate` read the roots they are handed and are never handed this one. The record stays readable — `fabrika lane history <lane> --root <archived-root>` and `fabrika lane brief` read an archived lane when pointed at it. stdout is {answer:"archived", lane, issue, from, to, through, defects, retracted}, where `through` is "current" or "candidate" — which machine refused the log — `defects` names why, and `retracted` lists the marker comment ids the claim retraction deleted (empty where the issue carried no claim, and on a chore key, which has no claim thread). Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there), 8 (the move did not land, or a claim marker would not retract — the lane is NOT archived), 9 (the move reported success and the destination does not read back), 11 (the lane, a committed template, the destination probe or the claim thread could not be read, or a committed template that is this lane\'s own could not be built into a candidate — UNKNOWN, never a move; a GENERATED machine binds no template and is not that case, so its own fold is the whole judgement), 14 (the archived root already holds a lane by this key — a move onto it would bury a record), 21 (the key is not a lane key), 31 (the issue carries a live lane claim this caller did not name — pass --token, or clear a dead seat with `fabrika lane adopt` THEN `fabrika lane release`, since adopt alone leaves the claim standing), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default roots), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 50 (the log replays, so every sweep can judge it and there is nothing to move out of scope). `--sweep` takes no lane and keeps the closed-issue gate this single-lane route dropped, because that narrowing was ruled for the route an operator takes by hand and nothing has ruled on a sweep that moves a lane whose issue is still open: it walks the lanes root, archives each lane whose issue reads closed AND whose log will never replay, and prints one row per lane it examined — archived, or skipped with the reason (replays / issue open / unjudgeable / key names no issue / unreadable / the archived root already holds it / the move did not land). A lane whose move landed and whose destination does not read back is a THIRD outcome, "moved-unverified" and never a skip: that directory is no longer where it was, so a row calling it skipped would state the one thing now known to be false. A lane whose judgement is UNKNOWN is never archived, and a directory name that resolves to no issue number is skipped and named rather than fatal, so one unaddressable key costs no other lane its sweep. It retracts no claim, so a swept lane whose issue still carries a live lane-claim marker leaves that marker standing — the named single-lane route is the one that retracts. Its stdout is {answer:"swept", root, present, archivedRoot, examined, archived, lanes}. It exits 0 on every skip — a skip is a row, not a failure — and non-zero only where the lane set is UNKNOWN (11) or a move that cleared both gates did not land (8) or does not read back (9); the rows reach stderr either way, so a partly-applied sweep is always enumerable. Examples: fabrika lane archive 6037 · fabrika lane archive 8810 --token <the token `fabrika lane claim` printed> · fabrika lane archive --sweep',
	),
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
		'Append the terminal the board\'s own closure proves, to a lane whose own flow never reached one. Two stranded shapes, one verb: a lane parked while its issue closed not planned or duplicate owes no artifact, and a lane sitting in build or review while its issue closed completed over a merged PR was hand-shipped past the ledger. Neither can be ended by the operator\'s six — DONE claims an open PR that is not there, BLOCKED only parks, UNBLOCKED resumes work that is already over — so the only remedy was deleting the lane directory, which erases an append-only history instead of recording an outcome. This appends ONE line and moves nothing on disk; `fabrika lane history <lane>` still reads the whole log. The board read is the whole entitlement. A `state_reason` of not_planned or duplicate records `<TASK>.CANCELLED`; `completed` PLUS at least one merged pull request whose body links the issue (closing keyword or `Part of`) records `<TASK>.LANDED`, carrying those pull request numbers as `landed` and the first one\'s merge commit as `sha`. The pull requests are read only on the completed arm, so a cancellation costs one board read. Everything else appends nothing: an open issue refuses at 49, and a read that failed, a close carrying no `state_reason`, a reason outside the three, or a completed close naming no merged linking PR are all UNKNOWN at 11 — a completed close with nothing that did it is genuinely unread, not a landing. --landed-by <pr> supplies exactly that missing link and nothing more, for a closure a human closed by hand over a merge whose body cites some other issue: the board must still read that PR merged, so an unmerged one refuses at 23 and one this repository does not hold at 22, both with the log unappended, and an unreadable read stays UNKNOWN at 11. A body-proven landing is judged FIRST and wins, so the flag can only ever fill a gap; the line it appends carries `assertedBy: "caller"` beside its `landed`/`sha`, which is how this verb\'s own stdout and `lane history` tell an asserted link from a body-proven one, and a body-proven line carries no such field at all. Neither event is an operator event: the operator\'s six are unchanged and `lane transition` refuses both, so `DONE`\'s proof semantics are untouched. A live authorized lane claim refuses at 31 unless --token names it, so a lane another session is driving is not ended underneath it; an unreadable claim thread is UNKNOWN, never "unclaimed". The lane then folds to the terminal stateValue "cancelled" or "landed" — its own, neither "complete" (which would claim this lane\'s flow finished it) nor "tripped" (which would claim it failed) — so `lane status` and `lane stale` read it done and it holds no seat against `laneConcurrencyCap`. The offline gate runs first, so a lane already carrying a terminal costs no board read at all. stdout is {answer:"settled", lane, issue, previous, event, current, taskAffected, outcome} plus `landed` and `sha` on a landing, and `assertedBy` on an asserted one. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there), 8 (the append did not land — the terminal is NOT recorded), 11 (the lane, the board closure, the pull requests, the --landed-by pull request or the claim thread could not be read, or the closure proves no terminal — UNKNOWN, never an append), 12 (this lane already carries a terminal, or the task is in a final — there is nothing here to settle), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 19 (the key names no issue, so the closure gate can never be satisfied — the refusal says which of the two: a chore lane, which is not settleable at all, or an issue-kind directory name carrying no leading issue number), 21 (the key is not a lane key), 22 (--landed-by names no pull request this repository holds), 23 (--landed-by names a pull request that has not merged), 31 (the issue carries a live lane claim this caller did not name), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 40 (another writer holds the ledger lock — retry). Examples: fabrika lane settle 5983 · fabrika lane settle 6100 --landed-by 6878',
	),
);

const reconcile = leafCommand(
	"reconcile",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription("judge every lane and report, appending nothing"),
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
		'Sweep every lane on disk and answer which ones recorded a merge closure the board disagrees with, then append the line that corrects it. The machine sends a merged `Part of #N` back to `queued` instead of folding the lane to a terminal, but the routing fact rides the recorded event as a `partial` payload — so every lane shipped before that field existed replays through the guard\'s fallthrough and still folds to `complete` over an open, buildable issue. The log is append-only and no recorded line is ever rewritten: the repair is a `<TASK>.CORRECTED` line naming the earlier line\'s own `at` and carrying the payload it should have had, which the fold resolves before any message reaches the machine. A lane is nominated OFFLINE — the latest recorded event that reached a `merge:partial` cell carrying no answer its reader can trust, located off the compiled machine, so a region declaring no partial arm (an epic tail) nominates nothing — and only such a lane costs a board read. Two lines qualify: one that recorded no `partial` at all, and one whose `partial: false` names no `landed` evidence, which is the mark of the nominator blind to a merged `Part of #N` that wrote every `false` before the fix that read closures off the named PR. It is the evidence that tells the two apart and never the line\'s timestamp, since a cutoff date would hold only while that fix\'s own merge beat it. The second kind is re-read at most once — the correction this sweep appends is what settles the line, never the polarity it lands on. Budget that as ONE read per never-confirmed lane, not hundreds per sweep: whichever way the board answers, the answer is appended as a correction — `partial: true` on a merge that left its issue open, `partial: false` on one that closed it — so the line carries its own answer and never nominates again, and the ship stage now records `false` too. The first pass over a backlog shipped before that field existed is still hundreds (228 of one repo\'s 298 guard-declaring lanes when it was counted, and a run has exhausted a rate limit part-way through), but it is paid once: every pass after it costs only the lanes shipped since, and a rate-limited run leaves every lane it did confirm confirmed, so re-running resumes rather than restarts. --check withholds the append, so it buys nothing for the next sweep and pays the same reads twice. That read is ONE pull request: the line being corrected already names the merge it stands on, and it is read directly rather than nominated, because a MERGED `Part of #N` is invisible to both nomination reads (the closing edge is built from closing keywords, the search half is `is:open`) — the union finds nothing for exactly the case this verb catches. A line naming no PR falls back to the nominator at open-or-merged. Each lane carries one verdict: "current" (no recorded event reached the guard without its answer), "misrouted" (the board proves the merge partial, --check withheld the append), "corrected" (judged partial and appended, which sends the lane round again), "closes" (the board proves the merge closed the issue, --check withheld the append), "confirmed" (judged closing and appended — the lane still folds to complete, and the line now says so, so the next sweep skips it), "unmigrated" (this lane\'s own machine declares no merge-closure guard and the committed template it booted from does, so nothing here can judge its merge — run `fabrika lane migrate` and re-run this sweep; an emitted epic machine and an epic tail declare none by design and read "current"), "unknown" (the board did not answer, it answered and named no merged PR linking the issue, or the lane drives no issue — a read that proves no closure is never read as "closes"), "unreadable" (the lane record or its log could not be read, or the log does not replay — a row, since nothing here caused it and nothing here can fix it) or "unappended" (this run tried to append and could not). Every judged row carries corrects: {task, at, state, pr} and the from/to stateValue the correction moves the lane between — equal on a closing read, which is the row saying it moved no task; a misrouted or corrected row also carries the merged prs proving the merge partial, and a closes or confirmed row the board\'s own why instead. stdout is {check, scanned, summary, lanes}. Both default roots are swept unless --root names one, which is read as a relocated root whose lanes may have booted from either committed template; an absent root holds no lanes and is not a fault. Exits 8 (at least one append this run tried did not land, so whether that lane still needs a correction is UNKNOWN — those lanes are named on stderr and so are the ones that were corrected), 11 (a committed template could not be read, or a root is there and could not be listed — the lane set is UNKNOWN, never empty), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane reconcile --check · fabrika lane reconcile',
	),
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
		'Sweep every lane on disk and record the event its own artifact already proves but its ledger never learned. A shell posts its SHA-bound verdict on the artifact and then records the event; killed between the two, it leaves the verdict standing and the ledger silent, and the lane sits non-terminal until a driver happens to run `lane prove` by hand — one lane sat in review for 448 minutes carrying a proven PASS on its PR. Each non-terminal lane\'s active tasks are read off the fold, and a task standing in a leaf that OWES a provable event is asked about: PASS out of review, PASS out of review:ui — the arms of `lane prove`\'s claim table whose artifact only a FINISHED shell can have produced. Two arms are left out, and for one reason: a shell that is merely still working satisfies each of them. The BLOCKED a reviewer\'s park claims is negative ("the run reached no verdict"), proven by the absence of a contradiction rather than by an artifact anyone posted, so a sweep standing on it would park every lane whose reviewer is still running. The DONE out of build or build:ui claims OpenPull, which proves on the existence of one open PR linking the issue — a fact about the PR being open, never about the builder being done with it — and a lane in a repair round carries exactly that PR for the whole round, so a sweep standing on it would move the lane to review under the live builder. It introduces NO proof path and NO second way onto a log: the bar is `lane prove`\'s read, unchanged, and the append is `lane transition`\'s whole path — the same machine validation, the same proof gate and the same ledger lock — so what moves is only who runs them. It records on the literal `proven` and on nothing else; `not-required`, `uncontradicted` and every refusal code leave the lane byte-identical and land as their own row, so an unreadable board is a row to re-run rather than a lane moved on a read nobody made. --spawns adds the SECOND arm, and it parks rather than finishes: a lane standing in build or build:ui whose build claim has outlived the builder\'s own 40-minute budget, with NO lane branch in this clone and NOTHING on the surface that lane\'s role publishes to, is a lane whose shell is gone and which will never move again — lane 7778 held a seat against the concurrency cap for five days because recording its BLOCKED --cause spawn-dead was a driver\'s act and its driver was gone. The publication surface is the role\'s and not the leaf\'s: a single lane and an epic tail publish an open PR whose body links the issue, and an epic child publishes onto its own lane branch and opens no PR at all, so on a child the branch read IS that conjunct and no board read is made. That whole conjunction is the predicate, read through the same `../build/dead-claim.ts` budget proof the spawn-dead unpark row reads, and every answer short of it is a "working" row that changed nothing: a claim inside its budget (the live-but-quiet builder), a branch still carrying the dead builder\'s commits, an open PR, or no claim at all. A read that did not settle — an unreadable board, or several open PRs linking the issue — is "unreadable" and never dead, and its reason names the read that did not settle rather than one nobody made. It retracts nothing HERE, and it is not the end of the chain: the park it records is exactly the pair recipe/parks.ts keys its spawn-clear clearance on, so `recipe unpark` retracts the claim on the same age proof one verb later with no human between the two; the authorizing ruling is cited by the @ruling tag in packages/fabrika-cli/src/lane/recover-verb.ts. Its rows are "parked" (appended) and "parkable" (--check withheld it), and it is OFF unless the flag is passed, because it spends a board read per lane standing in build. Budget a recoverable lane at TWO board reads — this sweep asks what the proof says, and `lane transition` asks again under its own gate before appending, which is that gate declining to take this sweep\'s word for it — and every other judged task at one. --check pays the first read alone and appends nothing. Each row carries one verdict: "recovered" (proven and appended; its `to` is the append\'s OWN answer, which `lane transition` derives under the ledger lock from a fresh re-read of the log, so a writer that landed after this sweep\'s unlocked fold is accounted for — every other row\'s `to` is the offline preview, which is all a move that never happened has), "recoverable" (proven, --check withheld the append, so its from/to is that preview), "unproven" (the proof did not answer proven — the row carries its `proof` label and `proofCode`, so a not-required is told from an unreadable board without re-reading anything), "refused" (the artifact proves the event and the append path refused it — this lane\'s own machine, or its config — so a re-run buys nothing), "contended" (40: another writer held this lane\'s ledger lock for the whole wait budget, so nothing was validated and nothing appended; the same event is still the right one and the sweep says so on stderr, which is why this is not bucketed with "refused"), "current" (the lane is non-terminal and no active task stands in a leaf that owes a provable event), "terminal" (the fold is done, so nothing is owed and no board read is spent), "unreadable" (the lane record or its log could not be read, or the log does not replay — a row, since nothing here caused it and nothing here can fix it) or "unappended" (this run tried to append and could not). stdout is {check, scanned, summary, lanes}. Both default roots are swept unless --root names one; an absent root holds no lanes and is not a fault. Every root is LISTED before any lane is appended to, so an unlistable second root refuses a run that has written nothing rather than discarding the rows of a first root it already recovered. Exits 8 (at least one append this run tried did not land, so whether that lane is still missing its event is UNKNOWN — those lanes are named on stderr and so are the ones that were recovered), 11 (a root is there and could not be listed — the lane set is UNKNOWN, never empty, and nothing was appended), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane recover --check · fabrika lane recover · fabrika lane recover --spawns --check · fabrika lane recover --spawns',
	),
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
	]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's events. A lane is keyed by the issue number it drives, or by name as `chore:<name>` for a chore that has no issue number",
	),
);
