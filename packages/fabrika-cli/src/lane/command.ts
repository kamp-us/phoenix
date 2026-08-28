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
import {resolveEntrypoint} from "../delegate/entrypoint.ts";
import {leafCommand} from "../excess-operand.ts";
import {SHIP_CLASS_NAMES} from "../review/classes.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {runAssembly} from "./assembly-verb.ts";
import {runBrief} from "./brief-verb.ts";
import {runLaneAdopt, runLaneClaim, runLaneRelease} from "./claim-verb.ts";
import {CLASS_UNRECOGNISED} from "./codes.ts";
import {runEmit} from "./emit-verb.ts";
import {deriveRepoRoot, onGround, repoGroundRefusal} from "./ground.ts";
import {runHistory} from "./history-verb.ts";
import {defaultRoot, type LaneKey, laneRef, parseKey, templateFile} from "./key.ts";
import {runMigrate} from "./migrate-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runPrint} from "./print-verb.ts";
import {runProve} from "./prove-verb.ts";
import {runPush} from "./push-verb.ts";
import {keyRefusal} from "./refusals.ts";
import {classesForEvent, PARK_CAUSE_TOKENS} from "./report.ts";
import {runReport} from "./report-verb.ts";
import {DEFAULT_STALE_MINUTES} from "./stale.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT, type LaneRef} from "./store.ts";
import {runTransition} from "./transition-verb.ts";
import {DEFAULT_VIEW_PORT, listeningAt, runView} from "./view-verb.ts";

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
		`the lanes root directory (default: the owning repository's ${DEFAULT_LANES_ROOT}, derived off the primary checkout so every worktree reads the same ledger; or ${DEFAULT_CHORES_ROOT} for a chore key)`,
	),
);

/**
 * Resolve the `lane` argument to a key and its directory, or refuse it — the one step every keyed
 * verb shares, so a malformed key is caught before any verb reads or writes anything, and the ground
 * under the resolved root is proven before either. An explicit `--root` wins; otherwise the root is
 * derived off the repository the cwd belongs to (#5815), so a linked worktree reads the same ledger
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
 * The lanes root one verb invocation resolves when `--root` is absent: derived off the repository
 * the cwd belongs to (#5815), with the leaf joined under its primary checkout. An explicit `--root`
 * wins over whatever would be derived.
 */
const resolveRootOrRefuse = (
	verb: string,
	root: Option.Option<string>,
	leaf: string,
): Effect.Effect<string | VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Option.isSome(root)
		? Effect.succeed(root.value)
		: Effect.gen(function* () {
				const path = yield* Path.Path;
				const ground = yield* deriveRepoRoot(process.cwd());
				return ground._tag === "Derived"
					? path.join(ground.repoRoot, leaf)
					: repoGroundRefusal(`fabrika lane ${verb}`, ground);
			});

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

const status = leafCommand(
	"status",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(yield* onKey("status", lane, root, (_key, ref) => runStatus(ref)));
	}),
).pipe(
	Command.withShortDescription("One lane's derived state, folded fresh from its event log."),
	Command.withDescription(
		'One lane\'s derived state, folded fresh from the whole events.jsonl every invocation — no resident process, no snapshot. stdout is the operator\'s status JSON: compound `stateValue` (active phase → per-task leaf state, future phases "waiting", or a bare terminal), `status` active/done, and per-task `{retries, maxRetries, …}` context with the tripped tasks in `errors`. Exits 4 (workflow.json or events.jsonl read in full and not the shape — every defect on stderr), 7 (no lane there — copy a workflow template to open it), 11 (the lane could not be read — its state is UNKNOWN, never fresh), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot). Examples: fabrika lane status 5673 · fabrika lane status chore:park-sweep',
	),
);

/**
 * Why a lane parked, on the two verbs that can append a `BLOCKED` — the shell's `report` and the
 * driver's `transition`. Closed vocabulary, so the listing comes off the module that owns it.
 */
const causeFlag = Flag.string("cause").pipe(
	Flag.optional,
	Flag.withDescription(
		`why the lane parked, on a BLOCKED only — one of: ${PARK_CAUSE_TOKENS.join(", ")}. It is the key \`recipe unpark\` seats the park against; omit it and the park stays novel and routes to a human.`,
	),
);

