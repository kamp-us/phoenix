/**
 * The `lane` verb group — `fabrika lane <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flags (`--help` is the interface,
 * so each carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision lives in the verb modules beside it, which is what makes each refusal testable without
 * spawning a process.
 */
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {Effect, type FileSystem, Option, Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {claimReader} from "../build/claimants-verb.ts";
import {assemblyRefreshKey} from "../config/keys/assembly-refresh.ts";
import {laneConcurrencyCapKey} from "../config/keys/lane-concurrency-cap.ts";
import {machineryLapsKey} from "../config/keys/machinery-laps.ts";
import {parkCauseKey} from "../config/keys/park-cause.ts";
import {readKey} from "../config/read-key.ts";
import {resolveEntrypoint} from "../delegate/entrypoint.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {SHIP_CLASS_NAMES} from "../review/classes.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {claimOwnership, runAmend} from "./amend-verb.ts";
import {closedReader, runArchive} from "./archive-verb.ts";
import {runAssemblyBody} from "./assembly-body-verb.ts";
import {FIELDS, runAssemblyPr} from "./assembly-pr-verb.ts";
import {runAssembly} from "./assembly-verb.ts";
import {runBrief} from "./brief-verb.ts";
import {claimHoldReader} from "./claim-hold.ts";
import {runLaneAdopt, runLaneClaim, runLaneRelease} from "./claim-verb.ts";
import {runClear} from "./clear-verb.ts";
import {closureReader} from "./closure.ts";
import {CLASS_UNRECOGNISED} from "./codes.ts";
import {runDispatch} from "./dispatch-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {expectationReader} from "./expectation.ts";
import {deriveRepoRoot, onGround, repoGroundRefusal, resolveRootOrRefuse} from "./ground.ts";
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
import {runPush} from "./push-verb.ts";
import {type ReconcileRoot, runReconcile} from "./reconcile-verb.ts";
import {DEFAULT_TRUNK_REF, runRefresh} from "./refresh-verb.ts";
import {keyRefusal} from "./refusals.ts";
import {classesForEvent, PARK_CAUSE_TOKENS} from "./report.ts";
import {runReport} from "./report-verb.ts";
import {boardReaders, runSettle} from "./settle-verb.ts";
import {DISPATCH_BUDGET, SHELL_BUDGETS} from "./shell-budget.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {
	DEFAULT_ARCHIVED_LANES_ROOT,
	DEFAULT_CHORES_ROOT,
	DEFAULT_LANES_ROOT,
	type LaneRef,
} from "./store.ts";
import {runTransition} from "./transition-verb.ts";
import {DEFAULT_VIEW_PORT, listeningAt, runView} from "./view-verb.ts";

const laneArgument = Argument.string("lane").pipe(
	Argument.withDescription(
		"the lane key — the issue number the lane drives, or `chore:<name>` for a chore lane. A directory name carrying a dot-separated suffix after the number (`8012.frozen-deadlock-<stamp>`) still names issue 8012, so a quarantined lane is addressable by every verb here",
	),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		`the lanes root directory (default: the owning repository's ${DEFAULT_LANES_ROOT}, derived off the primary checkout so every worktree reads the same ledger; or ${DEFAULT_CHORES_ROOT} for a chore key). One that resolves inside a linked worktree is a copy of that ledger and is refused at 65, absolute or relative`,
	),
);

/**
 * Resolve the `lane` argument to a key and its directory, or refuse it — the one step every keyed
 * verb shares, so a malformed key is caught before any verb reads or writes anything, and the ground
 * under the resolved root is proven before either. An explicit `--root` wins; otherwise the root is
 * derived off the repository the cwd belongs to, so a linked worktree reads the same ledger
 * as the primary checkout instead of proving the lane absent against its own empty one.
 */
const onKey = <R>(
	verb: string,
	raw: string,
	root: Option.Option<string>,
	run: (key: LaneKey, ref: LaneRef) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> => {
	const parsed = parseKey(raw);
	if (parsed._tag === "Malformed") return Effect.succeed(keyRefusal(parsed));
	if (Option.isSome(root)) {
		const ref = laneRef(parsed.key, root.value);
		return onGround(verb, [ref.root], process.cwd(), () => run(parsed.key, ref));
	}
	return Effect.gen(function* () {
		const path = yield* Path.Path;
		const ground = yield* deriveRepoRoot(process.cwd());
		if (ground._tag !== "Derived") {
			return repoGroundRefusal(`fabrika lane ${verb}`, ground);
		}
		const ref = laneRef(parsed.key, path.join(ground.repoRoot, defaultRoot(parsed.key)));
		return yield* onGround(verb, [ref.root], process.cwd(), () => run(parsed.key, ref));
	});
};

/**
 * Resolve the `lane` argument for a verb whose ground is the **board**, not the disk — `claim` and
 * `release`, which race a marker on the issue a lane drives and read no lanes root at all. They take
 * the key alone rather than a ref, so neither can reach a root the cwd would decide, and neither owes
 * the repo probe {@link onGround} makes.
 */
const onBoardKey = <R>(
	raw: string,
	run: (key: LaneKey) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R> => {
	const parsed = parseKey(raw);
	return parsed._tag === "Malformed" ? Effect.succeed(keyRefusal(parsed)) : run(parsed.key);
};

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
		"Create a dedicated detached git worktree and run codex exec with a fixed skill preload envelope and the emitted lane brief unchanged. Preserves Codex model and policy configuration. On an epic run's child it first refreshes the assembly branch the worktree is about to be cut from, through `lane refresh` itself and before the brief is emitted, gated by `assemblyRefresh.onDispatch`: under the shipped `off` it fetches, merges and reads nothing, so the dispatch path is byte for byte the one it is today, and `on` merges the trunk in so the child builds and runs its verbs in a tree at least as new as the trunk. A conflict there refuses at 42 with the branch proven back at its pre-merge head and no worktree created — record the park the refusal names (--cause assembly-conflict) rather than dispatching over the unrefreshed branch. Requires a new task terminal and fresh artifact proof; process exit zero alone is not completion. stdout: {harness, task, event, worktree}. Worktrees are retained. Exits 11 (missing input, isolation, process or state failure), 18 (unsupported harness or inactive state), 22 (no unique terminal), plus lane refresh, lane brief and lane prove refusals. Example: fabrika lane dispatch 5673 --harness codex --skills /installed/fabrika/skills --worktree /scratch/lane-5673",
	),
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
		"One lane's derived state, folded fresh from the whole events.jsonl every invocation — no resident process, no snapshot. stdout is the operator's status JSON: compound `stateValue` (active phase → per-task leaf state, future phases \"waiting\", or a bare terminal), `status` active/done, and per-task `{retries, maxRetries, …}` context with the tripped tasks in `errors`. A lane whose task reached a `done:diagnosis` arm's final answers that leaf as the bare terminal — `diagnosed` on the coder machine — rather than the workflow's `complete`, so a finished investigation reads as itself and never as the shipped lane's word. Exits 4 (workflow.json or events.jsonl read in full and not the shape — every defect on stderr), 7 (no lane there — copy a workflow template to open it), 11 (the lane could not be read — its state is UNKNOWN, never fresh), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane status 5673 · fabrika lane status chore:park-sweep",
	),
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
		`a lane class standing at this event (repeatable) — the fact a \`class:<name>\` transition arm routes on, one of: ${SHIP_CLASS_NAMES.join(", ")}. Omit it and the classes already standing are left alone; a spelling outside the set is refused, never routed as unclassed.`,
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
		const parkCause = yield* readKey(process.cwd(), parkCauseKey);
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
		"Record one operator event on the lane's append-only log — after the machine accepts it, never before, and after `lane prove`'s own read proves the artifact behind it. The proof is this verb's, not a command a driver is told to run first: a DONE and a PASS reach the log only with their artifact behind them, a reviewer's park only while no FAIL at the head says the run reached a verdict, and every other event answers not-required without a board read; a refusal comes back on the prover's own code with the log byte-identical, and the remedies are `lane prove`'s, unchanged. stdout is `{previous, event, current, taskAffected}` with the two stateValues around the fold, plus `waitGrant` when the resume granted waits, `rationale` when it named why the park was cleared, and the prover's own `deferred`/`partial`/`landed`/`diagnosis` where the read answered them — the same fields `lane report` records, so the driver's line and a shell's carry the same facts. An invalid event — no cell in the task's current state (tea's NoCellError, surfaced verbatim), outside the operator's set, a task outside the active phase, a finished workflow — is refused loudly and the log is left byte-identical. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (a lane, board or tree read failed — whether the event is proven is UNKNOWN), 12 (the event is refused, log unappended), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 22/23/24/25 (`lane prove`'s own refusals — artifact provably absent, a namespace with no still-binding verdict, a FAIL under a claimed PASS or park, several candidates — log unappended, remedies unchanged), 35 (--cause is outside the closed park-cause set, or rides on an event that is neither BLOCKED nor the machinery LAP), 52 (a BLOCKED names no cause at all, under a repo declaring `parkCause.uncaused: \"refuse\"` — name one), 38 (--class is outside the closed lane-class set), 36 (a resume would restore the state and not the budget it lands on — out of an error final, record the cleared round first and the two land in either order, `build clear` where a pull request carries the founder's grant and `lane clear` where the lane has none; out of a wait park, grant the waits on this same resume, which `recipe unpark` does once it has proven the queue moved), 47 (--grant-wait is not a whole grant of at least one wait, or rides on an event that is not UNBLOCKED), 53 (--rationale says nothing, or rides on an event that is not UNBLOCKED), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). A cleared round is NOT recorded here: it is a `<TASK>.CLEARED` event `build clear` or `lane clear` appends, it targets no state, and the operator's set is unchanged. An optional --cause lands on a BLOCKED's event line and is what `recipe unpark` keys its recipe table on; every cause also carries a route — `driver` or `founder` — saying whose failure the park is. A BLOCKED with no cause is the bare park it always was and routes to a human, unless `.fabrika.jsonc` declares `parkCause.uncaused: \"refuse\"`, which refuses it at 52 with the log unappended. A repeatable --class lands the lane classes standing at the event on the same line, and is the fact the machine's `class:<name>` arms route on — `--class ui` on a WIP sends the lane to `build:ui`, and it stands until another event names a different set. An optional --grant-wait lands the waits a resume buys on the same UNBLOCKED line, so one recorded event both clears the park and pays for the read the lane resumes to take; it is the human fallback for a `human:queue-stall` whose `recipe unpark` proving read cannot run, and `build clear` is not it — that buys a repair round and never a longer wait. An optional --rationale rides the same UNBLOCKED and says why the park was cleared — the driver's own recommendation, which `recipe unpark` passes when it clears a driver-routed park, and which `lane status` reads back as the task's standing `rationale`. Examples: fabrika lane transition 5673 DONE · fabrika lane transition 5673 UNBLOCKED --grant-wait 1",
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
				"why this round is granted — the driver's own recommendation, recorded on the CLEARED line. Required: a grant nobody can review afterwards is not one.",
			),
		),
	},
	Effect.fn(function* ({lane, root, task, rationale}) {
		yield* emit(
			yield* onKey("clear", lane, root, (_key, ref) =>
				runClear({...ref, task: Option.getOrNull(task), rationale}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Grant one repair round to a lane with no pull request to clear."),
	Command.withDescription(
		"Grant one repair round on a lane whose budget is spent, by appending the `<TASK>.CLEARED` event that is the only source of a repair budget. This is the driver's seat, for the lanes `build clear` cannot reach: that verb is PR-keyed from its first line, so an epic child and a chore lane — neither of which opens a pull request — parked at their cap with a door nothing could walk. The round is DERIVED, never typed: it is the round the task's own declared cap freezes at given the grants already in its log, so one call buys exactly one round and the next round needs its own call and its own recommendation. stdout is `{answer, lane, task, round, budget, rationale}`, where `answer` is `cleared` on a grant that landed and `held` on one the log already carried — a grant is keyed by its round and set-semantic, so a re-run doubles nothing. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the round is NOT cleared), 11 (the lane could not be read), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 39 (no .git entry at or above the cwd), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 47 (the task still has budget to spend, so there is no round to grant), 53 (--rationale says nothing). It grants a repair round and never a longer wait — waits ride their own resume through `lane transition --grant-wait`. Recording the grant does not move the task: the park's door is still the `UNBLOCKED`, and the two land in either order. Example: fabrika lane clear 8820 --task issue --rationale \"the three FAILs were one finding, now answered\"",
	),
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
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name the proof reads against (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, token, root, task, pr, comment, cause, classes, repo}) {
		const parkCause = yield* readKey(process.cwd(), parkCauseKey);
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
		"Record a spawned shell's terminal token on the lane's append-only log: the token→event map in code (report.ts) picks one of the operator's events, the mapped event is then proven exactly as `lane prove` proves it — a token is a self-report, so a DONE and a PASS reach the log only with their artifact behind them, a reviewer's park only while no FAIL at the head says the run reached a verdict, every other event answering not-required without a board read — and only then does the append ride transition's exact path, validated against the folded state first, refused unappended otherwise. Optional --pr/--comment refs land on the event line itself, so the event names its evidence (visible via lane history), a repeatable --class lands the lane classes standing at the event (what the machine's `class:<name>` arms route on), and an optional --cause names why a BLOCKED parked, from a closed set in code — the key `recipe unpark` seats the park against, without which every BLOCKED is novel and costs a human UNBLOCKED; every cause carries a route beside it, `driver` or `founder`, saying whose failure the park is, and a repo that declares `parkCause.uncaused: \"refuse\"` refuses a cause-less BLOCKED at 52 rather than recording one. One more field lands on the line and it is the prover's, never a flag: `deferred` names the namespaces the proof subtracted from this cell's bar and handed to a later one — the routed `review-ui` an epic child owes its epic's tail — and is absent wherever the bar was whole. `partial` is the second of that kind and rides the ship stage's DONE: it says whether the merge behind this terminal carried `Part of #N` and left the issue open, which is what the machine's `merge:partial` arm routes on. It rides at BOTH polarities — `true` on a partial merge, `false` on a closing one — so the line records that the closure was read and `lane reconcile` never buys that read again; it is absent wherever no closure was read, which is every event but the ship stage's DONE, plus a ship DONE whose read answered `unknown`. `landed` rides beside it as that read's evidence — the merged PRs the closure judged, absent wherever `partial` is — so a recorded `false` says which reader wrote it and not only which way it fell, which is what `lane reconcile` reads to tell a real answer from the old nominator's fallthrough. --pr is what that read reads: the ref is handed to the prover as well as recorded on the line, because the closure is judged off exactly that PR. A queue wait is floored as well as counted: a WIP standing in `ship:queued` is refused at 55 unless 480s of elapsed time — the shipper's own watch horizon — have run since that task's last recorded line, so the wait budget measures how long a PR has sat rather than how fast a driver passes, and the refusal names the seconds still to run. `diagnosis` is the third field of that kind and rides a `DONE` out of `build`: it says the prover stood this terminal on a diagnosis comment rather than a pull request, which is what the machine's `done:diagnosis` arm carries a finished investigation to its own `diagnosed` terminal on instead of the `review` it opened no PR for. It rides at `true` only, and only off `lane prove`'s no-PR arm — all three builder terminals report one `DONE`, so a `SHIPPED-PR` and an epic child's `BUILT-NO-PR` carry no such field and fold to `review` exactly as they always did. stdout is `{token, previous, event, current, taskAffected}` plus the refs, plus `deferred` when the proof deferred anything, `partial` at whichever polarity the closure read answered, `diagnosis` where the terminal stood on one, and `landed` where it answered at all. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (a lane, board or tree read failed — whether the event is proven is UNKNOWN), 12 (the mapped event is refused, log unappended), 13 (the task is not in the machine, names no issue, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 22/23/24/25 (`lane prove`'s own refusals — artifact provably absent, a namespace with no still-binding verdict, a FAIL under a claimed PASS or park, several candidates — log unappended, remedies unchanged), 32 (the token is no shell's terminal token — refused, never interpreted), 35 (--cause is outside the closed park-cause set, or rides on an event that is neither BLOCKED nor the machinery LAP), 52 (a BLOCKED names no cause at all, under a repo declaring `parkCause.uncaused: \"refuse\"` — name one from the closed set), 38 (--class is outside the closed lane-class set), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 55 (a `ship:queued` re-fold arrived inside the elapsed-time floor, or the clock on that task's last line reads as no date — log unappended, the wait unspent, and the only remedy on the first is time). One group of tokens belongs to no shell: the machinery group (REPLAY-COLLIDED, BASE-DRIFTED, QUEUE-EJECTED, SEAT-DIRTY, SHELL-DEAD), which a driver records about the pipeline itself. Each maps to the machine's LAP event, spending the lap budget instead of the repair one, and each carries its own cause off the same closed set with no --cause typed — pass one to override it, and a cause outside the set still refuses at 35. Examples: fabrika lane report 5736 --token SHIPPED-PR --pr <pr-url> · fabrika lane report 8810 --task issue_8819 --token REPLAY-COLLIDED",
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
		"Read the artifact a lane event claims — artifacts over self-reports. Three events carry a claim, and which artifact answers them is the task's shape. On a single-issue lane and on an epic run's tail: a DONE out of `build` claims an open PR whose body links the task's issue (or, for an investigation, the diagnosis comment a no-PR builder posted since the task entered build, which is the one arm that answers a `diagnosis` field beside the proof — relayed onto the recorded line by `lane report`, where the machine's `done:diagnosis` arm reads it), and a PASS out of `review` claims a current-head verdict in every namespace that PR's diff derives, governance included — minus, and only minus, a routed namespace this very event's arm hands to a later cell of this lane's own machine (`--class ui` into `review:ui`), which then proves the whole set. On an epic run's child, which opens no PR at all: a DONE out of `build` claims the commits its lane branch adds over `epic/<n>` in THIS tree, and a PASS out of `review` claims a range-scoped verdict on the child issue still bound to the content that range carries now, for every namespace that range derives except the routed one — a child's deferral is unconditional and its creditor is the tail. The third is the reviewer's park — a BLOCKED out of `review` or `review:ui` on a lane that owns a PR — and it is the one negative claim: it says the run reached no verdict, so a still-binding FAIL refuses it at 24 and every unreadable half records it. Every other event answers `not-required` at exit 0. A DONE out of `ship` or `ship:queued` answers `not-required` too and reads one thing more on the way: whether the merge behind it closed this issue or carried `Part of #N`, answered as a `closure` field reading `closes`, `partial` or `unknown` beside the usual ones, with a `landed` field naming the merged PRs an answered read stood on, both relayed onto the recorded line by `lane report`. That closure is read off the PR --pr names and NOT off the nominator, which cannot see the subject — GitHub builds the closing edge from closing keywords and the search half pins `is:open`, so a merged `Part of #N` is a node in neither. It is a routing fact, not a claim: it refuses nothing about the merge and nothing about the board either — no --pr, or a PR read that failed, answers `unknown`, which records NO `partial` and leaves the line for `lane reconcile` to read again rather than stranding the shipper. Writes nothing — the append stays `lane transition`'s. The refusals are artifact-independent, so the range arms take no new seat. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (a lane, board or tree read failed — the proof is UNKNOWN, never proven; an epic branch this tree does not carry is UNKNOWN too, as is a shallow clone whose graft boundary is the assembly tip or the child's fork point, where the stderr names `git fetch --deepen=25`), 13 (the task is not in the machine, or names no issue), 21 (the key is not a lane key), 22 (the artifact is provably not there), 23 (a required namespace has no current or still-binding verdict — re-read, record nothing), 24 (a FAIL under a claimed PASS, or under a reviewer's claimed park), 25 (several open PRs link the issue, or several lane branches carry the child's commits). Exits 38 too (--class is outside the closed lane-class set), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika lane prove 5673 DONE",
	),
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
		"The lane's append-only event log, verbatim — one `{task, event, at}` per recorded event, in append order, carrying the optional `pr`/`comment` refs where the event was recorded with one as its evidence, the `round` a `CLEARED` clears, the `classes` a class-carrying event named, the `diagnosis` a build `DONE` proven off a diagnosis comment carries, and the `deferred` namespaces a proof subtracted from that event's bar and handed to a later cell — the routed `review-ui` an epic child owes its epic's tail, absent wherever the bar was whole, and the `partial` a ship's DONE carries at either polarity once its closure was read — `true` where the merge left the issue open, `false` where it closed it, absent where nobody read it, and the `landed` PRs that read stood on beside it; the log IS the history, and `from`/`to` are reconstructible by folding, never stored. A lane with no events yet answers `[]`. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika lane history 5673",
	),
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
		"The lane's compiled machine topology — phases in order, the two workflow terminals, and per task its initial state, retry budget, and each state's legal events (everything absent refuses at transition time). Exits 4 (workflow.json read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika lane print 5673",
	),
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
	},
	Effect.fn(function* ({lane, root, repo}) {
		const cap = yield* readKey(process.cwd(), laneConcurrencyCapKey);
		yield* emit(
			yield* onKey("open", lane, root, (key, ref) =>
				runOpen({
					...ref,
					templatePath: templatePath(key._tag),
					issue: keyIssue(key),
					expectation: expectationReader(Option.getOrNull(repo), process.env),
					priorLane: priorLaneReader(Option.getOrNull(repo), process.env),
					cap,
					claimed: claimHoldReader(Option.getOrNull(repo), process.env),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Boot a lane from the committed template its key selects."),
	Command.withDescription(
		"Boot one lane: create `<root>/<key>/` and place a byte-identical copy of the committed template the key selects as its workflow.json — the coder template for an issue number, the chore template for a `chore:<name>` key. An existing lane dir is refused loudly with nothing written — resuming needs no boot, and overwriting a machine mid-drive would corrupt a live fold. An ISSUE key first reads that issue's type, its native sub-issue links and its parent edge: the coder template has one task, so an epic has no machine here and is refused at 46 before anything is written. Both halves of \"epic\" are asked for, because they answer for different moments — a planned epic carries children, and an epic nobody has planned yet carries none and is known only by its `type:epic` label, which is the window the wrong-template lane was booted in. The refusal names which case it is: an unplanned epic goes to `plan-epic` first, and a planned one is booted with `fabrika lane emit <n>`. An epic's CHILD carries neither fact, and is refused at 48 instead — a child gets no lane of its own. That refusal reads the parent lane's emitted task set before it speaks, so it names one of three routes: drive the parent lane when its machine holds the child's task, place the child in the parent epic's `## Dependencies` block and run `fabrika lane amend <parent>` first when the machine provably holds no such task, or — when the parent lane is absent, unreadable or malformed, or the parent number itself did not read — say the task set is UNKNOWN rather than asserting membership either way. Epic wins the precedence, so a sub-epic still routes to `lane emit`. The parent edge rides the issue read already made, so the type and the two link facts cost one read between them; a `chore:<name>` key drives no issue and is never asked. An issue key whose lane directory is absent is then asked whether the board already hangs a pull request off that issue — one only a driven lane opens — and a hit is refused at 63 with nothing written: a ledger is a lane's whole state and `.fabrika/` is gitignored, so removing the directory and booting again restores a spent repair budget and records no granted round anywhere. The refusal names the pull request to drive and the one door out of a spent budget, a recorded round grant (`build clear` on the lane's PR, `lane clear` on a lane that has none). It is asked only over an absent directory, so an existing lane still answers 14 and a re-run reads as the resume it is; an unreadable answer is 11, never \"no prior lane\". So an issue key costs two board reads about the issue itself — its type and links, then this one — and the cap gate below adds one claim-marker read per candidate lane it counts. Last before the write, an issue key is counted against `.fabrika.jsonc`'s `laneConcurrencyCap`: a seat is held by an issue lane under this root that has not folded to done AND whose issue carries a live `lane claim` marker, plus every lane no read can account for — an active lane nobody claims is idle and holds nothing, an archived one is already out of the count, and there is no override flag — raising the number in the config is how it changes. Exits 8 (the write did not land — the lane is NOT booted), 11 (the template, the lane dir's existence, or the issue's child list could not be read — UNKNOWN, never a boot), 14 (the lane already exists), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 46 (the issue is an epic — typed `type:epic`, or carrying sub-issue links — so this template is the wrong machine for it), 48 (the issue hangs under a parent, so it gets no lane of its own — the line names whether the parent lane holds its task, provably does not, or did not read, and routes accordingly), 51 (the lanes root already holds as many CLAIMED lanes as `.fabrika.jsonc`'s `laneConcurrencyCap` allows — the cap, the claimed count, every lane holding a seat and, separately, the number of idle unclaimed lanes are named, and nothing was written), 63 (the board says this issue already had a lane — every pull request that proves it is named, and a re-boot would launder its spent repair budget, so nothing was written). Examples: fabrika lane open 5673 · fabrika lane open chore:park-sweep",
	),
);

const emitLane = leafCommand(
	"emit",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the type:epic issue whose plan topology becomes the machine"),
		),
		root: rootFlag,
		children: Flag.boolean("children").pipe(
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
		const cap = yield* readKey(process.cwd(), laneConcurrencyCapKey);
		const machinery = yield* readKey(process.cwd(), machineryLapsKey);
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
		"Generate a lane machine from the epic's board state: read the epic body's `## Dependencies` topology (the shape `ledger topology` stages) and emit `<root>/<epic>/workflow.json` — one region per child in the coder template's exact shape, phase-sequenced, parallel within a phase. A closed child boots its region in a final state (`completed` → `shipped`, any other close → `frozen`), so a partly-built epic's machine can still terminate. Deterministic: the same epic body bytes and the same child links (number, state and close reason per child) emit the same machine bytes. stdout is {answer:\"emitted\", epic, workflow, phases, children, dropped:{count,rows}, bytes}. An existing lane is refused at 14 with no exception — a lane on disk is never re-emitted over — and the refusal names the whole remedy: retire the lane directory, then re-run this verb. That remedy is for a lane running the wrong MACHINE, which `fabrika lane migrate --check` is what says; a running lane whose PLAN changed goes to `fabrika lane amend <n>` instead, which re-derives the machine over the log it keeps rather than discarding every landed child's record with the directory. Exits 4 (the topology was read in full and does not parse — the defective line, duplicate placement or unplaced requires subject is named; a defective line's refusal also teaches the placement, since editorial or history prose belongs below a `---` thematic break, which ends the section), 7 (the epic is proven absent or closed), 8 (the write did not land), 11 (the epic, its child list or the lane dir could not be read — UNKNOWN), 14 (the lane already exists — retire its directory and re-run to rebuild it), 15 (no `## Dependencies` topology — plan the epic first, or under --children every ref the topology placed was dropped so it declares no child), 16 (the topology references a non-child, named — the refusal names both escapes: re-run with --children, or repair the body with `fabrika ledger retopology <epic>`; unreachable under --children), 17 (the topology holds a cycle, path named — checked over what survives --children), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 51 (the lanes root already holds as many CLAIMED lanes as `.fabrika.jsonc`'s `laneConcurrencyCap` allows — an epic's lane holds a seat like any other while a driver claims it, and the idle unclaimed count is named separately). `.fabrika.jsonc`'s `machineryLaps.onEmit` picks which machine is written: `off`, the shipped default, emits today's bytes exactly, and `on` adds the machinery LAP arms and seeds each task's lap counter, so a machinery failure spends laps rather than the repair budget and a spent lap parks on `human:machinery-stall` rather than on the repair budget's own `human:budget-spent`. The machine is fixed at emission, so flipping it moves no lane already on disk; an unreadable key is UNKNOWN at 11 with nothing written. `--children` starts from the board's live sub-issue list: every ref the topology names and that list does not leaves its phase and every requires list naming it, a phase left with no members is elided, and every ref that went is reported whole on stdout and stderr — the descope escape, opt-in because the same stale ref is a typo on the other reading. Every other topology defect refuses exactly as it does without the flag. Examples: fabrika lane emit 5680 · fabrika lane emit 5817 --children",
	),
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
		"Amend one RUNNING epic lane's task set: re-read the epic body's `## Dependencies` block, re-derive the machine `lane emit` would emit from it today, and — only where the lane's own recorded history survives the change — append one `<EPIC_N>.AMENDED` line and write the re-derived `workflow.json`. This is the verb for a plan that changed after emission: a child added to the topology, or a not-started child re-sequenced into a later phase. Before it existed the only routes were retiring the lane directory and re-emitting, which discards `events.jsonl` and every landed child's record with it, or hand-driving the rest of the epic outside its own ledger. **The log is appended to and never rewritten**: no recorded line is edited, reordered or dropped, the amendment line moves no task and reaches no machine (the fold consumes it, exactly as it consumes `lane reconcile`'s CORRECTED), and its `tasks` payload names the set the re-derived machine holds, which is the whole audit of the change. A task new to the topology boots `queued` carrying no history; a task that has not started may move to any phase, later ones included. **It reconciles nothing** — the block is read exactly as it stands, and a block still naming a child the board closed is `fabrika plan restage`'s to repair, never this verb's to guess at. The lap axis is read off the lane's OWN machine and not off `.fabrika.jsonc`, so a repo that flipped `machineryLaps.onEmit` since the emission does not have that flip land as a side effect of adding a child. **`--defer <task>` is the one route out of a mid-flight descope**, and it is the only way a task carrying recorded history may be dropped: without it that drop still refuses at 61. It requires --defer-reason, and it names the plan change on the amendment line rather than dropping the task silently — the appended line gains a `defers` payload carrying, per task, the id, the `at` of that task's last recorded entry (the bound, derived off the log under the append lock, never typed), and the reason. So the ledger goes on accounting for every entry the dropped task recorded, which is what the 61 refusal was protecting: a later fold excuses exactly those bounded lines from the unknown-task check and refuses anything the bound does not cover, including a child quietly reintroduced after the deferral. Before it writes, the deferred child's own issue is read for a live `build-claim:` marker — a held claim refuses at 64 and an unreadable thread is UNKNOWN at 11, never an absence — so a deferral detaches no worker, kills nothing and discards no branch or worktree. It touches the CHILD ISSUE not at all: `fabrika ledger defer <epic> --child <n>` is the board half, which unlinks it and leaves it OPEN as the follow-up. `lane status` then prints the deferred rows so deferred does not read as completed, and `lane history` still prints the child's own events verbatim. A topology that already derives the machine on disk answers {answer:\"current\"} with nothing appended and nothing written. stdout on a change is {answer:\"amended\", lane, epic, workflow, tasks, added, dropped, deferred, phases, children, bytes}. Every refusal below is proven BEFORE the append and before the machine write, so the lane is byte-identical after it. Exits 4 (the lane record on disk was read in full and is not the shape, or its log already does not replay through the machine it is running — this lane is not one to amend), 7 (no lane there, or the epic is proven absent or closed), 8 (the append or the machine write did not land — the stderr says which, and a recorded amendment whose machine write failed is completed by re-running this verb), 11 (the lane, the epic, its child list or the machine document could not be read — UNKNOWN, nothing written), 15 (no readable `## Dependencies` topology — there is nothing to amend to), 16 (the topology references a non-child, named), 17 (the topology holds a cycle, path named), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 40 (another writer holds the lane's ledger lock — retry once the holder clears), 60 (the new topology places no phase for a task this ledger records as LANDED, named with the final it landed in — the ledger is the only record that work landed, so put the child back in a phase or close the epic over what it built), 61 (a task carrying recorded history cannot replay to the leaf it stands on under the re-derived machine — it is dropped while mid-flight, or its log reaches a cell the new region does not hold; each offending task is named — an authorized descope names it with --defer instead), 62 (the epic body's `## Dependencies` block was read in full and is not a topology — an unparseable line, a child placed in two phases, or a requires subject placed in none; the defect is the ISSUE BODY's, so `fabrika plan restage` is the repair and nothing on disk is at fault), 64 (a --defer does not describe this lane: the task is not in this machine, the new topology still places it, it carries no recorded history to defer, --defer and --defer-reason were not given together, or a live build claim on the child says a worker is still on it; every one of those is repaired by changing the flag or the board, never by re-planning the epic). Example: fabrika lane amend 7499",
	),
);

const assembly = leafCommand(
	"assembly",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run owns the assembly worktree"),
		),
		remove: Flag.boolean("remove").pipe(
			Flag.withDescription("remove the run's assembly worktree instead of placing it"),
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
		"Place the working tree an epic run assembles in — `epic/<n>` checked out at `.claude/worktrees/epic-<n>`, both derived from the epic number and never taken from the caller — and print its absolute path on stdout. The invoking checkout is NEVER switched. Idempotent in both directions: a worktree already holding the branch is resumed and its path answered with nothing written, and a branch that outlived its worktree — the state `--remove` at a terminal leaves behind — is checked out again as it stands, never re-cut off a fresh base. A worktree whose directory is gone but whose record git still carries (`prunable`) is that same state: the registration is cleared and the branch placed again, never answered as a live path. EVERY RESUME FETCHES FIRST and asks one question of the branch it found: does `origin/HEAD` already carry its content. A multi-phase epic that shipped an intermediate tail lands in exactly that state — the branch holds nothing the trunk lacks and conflicts with everything the trunk took since, and until this read the verb could not tell it from an ordinary unlanded resume. The read is squash-aware because this trunk is: ancestry is the fast path, and a branch it calls unlanded is settled by cumulative patch id — the branch's own net diff against the trunk, matched against the patches the trunk took since their merge base, limited to the paths the branch touches (200 commits back). A match means it landed as a squash, and a branch that adds nothing to the trunk at all counts the same. A contained branch is re-cut off `origin/HEAD` in one `worktree add --no-track -B`, and the note says it re-cut and which of the three proofs opened it; its seat, if it still has one, is dropped first WITHOUT `--force`, so git refusing to drop uncommitted work is what keeps unlanded bytes out of a re-cut. Containment is the whole warrant: a branch that is not contained — including one whose squash carried a conflict resolution, so its patch does not match — resumes exactly as before, and an unreadable containment answer — a failed fetch, an `origin/HEAD` naming no commit, a diff or patch read that failed — refuses at 11 rather than resolving either way. No board is read: whether the tail PR merged is never asked. `--remove` is the lane's terminal step, fetches nothing and never forces — a dirty assembly tree is unlanded work, so git's refusal is the answer. Every mode reads the outcome back off `git worktree list` before answering. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (the placement or removal ran and did not read back, or a contained branch's seat would not drop — UNKNOWN), 11 (the working trees, the branches, the fetch, `origin/HEAD` or the containment read could not be read — nothing was placed or removed), 33 (`epic/<n>` is checked out in the main working tree — switch that tree off it first), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane assembly 5680 · fabrika lane assembly 5680 --remove",
	),
);

const assemblyPr = leafCommand(
	"assembly-pr",
	{
		epic: Argument.integer("epic").pipe(
			Argument.withDescription("the epic issue whose run opens the assembly PR"),
		),
		field: Flag.string("field").pipe(
			Flag.withDescription(
				`which piece of the PR's prose to print: ${FIELDS.join(" or ")} — one bare value per call, so the caller interpolates rather than parses`,
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
		"Derive one piece of the prose an epic run's single assembly PR opens with, and print it bare on stdout so the `gh pr create` fence interpolates a value instead of deriving one. `--field title` prints `feat(epic): <the epic issue's own title>`; the conventional type is `build/pr-title.ts`'s map, reused rather than re-derived, because release-please classifies the squash subject and that rule lives in exactly one place — this verb only stamps the `(epic)` scope over it. `--field about` prints the `## About this epic` section derived from the epic's `## Pitch` **Problem** paragraph, read through the same section reader `guard pitch-guard check` uses. That text is never passed through raw: a closing keyword is swapped for a word GitHub's documented keyword list does not carry (the `#<n>` it aimed at is left as written), the paragraph is cut to its opening sentences under a word budget so a triage-length Problem does not land as the section, with `[…]` marking what was left behind, and what is lifted lands as a block quote in the epic's own words — the shape `build pr`'s body guard already reads as reproduced rather than asserted, so a Problem naming `type:epic`, a priority or control-plane keeps its sentence intact instead of being reworded into something that only looks safe. The result is then re-read through `build pr`'s own body predicates, so a section this verb answers cannot be one that guard refuses. An epic with no `## Pitch`, or a pitch with no Problem paragraph, is an ANSWER and not a refusal — empty stdout with the reason on stderr, so the run still publishes its PR with no section rather than being stranded over prose. It opens, edits and reads back no pull request. Exits 1 (`--field` is not `title` or `about`, or the target repo could not be resolved), 7 (the epic is proven absent or closed), 11 (the epic could not be read — UNKNOWN, never a derived title), 56 (the issue carries no `type:epic`, so an assembly PR's prose is not its to give), 57 (the derived section still carries a stray closing keyword or a classification claim after neutralisation — reword the epic's Problem paragraph, or write the section by hand; `--field title` is unaffected). Examples: fabrika lane assembly-pr 8070 --field title · fabrika lane assembly-pr 8070 --field about",
	),
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
		"Guard the epic run's single assembly PR body on its way to `gh pr create`, reading it from STDIN and relaying it unchanged on stdout when it closes the epic — the same bytes, plus a trailing newline when the body lacked one. An epic run is one branch and one PR, so that PR is the run's whole landing: a tail body reaching the epic through `Part of #<epic>`, or closing only its landed children, merges without closing it, and the lane folds to `shipped` and then `complete` over an epic the board still calls open — an operator re-dispatched on it parks on `LANE-TERMINAL` with no door out. The link reader is `issueRefsOf`, the very one `lane/closure.ts` judges the merged PR with, so this guard refuses exactly the bodies that reader would later call partial or leave unreadable, and the two seams cannot disagree about one body. The tail's other closing keywords — one per landed child, by contract — are not judged: what is required is a closing keyword whose target is the epic itself, tested by membership rather than by first match, because a scalar reader would answer off whichever child leads. It reads no board and takes no --repo: the number's epic-ness was established one command earlier in the same fence by `lane assembly-pr`'s 56, and a second network read would only add an UNKNOWN to a judgement the bytes on stdin fully decide. It opens, edits and reads back no pull request. Exits 1 (stdin could not be read — the body is UNKNOWN, never empty), 3 (stdin was read and held nothing), 5 (the body carries a machine-local path — redact before opening), 6 (the body is a bare @ path reference — write the body, not a pointer to it), 58 (no closing keyword aims at the epic; stderr names what the body reaches it by instead — write `Fixes #<epic>`, or leave the run's PR unopened). Example: fabrika lane assembly-body 8070 < body.md | gh pr create --draft --head epic/8070 --title \"<title>\" --body-file -",
	),
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
		"Merge one reviewed child's branch into the epic run's assembly worktree — `epic/<n>` at the path `lane assembly` placed, both derived from the epic number and never taken from the caller — and prove the merged tree holds together before the branch keeps it. The order is the verb: `git merge --no-ff`, then the repo's declared `dependencyReconciler` (for example `pnpm install --frozen-lockfile`) run IN that worktree so the install reads the lockfile the merge just brought, then the repo's declared `codeValidators` over the merged tree — reconciling after the merge, never before, since an assembly worktree placed before a child existed still holds the pre-merge install. Every refusal below the merge resets the assembly branch to ORIG_HEAD and reads its head back, so a recorded FAIL names a branch that never carried the bad merge; nothing is ever pushed here — that is `lane push`, and recording the DONE is the driver's. A textual collision is not always the end of the run: under `assemblyReplay.onCollision` (shipped `off`), the child's commits are replayed onto the tip, hunks that are a plain keep-both — both sides adding lines where the base had none — are kept both ways, the child's own branch is moved onto the replayed range, and that range is merged `--no-ff` like any other landing; a hunk that is not resets through the captured head, proves the reset, and names `--cause replay-conflict` as the park to record. With the key off, exit 42 is byte-identical to what it always was. On exit 0 the last stdout line is `INTEGRATE-VERDICT: MERGED`, or `INTEGRATE-VERDICT: REPLAYED` after a replay; the line above it is the merged head either way, and above that a replay prints its machinery event — {event, child, replay, onto, range, resolved, commits, reReview, budget} — whose `range` is the moved range the child owes one review round over and whose `budget` reads `unspent`, because a replay is machinery working rather than the child failing. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (a restore or a head read-back did not land — UNKNOWN, so nothing may be recorded), 11 (the working trees, the branches, the head, `.fabrika.jsonc` or a validator could not be read, or the repo declares no `codeValidators` — UNKNOWN, never green), 22 (no branch by that name — take it off `lane prove`'s evidence), 33 (`epic/<n>` is checked out in the main working tree), 41 (no working tree holds `epic/<n>` — place it with `lane assembly`), 42 (the child conflicts and was not replayed — the merge was aborted and nothing was installed; or the replay hit a hunk that is not a plain keep-both, and the branch was reset and proved back), 43 (the merged lockfile does not install, the reconciler could not be run, or it changed a tracked file), 44 (the merged tree failed a code validator — the semantic collision), 45 (the assembly worktree already held modified tracked files before the merge, so nothing was merged, installed or validated — that dirt is the driver's tree and not the child's range; clean the seat and integrate again), 54 (the replay landed and the child's branch would not follow it onto the replayed range — usually a working tree still standing on that branch; nothing was merged and the seat is back, so free the branch with `fabrika build retire` or park on `--cause worktree-holds-branch`), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika lane integrate 7140 --child build/7162-app-bootstrap-5558c9a2",
	),
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
			Flag.withDescription(
				"this is the automatic call on the tail's way into review, so `assemblyRefresh.onReview` gates it — under the shipped `off` it declines and merges nothing. A hand call omits this and is never gated. The other automatic call, `assemblyRefresh.onDispatch`, is made by `lane dispatch` itself and is never typed.",
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
		const assemblyRefresh = yield* readKey(process.cwd(), assemblyRefreshKey);
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
		"Merge the trunk into the epic run's assembly worktree — `epic/<n>` at the path `lane assembly` placed, both derived from the epic number and never taken from the caller — so the tail's review binds to a head the merge queue can take. Nothing else in this package touches trunk after the first cut: `lane assembly` cuts off origin/HEAD once and a resume fetches only to judge whether the branch is already landed, merging nothing, so the branch drifts behind trunk with nothing to notice and `lane push` names \"fetch and re-merge\" as the remedy for its exit 29 without any verb performing it. The order is the verb: refuse a dirty seat, `git fetch origin`, resolve --base to a commit, answer CURRENT when the branch already carries it, else `git merge --no-ff` and re-read HEAD. A clean merge is silent and parks nothing; a conflict aborts, resets through ORIG_HEAD and PROVES the reset by re-reading HEAD, and the refusal names `--cause assembly-conflict` as the park to record. A reset that will not take is exit 8, never the clean conflict refusal. Two callers reach the verb automatically and each is gated by its own `assemblyRefresh` arm: --on-review, typed by the driver on the tail's way into review (`onReview`), and the pre-dispatch call `lane dispatch` makes itself before it cuts a child's worktree off the branch (`onDispatch`), which is never typed. Both ship off. Nothing is pushed and no lane log is written — publishing the refreshed head is `lane push`'s and recording the park is the driver's. On exit 0 the last stdout line is `REFRESH-VERDICT: MERGED`, `REFRESH-VERDICT: CURRENT`, or `REFRESH-VERDICT: DECLINED` under a gated automatic call whose arm reads off, and the line above it the head (a DECLINED prints no head, because nothing was read). Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (the restore or a head read-back did not land, or the merge reported success and the head did not move — UNKNOWN, so nothing may be recorded), 11 (the working trees, the head, the seat's cleanliness or the fetch could not be read — UNKNOWN, never green), 21 (`assemblyRefresh` is malformed in .fabrika.jsonc — whether this repo refreshes its assembly branch is UNKNOWN), 22 (--base names no commit after the fetch), 33 (`epic/<n>` is checked out in the main working tree), 41 (no working tree holds `epic/<n>` — place it with `lane assembly`), 45 (the assembly worktree already held modified tracked files, so nothing was fetched or merged; clean the seat and refresh again), 42 (the trunk conflicts with the assembly branch; the merge was aborted and the branch was proven back at its pre-merge head), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane refresh 8810 · fabrika lane refresh 8810 --on-review",
	),
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
		"Publish the assembly branch of one epic run — `epic/<n>`, derived from the epic number and never taken from the caller — and INDEPENDENTLY confirm the remote ref moved by reading it back with git ls-remote. The sanctioned push for the one branch no spawned shell owns — `build push` refuses that branch, because the branch carries no build claim's nonce. The whole report is stdout, single-stream, so `tail -1` of stdout on exit 0 is always `PUSH-VERDICT: MOVED`. No force flag exists: the assembly branch only ever grows, one merge per landed child. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (pushed, but the remote ref could not be re-read — the outcome is UNKNOWN), 11 (the lane, HEAD, the remote ref or containment could not be read — nothing was pushed), 26 (the tree is not on the assembly branch, or HEAD is detached), 29 (the push would drop commits the remote holds — fetch and merge, never rewrite), 30 (proven: the remote ref did not move), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika lane push 5680",
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
		"Print the spawn prompt for one task's current leaf state, folded fresh from the ledger — so a driver pastes a brief rather than composing one. stdout is the `lane-brief` wire format: which lane, task, state and shell, this driver's lanes root resolved absolute (the shell passes it back to `lane report` as --root; a relative one would resolve against the shell's own worktree), the fabrika entrypoint resolved for this repo (repo-relative in a checkout of fabrika's own repo so each worktree runs its own copy, absolute for an installed one no worktree has a node_modules for), the resolved issue and PR URLs (URLs only — the spawned shell re-reads its own ground), and the format's byte-fixed rules. Hand the bytes to the spawn verbatim — a line appended under them is text the format's own reader calls malformed. On an epic lane a child's state resolves no PR at all and briefs the epic issue, the epic branch and the range to judge, while the tail task briefs the run's single PR under the same refusals — and the tail's `build`, the repair round its review's FAIL retries into, briefs that PR together with the assembly branch `epic/<lane>` its head sits on, under a rules paragraph naming the lane driver as the one shell that moves that branch. Every brief standing on that assembly branch is also checked against it: the `fabrika:` entrypoint is repo-relative in a checkout, so it resolves inside the shell's own worktree, and a branch cut before a lane verb landed on the trunk hands that shell a copy of this CLI which cannot execute the contract the brief states — the shell does the work, produces its verdict, and cannot record it. So the branch's own tree is read for every lane verb the brief tells the shell to run (`lane report` today), and a missing one refuses at 59 naming it and the remedy, `lane refresh`. An absolute entrypoint is an installed copy the branch does not carry and is not judged. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane, the issue, its PRs, this fabrika's own entrypoint, the assembly branch's tree or — on a child `review` state — this tree's branches could not be read, UNKNOWN; a shallow clone whose graft boundary is the assembly tip or the child's fork point seats here too, since every ancestry answer over it is wrong — the stderr names `git fetch --deepen=25`), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 18 (the leaf state routes to no shell — `queued`, `blocked`, `human:*`, a final), 19 (neither the task nor the lane names an issue, or that issue is proven absent), 20 (zero open PRs where the state needs one — the tail's repair round needs one too — or several where one is required), 21 (the key is not a lane key), 22 and 25 (a child `review` state's range, on the seats `lane prove` already spends on the same two facts — no local branch in this tree carries the child's commits, or several do), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 59 (the assembly branch does not carry a lane verb this brief tells the shell to run — refresh the branch, then brief again). Example: fabrika lane brief 5680 --task issue_5729",
	),
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
		'Race the earliest AUTHORIZED lane-claim marker on the issue a lane drives: post this driver\'s token (lane:<session-id>:<uuid>), re-read, and win or name the winner. The namespace is the driver\'s own — `lane-claim:`/`lane:`, never `build-claim:`/`build:` — so the builder this driver spawns claims the same issue and wins; the two races never see each other. Authorization is the author\'s repository permission; marker text confers nothing. No admission test runs here — the fence is the spawned builder\'s. Prints {"answer":"won","lane":"…","number":n,"token":"…"}. --token makes the re-claim idempotent per DRIVER: handed the token this driver already holds, a lane it already owns answers won with that same marker and writes nothing, so N claims can never leave N markers for a later release to peel off one at a time; a same-session marker under another nonce is a sibling driver and races normally. A `chore:<name>` lane, or any key that is not a board number, has no thread to race on and answers {"answer":"unclaimable","lane":"…","why":"…"} at exit 0 with nothing written. A lost race retracts this run\'s own marker and exits 31, never 0 — including when the winner is another driver of THIS session, since ownership turns on the whole token and never the session id; no session id is set (FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID, PI_SUBAGENT_PARENT_SESSION), or a --token that is not a lane-claim token of this session, is 1. Exits 8 (the marker write failed — UNKNOWN, never a claim), 9 (the marker landed and does not read back), 11 (the marker set could not be read — UNKNOWN, never "unclaimed"; this run\'s own marker is retracted first), 21 (the key is not a lane key), 31 (proven lost). Example: fabrika lane claim 5492',
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
		'Retract this DRIVER\'s OWN lane-claim marker, and only its own, so the lane is drivable again — run at both ends of the loop, the terminal fold and the park. --token says which driver that is: ownership turns on the whole token, so a sibling driver of one session is a foreign holder here and its marker is never swept. Every marker carrying this driver\'s token goes, not merely the winning one, so a duplicate a re-claim left behind cannot outlive the release. Prints {"answer":"released","lane":"…","number":n}. A `chore:<name>` lane, or any key that is not a board number, was never claimable and answers {"answer":"inert","lane":"…","why":"…"} at exit 0 — and needs no token, having never been handed one. Exits 1 (no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID and PI_SUBAGENT_PARENT_SESSION consulted, --token omitted on a board number, or a --token that is not a lane-claim token of this session), 8 (the retraction failed — whether the claim is still held is UNKNOWN), 11 (the marker set could not be read), 21 (the key is not a lane key), 31 (proven: held by another driver, or no claim exists). Example: fabrika lane release 5492 --token lane:s-9f2e:c1a4d6f8-…',
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
		'Post the succession marker a stranded operator seat\'s lane claim needs: lane-adopt: <session> by lane:<this-session>:<uuid> · <ISO> · reason: <text>. It writes ONE comment and posts no claim marker — "fabrika lane release <lane> --token <the token this prints>" then resolves that claim as this driver\'s and retracts both comments, after which "fabrika lane claim <lane>" wins normally. UNLIKE "build adopt" it ADMITS this run\'s own session, because what dies here is a SEAT and its successor boots under the same CLAUDE_CODE_SESSION_ID with only a fresh nonce, and plain release reads that same-session-other-nonce marker as foreign. It proves no seat dead, exactly as the build namespace\'s succession proves no session dead: the guards are the poster\'s repository permission, read at release time, and the marker sitting on the issue with its reason for anyone to read; an adopt from an account below write is counted, reported, and never a succession. Deleting the comment reverses it. Prints {"answer":"adopted","lane":"…","number":n,"session":"<adopted>","token":"…"}. A `chore:<name>` lane, or any key that is not a board number, was never claimable and answers {"answer":"inert","lane":"…","why":"…"} at exit 0 with nothing written. Exits 1 (CLAUDE_CODE_SESSION_ID unset, an empty --session or --reason, a --session carrying whitespace or ·, or a multi-line --reason), 8 (the marker write failed — UNKNOWN), 9 (the marker landed and does not read back), 21 (the key is not a lane key). Example: fabrika lane adopt 5648 --session 99162fc1-3d99-416e-98b3-99dd423ade39 --reason "the seat driving this lane was killed by the 2026-08-19 outage"',
	),
);

const stale = leafCommand(
	"stale",
	{
		root: rootFlag,
		olderThan: Flag.integer("older-than").pipe(
			Flag.optional,
			Flag.withDescription(
				`override the horizon for every lane, in minutes (default: each lane's own shell budget — ${SHELL_BUDGETS.build.minutes} for a build, ${SHELL_BUDGETS.review.minutes} for a review, ${SHELL_BUDGETS.ship.minutes} for a ship, ${DISPATCH_BUDGET.minutes} for a task awaiting dispatch)`,
			),
		),
		claims: Flag.boolean("claims").pipe(
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
		`Sweep every lane on disk and answer which ones nothing is driving. A lane's ledger records state, not liveness, so a shell that dies leaves the lane reading active forever; the age here comes off the \`at\` every event line already carries — nothing new is stored. How long a lane may be silent is its OWN horizon, not one number for the pipeline: each lane is judged against the budget of the work driving it — a build shell's, a review shell's, a ship shell's, or the dispatch budget for a task nothing has picked up — and every row reports the budgetMinutes it was judged against. --older-than overrides that for every lane; without it, olderThanMinutes in the answer is null, which says the budgets did the judging. stdout is {now, olderThanMinutes, scanned, summary, lanes}, oldest silence first, each lane carrying its folded stateValue, its last event's timestamp, its age in minutes, the budget it was judged against and one verdict: "stale" (non-terminal, unparked and silent past the threshold), "moving", "parked" (blocked or a human:* hold — a park is meant to sit), "terminal", "unstarted" (a lane with no events at all, so no age to judge) or "unreadable" (the lane is there and its record is not readable — it is reported, never dropped). Both default roots are swept unless --root names one; an absent root holds no lanes and is not a fault, and zero lanes is an empty answer at exit 0. Stale lanes exit 0 too — this reports, it never resumes. Without --claims the whole sweep runs off disk and makes no network call. --claims additionally reads the board and pairs each NON-TERMINAL lane with the claim standing on its issue, which is the other half a session limit strands: the dead builder's claim marker outlives it, and the lane log cannot see that. Each paired row then carries claims: {"state":"held",token,session,author,commentId} | {"state":"unclaimed"} | {"state":"unknown",reason} — a board read that failed is unknown, never "unclaimed" — and the answer carries a top-level claims summary, null when the board was never asked. Chore lanes drive no issue and are not paired. Nothing here clears a claim: a stranded BUILD claim leaves through "fabrika build adopt" then "fabrika build release", and the LANE claim a killed operator seat strands on the same issue — which this sweep does not read — leaves through "fabrika lane adopt" then "fabrika lane release". "fabrika build claimants <n>" reads one issue's build claims the same way. Exits 1 (--older-than is not a non-negative number of minutes), 11 (a root is there and could not be listed — the lane set is UNKNOWN, never a short list), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane stale · fabrika lane stale --older-than 120 · fabrika lane stale --claims`,
	),
);

const migrate = leafCommand(
	"migrate",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDescription("judge every lane and report, writing nothing"),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the shape judgement reads (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({root, check, repo}) {
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
						expectations: expectationReader(Option.getOrNull(repo), process.env),
					}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Bring every booted lane's machine up to the committed template."),
	Command.withDescription(
		'Bring each booted lane\'s workflow.json up to the committed template its root selects, but only where the swap provably moves nothing. `lane open` places a byte-identical copy at boot and refuses to overwrite one afterwards, so a template edit reaches lanes booted after it and no lane already on disk — safe until a token→event map in code changes with it, at which point every booted lane is asked for a cell its frozen machine does not have. Two things are kept: the lane\'s own `machine.context`, which is per-lane DATA (the task\'s maxRetries, and whatever else a lane declares) and would be erased by a verbatim copy, and any lane whose machine was GENERATED rather than booted — an emitted epic document has no committed template to be brought up to, and is reported, never touched. State is the event log replayed from scratch with no snapshot, so the swap is safe exactly when the existing events.jsonl folds to the same per-task leaf state through both machines; anything else is a rewritten history, not a migration. Each lane carries one verdict: "current" (already the machine this verb would write, read past formatting), "migrated" (judged safe and written), "stale" (judged safe, --check withheld the write), "generated" (not booted from this template), "mismatched" (the machine is not the one this lane\'s issue calls for — never written), "duplicate" (this lane drives an epic\'s CHILD, whose parent\'s lane already owns the work — a second ledger booted before `lane open` refused one; reported, never written, and never migrated), "unsafe" (the log will not replay through one of the two machines, or it folds to a different state — named, never written) or "unreadable". stdout is {check, scanned, summary, lanes}. Staleness was the only wrongness this sweep could see, and a coder-template lane booted on an epic grafts cleanly and read "current" — so each ISSUE-keyed lane is additionally judged against its issue\'s type and its native sub-issue links, and every judged row carries shape: {"state":"matches"} | {"state":"mismatched",reason} | {"state":"duplicate",parent,reason} | {"state":"unknown",reason} — a board read that failed is unknown, never "matches", and a booted child lane is duplicate, never "matches". That read is the verb\'s only network call, one per issue-keyed lane; chore lanes drive no issue and are not judged. A mismatched lane is skipped ahead of every migration verdict and the sweep exits 46; a duplicate lane is skipped the same way and moves NO exit code — a stray ledger is a report, and retiring its directory is an operator\'s act this verb never takes; where unsafe lanes are present too, 37 wins as the more dangerous class. Both default roots are swept unless --root names one, which is read as a relocated root whose lanes may have booted from either committed template — the lane\'s own machine id picks, never the root\'s position; an absent root holds no lanes and is not a fault. Exits 11 (a template could not be read, or a root is there and could not be listed — the lane set is UNKNOWN, never empty), 37 (at least one lane cannot take the template without moving; those lanes are named on stderr and none of them was written, and so are the ones that were), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 46 (at least one lane runs a machine its issue does not call for; an epic\'s lane is rebuilt by retiring its directory and re-running `fabrika lane emit <n>`). Examples: fabrika lane migrate --check · fabrika lane migrate',
	),
);

const archive = leafCommand(
	"archive",
	{
		lane: laneArgument,
		root: rootFlag,
		archivedRoot: Flag.string("archived-root").pipe(
			Flag.optional,
			Flag.withDescription(
				`where the lane moves to (default: the owning repository's ${DEFAULT_ARCHIVED_LANES_ROOT}, a sibling of the lanes root and swept by nothing)`,
			),
		),
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the owner/name the closure read reads (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, root, archivedRoot: archived, repo}) {
		const parsed = parseKey(lane);
		if (parsed._tag === "Malformed") {
			yield* emit(keyRefusal(parsed));
			return;
		}
		const path = yield* Path.Path;
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
			source = Option.getOrElse(root, () => path.join(ground.repoRoot, defaultRoot(parsed.key)));
			destination = Option.getOrElse(archived, () => path.join(ground.repoRoot, archivedRoot()));
		}
		const ref = laneRef(parsed.key, source);
		yield* emit(
			yield* onGround("archive", [ref.root, destination], process.cwd(), () =>
				runArchive({
					ref,
					archivedRoot: destination,
					// A relocated root holds whatever was opened into it, so both templates are
					// candidates and the lane's own machine id picks — never the root's position.
					templatePaths: [templatePath("Issue"), templatePath("Chore")],
					issue: resolveKeyIssue(parsed.key),
					closed: closedReader(Option.getOrNull(repo), process.env),
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Move one lane whose log will never replay out of the swept root."),
	Command.withDescription(
		'Move one lane directory from the lanes root to the archived root, so the sweeps stop reporting a lane they can never judge. `lane reconcile` reads such a lane "unreadable" and `lane migrate` "unsafe" on every run, forever: the fault is an event the machine has no cell for, and neither verb may rewrite an append-only log to fix it — sealing writes a line for something that did not happen and widening `frozen` lets a lane at its retry cap ship with no unblock. So the record moves aside instead, and nothing in it is touched. BOTH gates hold or nothing moves: the lane\'s issue must read closed on the board, AND the log must fail to replay under the same judgement `lane migrate` makes — through the lane\'s own machine or through the committed template, and through the lane\'s own machine alone when that machine was generated by `lane emit` and binds no template. Anything else is refused with the directory where it was, so a genuinely broken lane still shows up on every sweep. The replay judgement runs first because it is local and free, so a replaying lane costs no board read. The archived root is a SIBLING of the lanes root, never a directory under it, which is why no sweep needs a skip rule: `reconcile` and `migrate` read the roots they are handed and are never handed this one. The record stays readable — `fabrika lane history <lane> --root <archived-root>` and `fabrika lane brief` read an archived lane when pointed at it. stdout is {answer:"archived", lane, issue, from, to, through, defects}, where `through` is "current" or "candidate" — which machine refused the log — and `defects` names why. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there), 8 (the move did not land — the lane is NOT archived), 9 (the move reported success and the destination does not read back), 11 (the lane, a committed template, the destination probe or the board could not be read, or a committed template that is this lane\'s own could not be built into a candidate — UNKNOWN, never a move; a GENERATED machine binds no template and is not that case, so its own fold is the whole judgement), 14 (the archived root already holds a lane by this key — a move onto it would bury a record), 19 (the key names no issue, so the closed-issue gate can never be satisfied — the refusal says which of the two: a chore lane, which is not archivable at all, or an issue-kind directory name carrying no leading issue number), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default roots), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 49 (the lane\'s issue is open — drive the lane, or close it first), 50 (the log replays, so every sweep can judge it and there is nothing to move out of scope). Example: fabrika lane archive 6037',
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
		'Append the terminal the board\'s own closure proves, to a lane whose own flow never reached one. Two stranded shapes, one verb: a lane parked while its issue closed not planned or duplicate owes no artifact, and a lane sitting in build or review while its issue closed completed over a merged PR was hand-shipped past the ledger. Neither can be ended by the operator\'s six — DONE claims an open PR that is not there, BLOCKED only parks, UNBLOCKED resumes work that is already over — so the only remedy was deleting the lane directory, which erases an append-only history instead of recording an outcome. This appends ONE line and moves nothing on disk; `fabrika lane history <lane>` still reads the whole log. The board read is the whole entitlement. A `state_reason` of not_planned or duplicate records `<TASK>.CANCELLED`; `completed` PLUS at least one merged pull request whose body links the issue (closing keyword or `Part of`) records `<TASK>.LANDED`, carrying those pull request numbers as `landed` and the first one\'s merge commit as `sha`. The pull requests are read only on the completed arm, so a cancellation costs one board read. Everything else appends nothing: an open issue refuses at 49, and a read that failed, a close carrying no `state_reason`, a reason outside the three, or a completed close naming no merged linking PR are all UNKNOWN at 11 — a completed close with nothing that did it is genuinely unread, not a landing. --landed-by <pr> supplies exactly that missing link and nothing more, for a closure a human closed by hand over a merge whose body cites some other issue: the board must still read that PR merged, so an unmerged one refuses at 23 and one this repository does not hold at 22, both with the log unappended, and an unreadable read stays UNKNOWN at 11. A body-proven landing is judged FIRST and wins, so the flag can only ever fill a gap; the line it appends carries `assertedBy: "caller"` beside its `landed`/`sha`, which is how this verb\'s own stdout and `lane history` tell an asserted link from a body-proven one, and a body-proven line carries no such field at all. `lane view` does NOT show it: the viewer page rebuilds every log line as {task, event, at} and drops the rest, `landed` and `sha` included, so the distinction is readable through `lane history` and not on that screen. Neither event is an operator event: the operator\'s six are unchanged and `lane transition` refuses both, so `DONE`\'s proof semantics are untouched. A live authorized lane claim refuses at 31 unless --token names it, so a lane another session is driving is not ended underneath it; an unreadable claim thread is UNKNOWN, never "unclaimed". The lane then folds to the terminal stateValue "cancelled" or "landed" — its own, neither "complete" (which would claim this lane\'s flow finished it) nor "tripped" (which would claim it failed) — so `lane status`, `lane stale` and `lane view` read it done and it holds no seat against `laneConcurrencyCap`. The offline gate runs first, so a lane already carrying a terminal costs no board read at all. stdout is {answer:"settled", lane, issue, previous, event, current, taskAffected, outcome} plus `landed` and `sha` on a landing, and `assertedBy` on an asserted one. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there), 8 (the append did not land — the terminal is NOT recorded), 11 (the lane, the board closure, the pull requests, the --landed-by pull request or the claim thread could not be read, or the closure proves no terminal — UNKNOWN, never an append), 12 (this lane already carries a terminal, or the task is in a final — there is nothing here to settle), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 19 (the key names no issue, so the closure gate can never be satisfied — the refusal says which of the two: a chore lane, which is not settleable at all, or an issue-kind directory name carrying no leading issue number), 21 (the key is not a lane key), 22 (--landed-by names no pull request this repository holds), 23 (--landed-by names a pull request that has not merged), 31 (the issue carries a live lane claim this caller did not name), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root), 40 (another writer holds the ledger lock — retry). Examples: fabrika lane settle 5983 · fabrika lane settle 6100 --landed-by 6878',
	),
);

const reconcile = leafCommand(
	"reconcile",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
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

const view = leafCommand(
	"view",
	{
		root: rootFlag,
		port: Flag.integer("port").pipe(
			Flag.optional,
			Flag.withDescription(`the port to serve on (default: ${DEFAULT_VIEW_PORT})`),
		),
	},
	Effect.fn(function* ({root, port}) {
		const chosen = Option.getOrElse(port, () => DEFAULT_VIEW_PORT);
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika lane view",
			root,
			DEFAULT_LANES_ROOT,
			process.cwd(),
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		const parkCause = yield* readKey(process.cwd(), parkCauseKey);
		yield* Effect.logInfo(listeningAt(chosen));
		yield* emit(
			yield* onGround("view", [resolvedRoot], process.cwd(), () =>
				runView(
					{
						root: resolvedRoot,
						port: chosen,
						parkCause,
						repo: null,
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
		"Every lane on disk, on one screen, the ones needing a person first.",
	),
	Command.withDescription(
		"Serve every lane under the root as one page and keep it current while lanes move — the fleet-wide answer to which of these needs a person, where `lane status` answers one lane and `lane stale` answers liveness. Lanes are ordered by attention: waiting on a human, then tripped, then gone quiet, then moving, then finished. Opening one shows its phases, each task's leaf, what it is waiting on, its retry budget and its region drawn with the edges the log walked. The page can send the operator's events, and every one goes through `lane transition` — validated against the folded state, proven against the artifact it claims, and appended only if both pass, so a refusal is that verb's own words and `events.jsonl` has exactly one writer. It serves on localhost and reads the disk it was started on: nothing is uploaded and no lane leaves the machine. Runs until interrupted. Exits 11 (the root is there and could not be listed — the lane set is UNKNOWN, never a short list), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Examples: fabrika lane view · fabrika lane view --port 6000",
	),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([
		status,
		transition,
		clear,
		report,
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
		stale,
		migrate,
		reconcile,
		archive,
		settle,
		claim,
		release,
		adopt,
		view,
	]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's events. A lane is keyed by the issue number it drives, or by name as `chore:<name>` for a chore that has no issue number",
	),
);