/**
 * The lane classes standing at the event being recorded, on the same two appending verbs.
 *
 * Relayed from a shipped verb's answer, never derived by the caller (ADR 0228) — `ship scope` and
 * `review scope` name the classes a head raises, and before a head exists the class is the one the
 * lane document seeded. It rides the event line because that is where every other
 * observed-at-record-time fact rides, and because `lane prove`, the other candidate writer, writes
 * nothing by design.
 *
 * Validated against {@link SHIP_CLASS_NAMES} at the verb, not here: a bare string flag over a
 * routing table that falls through on a miss is a silent miss — `--class UI` would build a plain
 * lane and never ask for the rendered-visual verdict it owed (ADR 0317).
 */
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
	},
	Effect.fn(function* ({lane, event, root, task, cause, classes}) {
		yield* emit(
			yield* onKey("transition", lane, root, (_key, ref) =>
				runTransition({
					...ref,
					event,
					task: Option.getOrNull(task),
					cause: Option.getOrNull(cause),
					classes,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Record one operator event, refusing an invalid one unappended."),
	Command.withDescription(
		"Record one operator event on the lane's append-only log — after the machine accepts it, never before. stdout is `{previous, event, current, taskAffected}` with the two stateValues around the fold. An invalid event — no cell in the task's current state (tea's NoCellError, surfaced verbatim), outside the operator's six, a task outside the active phase, a finished workflow — is refused loudly and the log is left byte-identical. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (the lane could not be read), 12 (the event is refused, log unappended), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 35 (--cause is outside the closed park-cause set or rides on an event that is not BLOCKED), 38 (--class is outside the closed lane-class set), 36 (an UNBLOCKED out of an error final would restore the state and not the repair budget — record the founder's cleared round with `build clear` first; the two land in either order), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). A cleared round is NOT recorded here: it is a `<TASK>.CLEARED` event `build clear` appends, it targets no state, and the operator's six are unchanged (ADR 0312). An optional --cause lands on a BLOCKED's event line and is what `recipe unpark` keys its recipe table on; a BLOCKED with no cause is the bare park it always was, and routes to a human. A repeatable --class lands the lane classes standing at the event on the same line, and is the fact the machine's `class:<name>` arms route on — `--class ui` on a WIP sends the lane to `build:ui`, and it stands until another event names a different set. Example: fabrika lane transition 5673 DONE",
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
		"Record a spawned shell's terminal token on the lane's append-only log: the token→event map in code (report.ts) picks one of the operator's six, the mapped event is then proven exactly as `lane prove` proves it — a token is a self-report, so a DONE and a PASS reach the log only with their artifact behind them, a reviewer's park only while no FAIL at the head says the run reached a verdict, every other event answering not-required without a board read — and only then does the append ride transition's exact path, validated against the folded state first, refused unappended otherwise. Optional --pr/--comment refs land on the event line itself, so the event names its evidence (visible via lane history), a repeatable --class lands the lane classes standing at the event (what the machine's `class:<name>` arms route on), and an optional --cause names why a BLOCKED parked, from a closed set in code — the key `recipe unpark` seats the park against, without which every BLOCKED is novel and costs a human UNBLOCKED. stdout is `{token, previous, event, current, taskAffected}` plus the refs. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 8 (the append did not land — the event is NOT recorded), 11 (a lane, board or tree read failed — whether the event is proven is UNKNOWN), 12 (the mapped event is refused, log unappended), 13 (the task is not in the machine, names no issue, or --task omitted on a multi-task lane), 21 (the key is not a lane key), 22/23/24/25 (`lane prove`'s own refusals — artifact provably absent, a namespace with no still-binding verdict, a FAIL under a claimed PASS or park, several candidates — log unappended, remedies unchanged), 32 (the token is no shell's terminal token — refused, never interpreted), 35 (--cause is outside the closed park-cause set or rides on an event that is not BLOCKED), 38 (--class is outside the closed lane-class set), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane report 5736 --token SHIPPED-PR --pr https://github.com/kamp-us/phoenix/pull/5760",
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
		classes: classFlag,
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({lane, event, root, task, classes, repo}) {
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
		"Read the artifact a lane event claims — artifacts over self-reports, the rule the retired epic conductor held against a conducted branch. Three events carry a claim, and which artifact answers them is the task's shape. On a single-issue lane and on an epic run's tail: a DONE out of `build` claims an open PR whose body links the task's issue (or, for an investigation, the diagnosis comment a no-PR builder posted since the task entered build), and a PASS out of `review` claims a current-head verdict in every namespace that PR's diff derives, governance included — minus, and only minus, a routed namespace this very event's arm hands to a later cell of this lane's own machine (`--class ui` into `review:ui`; ADR 0320), which then proves the whole set. On an epic run's child, which opens no PR at all (ADR 0285): a DONE out of `build` claims the commits its lane branch adds over `epic/<n>` in THIS tree, and a PASS out of `review` claims a range-scoped verdict on the child issue still bound to the content that range carries now (ADR 0276). The third is the reviewer's park — a BLOCKED out of `review` or `review:ui` on a lane that owns a PR — and it is the one negative claim: it says the run reached no verdict, so a still-binding FAIL refuses it at 24 and every unreadable half records it, because a park nobody can record strands the lane in the state only a human could have left. Every other event answers `not-required` at exit 0. Writes nothing — the append stays `lane transition`'s. The refusals are artifact-independent, so the range arms take no new seat. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (a lane, board or tree read failed — the proof is UNKNOWN, never proven; an epic branch this tree does not carry is UNKNOWN too, as is a shallow clone whose graft boundary is the assembly tip or the child's fork point, where the stderr names `git fetch --deepen=25`), 13 (the task is not in the machine, or names no issue), 21 (the key is not a lane key), 22 (the artifact is provably not there), 23 (a required namespace has no current or still-binding verdict — re-read, record nothing), 24 (a FAIL under a claimed PASS, or under a reviewer's claimed park), 25 (several open PRs link the issue, or several lane branches carry the child's commits). Exits 38 too (--class is outside the closed lane-class set), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane prove 5673 DONE",
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
		'The lane\'s append-only event log, verbatim — one `{task, event, at}` per recorded event, in append order, carrying the optional `pr`/`comment` refs where the event was recorded with one as its evidence, the `round` a `CLEARED` clears, and the `classes` a class-carrying event named; the log IS the history, and `from`/`to` are reconstructible by folding, never stored. A lane with no events yet answers `[]`. Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot). Example: fabrika lane history 5673',
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
		"The lane's compiled machine topology — phases in order, the two workflow terminals, and per task its initial state, retry budget, and each state's legal events (everything absent refuses at transition time). Exits 4 (workflow.json read in full and not the shape), 7 (no lane there), 11 (the lane could not be read), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane print 5673",
	),
);

const templatePath = (kind: LaneKey["_tag"]): string =>
	fileURLToPath(new URL(`./templates/${templateFile(kind)}`, import.meta.url));

const open = leafCommand(
	"open",
	{lane: laneArgument, root: rootFlag},
	Effect.fn(function* ({lane, root}) {
		yield* emit(
			yield* onKey("open", lane, root, (key, ref) =>
				runOpen({...ref, templatePath: templatePath(key._tag)}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Boot a lane from the committed template its key selects."),
	Command.withDescription(
		'Boot one lane: create `<root>/<key>/` and place a byte-identical copy of the committed template the key selects as its workflow.json — the coder template for an issue number, the chore template for a `chore:<name>` key. An existing lane dir is refused loudly with nothing written — resuming needs no boot, and overwriting a machine mid-drive would corrupt a live fold. Exits 8 (the write did not land — the lane is NOT booted), 11 (the template or the lane dir\'s existence could not be read — UNKNOWN, never a boot), 14 (the lane already exists), 21 (the key is not a lane key), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot). Examples: fabrika lane open 5673 · fabrika lane open chore:park-sweep',
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
		const resolvedRoot = yield* resolveRootOrRefuse("fabrika lane emit", root, DEFAULT_LANES_ROOT);
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
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Generate an epic's lane machine from its board topology."),
	Command.withDescription(
		"Generate a lane machine from the epic's board state: read the epic body's `## Dependencies` topology (the shape `ledger topology` stages) and emit `<root>/<epic>/workflow.json` — one region per child in the coder template's exact shape, phase-sequenced, parallel within a phase. A closed child boots its region in a final state (`completed` → `shipped`, any other close → `frozen`), so a partly-built epic's machine can still terminate. Deterministic: the same epic body bytes and the same child links (number, state and close reason per child) emit the same machine bytes. Exits 4 (the topology was read in full and does not parse — the defective line, duplicate placement or unplaced requires subject is named), 7 (the epic is proven absent or closed), 8 (the write did not land), 11 (the epic, its child list or the lane dir could not be read — UNKNOWN), 14 (the lane already exists — remove it to regenerate), 15 (no `## Dependencies` topology — plan the epic first), 16 (the topology references a non-child, named), 17 (the topology holds a cycle, path named), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane emit 5680",
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
		"Place the working tree an epic run assembles in — `epic/<n>` checked out at `.claude/worktrees/epic-<n>`, both derived from the epic number and never taken from the caller — and print its absolute path on stdout. The invoking checkout is NEVER switched: `operate`'s boot used to `git switch --create` the assembly branch in whatever tree ran it, which parked a human's working tree on `epic/<n>` for the whole run and left a second concurrent epic no tree to integrate in (#6163). Idempotent in both directions: a worktree already holding the branch is resumed and its path answered with nothing written, and a branch that outlived its worktree — the state `--remove` at a terminal leaves behind — is checked out again as it stands, never re-cut off a fresh base. A worktree whose directory is gone but whose record git still carries (`prunable`) is that same state: the registration is cleared and the branch placed again, never answered as a live path. `--remove` is the lane's terminal step and never forces — a dirty assembly tree is unlanded work, so git's refusal is the answer. Every mode reads the outcome back off `git worktree list` before answering. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (the placement or removal ran and did not read back — UNKNOWN), 11 (the working trees or origin could not be read — nothing was placed or removed), 33 (`epic/<n>` is checked out in the main working tree — switch that tree off it first), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Examples: fabrika lane assembly 5680 · fabrika lane assembly 5680 --remove",
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
		const resolvedRoot = yield* resolveRootOrRefuse("fabrika lane push", root, DEFAULT_LANES_ROOT);
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
		"Publish the assembly branch of one epic run — `epic/<n>`, derived from the epic number and never taken from the caller — and INDEPENDENTLY confirm the remote ref moved by reading it back with git ls-remote. The sanctioned push for the one branch no spawned shell owns (ADR 0285), where `build push` refuses because the branch carries no build claim's nonce and a bare `git push` cannot report whether the ref landed (#4213). The whole report is stdout, single-stream, so `tail -1` of stdout on exit 0 is always `PUSH-VERDICT: MOVED`. No force flag exists: the assembly branch only ever grows, one merge per landed child, so a non-fast-forward push is always a mistake. Exits 4 (the lane record was read in full and is not the shape), 7 (no lane there — emit the run's machine first), 8 (pushed, but the remote ref could not be re-read — the outcome is UNKNOWN), 11 (the lane, HEAD, the remote ref or containment could not be read — nothing was pushed), 26 (the tree is not on the assembly branch, or HEAD is detached), 29 (the push would drop commits the remote holds — fetch and merge, never rewrite), 30 (proven: the remote ref did not move), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane push 5680",
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
		"Print the spawn prompt for one task's current leaf state, folded fresh from the ledger — so a driver pastes a brief rather than composing one. stdout is the `lane-brief` wire format: which lane, task, state and shell, this driver's lanes root resolved absolute (the shell passes it back to `lane report` as --root; a relative one would resolve against the shell's own worktree), the fabrika entrypoint resolved for this repo (repo-relative in a checkout of fabrika's own repo so each worktree runs its own copy, absolute for an installed one no worktree has a node_modules for), the resolved issue and PR URLs (URLs only — the spawned shell re-reads its own ground), and the format's byte-fixed rules. Hand the bytes to the spawn verbatim — a line appended under them is text the format's own reader calls malformed. On an epic lane a child's state resolves no PR at all and briefs the epic issue, the epic branch and the range to judge, while the tail task briefs the run's single PR under the same refusals (ADR 0285). Exits 4 (lane record read in full and not the shape), 7 (no lane there), 11 (the lane, the issue, its PRs, this fabrika's own entrypoint or — on a child `review` state — this tree's branches could not be read, UNKNOWN; a shallow clone whose graft boundary is the assembly tip or the child's fork point seats here too, since every ancestry answer over it is wrong — the stderr names `git fetch --deepen=25`), 13 (the task is not in the machine, or --task omitted on a multi-task lane), 18 (the leaf state routes to no shell — `queued`, `blocked`, `human:*`, a final), 19 (neither the task nor the lane names an issue, or that issue is proven absent), 20 (zero open PRs where the state needs one, or several where one is required), 21 (the key is not a lane key), 22 and 25 (a child `review` state's range, on the seats `lane prove` already spends on the same two facts — no local branch in this tree carries the child's commits, or several do), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Example: fabrika lane brief 5680 --task issue_5729",
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
		'Race the earliest AUTHORIZED lane-claim marker on the issue a lane drives: post this driver\'s token (lane:<session-id>:<uuid>), re-read, and win or name the winner. Two drivers over one lane used to be invisible until the builders they spawned collided one level down (#5761). The namespace is the driver\'s own — `lane-claim:`/`lane:`, never `build-claim:`/`build:` — so the builder this driver spawns claims the same issue and wins; the two races never see each other. Authorization is the author\'s repository permission (ADR 0055); marker text confers nothing. No admission test runs here — the fence is the spawned builder\'s. Prints {"answer":"won","lane":"…","number":n,"token":"…"}. --token makes the re-claim idempotent per DRIVER: handed the token this driver already holds, a lane it already owns answers won with that same marker and writes nothing, so N claims can never leave N markers for a later release to peel off one at a time (#6087); a same-session marker under another nonce is a sibling driver and races normally. A `chore:<name>` lane, or any key that is not a board number, has no thread to race on and answers {"answer":"unclaimable","lane":"…","why":"…"} at exit 0 with nothing written. A lost race retracts this run\'s own marker and exits 31, never 0 — including when the winner is another driver of THIS session, since ownership turns on the whole token and never the session id (#6060); no session id is set (FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID, PI_SUBAGENT_PARENT_SESSION), or a --token that is not a lane-claim token of this session, is 1. Exits 8 (the marker write failed — UNKNOWN, never a claim), 9 (the marker landed and does not read back), 11 (the marker set could not be read — UNKNOWN, never "unclaimed"; this run\'s own marker is retracted first), 21 (the key is not a lane key), 31 (proven lost). Example: fabrika lane claim 5492',
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
		'Retract this DRIVER\'s OWN lane-claim marker, and only its own, so the lane is drivable again — run at both ends of the loop, the terminal fold and the park. --token says which driver that is: ownership turns on the whole token, so a sibling driver of one session is a foreign holder here and its marker is never swept (#6060). Every marker carrying this driver\'s token goes, not merely the winning one, so a duplicate a re-claim left behind cannot outlive the release (#6087). Prints {"answer":"released","lane":"…","number":n}. A `chore:<name>` lane, or any key that is not a board number, was never claimable and answers {"answer":"inert","lane":"…","why":"…"} at exit 0 — and needs no token, having never been handed one. Exits 1 (no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID and PI_SUBAGENT_PARENT_SESSION consulted, --token omitted on a board number, or a --token that is not a lane-claim token of this session), 8 (the retraction failed — whether the claim is still held is UNKNOWN), 11 (the marker set could not be read), 21 (the key is not a lane key), 31 (proven: held by another driver, or no claim exists). Example: fabrika lane release 5492 --token lane:s-9f2e:c1a4d6f8-…',
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
		'Post the succession marker a stranded operator seat\'s lane claim needs: lane-adopt: <session> by lane:<this-session>:<uuid> · <ISO> · reason: <text>. It writes ONE comment and posts no claim marker — "fabrika lane release <lane> --token <the token this prints>" then resolves that claim as this driver\'s and retracts both comments, after which "fabrika lane claim <lane>" wins normally (ADR 0325, the lane-namespace half of ADR 0295). UNLIKE "build adopt" it ADMITS this run\'s own session, because what dies here is a SEAT and its successor boots under the same CLAUDE_CODE_SESSION_ID with only a fresh nonce — the same-session-other-nonce marker plain release reads as foreign, which is the whole hole this closes (#6374). It proves no seat dead, exactly as ADR 0295 proves no session dead: the guards are the poster\'s repository permission, read at release time (ADR 0055), and the marker sitting on the issue with its reason for anyone to read; an adopt from an account below write is counted, reported, and never a succession. Deleting the comment reverses it. Prints {"answer":"adopted","lane":"…","number":n,"session":"<adopted>","token":"…"}. A `chore:<name>` lane, or any key that is not a board number, was never claimable and answers {"answer":"inert","lane":"…","why":"…"} at exit 0 with nothing written. Exits 1 (CLAUDE_CODE_SESSION_ID unset, an empty --session or --reason, a --session carrying whitespace or ·, or a multi-line --reason), 8 (the marker write failed — UNKNOWN), 9 (the marker landed and does not read back), 21 (the key is not a lane key). Example: fabrika lane adopt 5648 --session 99162fc1-3d99-416e-98b3-99dd423ade39 --reason "the seat driving this lane was killed by the 2026-08-19 outage"',
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
					olderThanMinutes: Option.getOrElse(olderThan, () => DEFAULT_STALE_MINUTES),
					now: new Date().toISOString(),
					claims: claims ? claimReader(Option.getOrNull(repo), process.env) : null,
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Which lanes have gone quiet with something owed on them."),
	Command.withDescription(
		`Sweep every lane on disk and answer which ones nothing is driving. A lane's ledger records state, not liveness, so a shell that dies leaves the lane reading active forever (#5897); the age here comes off the \`at\` every event line already carries — nothing new is stored. stdout is {now, olderThanMinutes, scanned, summary, lanes}, oldest silence first, each lane carrying its folded stateValue, its last event's timestamp, its age in minutes and one verdict: "stale" (non-terminal, unparked and silent past the threshold), "moving", "parked" (blocked or a human:* hold — a park is meant to sit), "terminal", "unstarted" (a lane with no events at all, so no age to judge) or "unreadable" (the lane is there and its record is not readable — it is reported, never dropped). Both default roots are swept unless --root names one; an absent root holds no lanes and is not a fault, and zero lanes is an empty answer at exit 0. Stale lanes exit 0 too — this reports, it never resumes. Without --claims the whole sweep runs off disk and makes no network call. --claims additionally reads the board and pairs each NON-TERMINAL lane with the claim standing on its issue, which is the other half a session limit strands: the dead builder's claim marker outlives it, and the lane log cannot see that (#6771). Each paired row then carries claims: {"state":"held",token,session,author,commentId} | {"state":"unclaimed"} | {"state":"unknown",reason} — a board read that failed is unknown, never "unclaimed" — and the answer carries a top-level claims summary, null when the board was never asked. Chore lanes drive no issue and are not paired. Nothing here clears a claim: a stranded BUILD claim leaves through "fabrika build adopt" then "fabrika build release" (ADR 0295), and the LANE claim a killed operator seat strands on the same issue — which this sweep does not read — leaves through "fabrika lane adopt" then "fabrika lane release" (ADR 0325). "fabrika build claimants <n>" reads one issue's build claims the same way. Exits 1 (--older-than is not a non-negative number of minutes), 11 (a root is there and could not be listed — the lane set is UNKNOWN, never a short list), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot). Examples: fabrika lane stale · fabrika lane stale --older-than 30 · fabrika lane stale --claims`,
	),
);

const migrate = leafCommand(
	"migrate",
	{
		root: rootFlag,
		check: Flag.boolean("check").pipe(
			Flag.withDescription("judge every lane and report, writing nothing"),
		),
	},
	Effect.fn(function* ({root, check}) {
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
				() => runMigrate({roots, check}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Bring every booted lane's machine up to the committed template."),
	Command.withDescription(
		'Bring each booted lane\'s workflow.json up to the committed template its root selects, but only where the swap provably moves nothing. `lane open` places a byte-identical copy at boot and refuses to overwrite one afterwards, so a template edit reaches lanes booted after it and no lane already on disk — safe until a token→event map in code changes with it, at which point every booted lane is asked for a cell its frozen machine does not have (ADR 0313). Two things are kept: the lane\'s own `machine.context`, which is per-lane DATA (the task\'s maxRetries, and whatever else a lane declares) and would be erased by a verbatim copy, and any lane whose machine was GENERATED rather than booted — an emitted epic document has no committed template to be brought up to, and is reported, never touched. State is the event log replayed from scratch with no snapshot, so the swap is safe exactly when the existing events.jsonl folds to the same per-task leaf state through both machines; anything else is a rewritten history, not a migration. Each lane carries one verdict: "current" (already the machine this verb would write, read past formatting), "migrated" (judged safe and written), "stale" (judged safe, --check withheld the write), "generated" (not booted from this template), "unsafe" (the log will not replay through one of the two machines, or it folds to a different state — named, never written) or "unreadable". stdout is {check, scanned, summary, lanes}. Both default roots are swept unless --root names one, which is read as a relocated root whose lanes may have booted from either committed template — the lane\'s own machine id picks, never the root\'s position; an absent root holds no lanes and is not a fault. Exits 11 (a template could not be read, or a root is there and could not be listed — the lane set is UNKNOWN, never empty), 37 (at least one lane cannot take the template without moving; those lanes are named on stderr and none of them was written, and so are the ones that were), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT "no lane here", so never a boot). Examples: fabrika lane migrate --check · fabrika lane migrate',
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
		const resolvedRoot = yield* resolveRootOrRefuse("fabrika lane view", root, DEFAULT_LANES_ROOT);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* Effect.logInfo(listeningAt(chosen));
		yield* emit(
			yield* onGround("view", [resolvedRoot], process.cwd(), () =>
				runView({root: resolvedRoot, port: chosen}),
			),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Every lane on disk, on one screen, the ones needing a person first.",
	),
	Command.withDescription(
		"Serve every lane under the root as one page and keep it current while lanes move. `lane status` answers one lane and `lane stale` answers liveness across the fleet; neither answers the question a driver opens a terminal to ask, which is which of these needs ME — a driver reading twelve stateValue blocks to find the one task a human has to unblock is doing by hand what the fold already knows (#6131). Lanes are ordered by attention: waiting on a human, then tripped, then gone quiet, then moving, then finished. Opening one shows its phases, each task's leaf, what it is waiting on, its retry budget and its region drawn with the edges the log walked. The page can send the operator's six events, and every one goes through `lane transition` — validated against the folded state and appended only if the machine accepts it, so a refusal is that verb's own words and `events.jsonl` has exactly one writer, as it did before this verb existed. It serves on localhost and reads the disk it was started on: nothing is uploaded and no lane leaves the machine. Runs until interrupted. Exits 11 (the root is there and could not be listed — the lane set is UNKNOWN, never a short list), 39 (no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root; an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a boot). Examples: fabrika lane view · fabrika lane view --port 6000",
	),
);

export const laneCommand = Command.make("lane").pipe(
	Command.withSubcommands([
		status,
		transition,
		report,
		prove,
		history,
		print,
		open,
		emitLane,
		brief,
		assembly,
		pushLane,
		stale,
		migrate,
		claim,
		release,
		adopt,
		view,
	]),
	Command.withShortDescription("Drive one lane's state ledger by folding its event log."),
	Command.withDescription(
		"Drive one lane's state ledger — a @demlik/tea machine folded fresh from an append-only events.jsonl on every invocation, speaking the operator's six events (#5673). A lane is keyed by the issue number it drives, or by name as `chore:<name>` for a chore that has no issue number (#5840)",
	),
);
