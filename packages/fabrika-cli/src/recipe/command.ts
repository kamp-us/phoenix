/**
 * The `recipe` verb group — `fabrika recipe <verb>`.
 *
 * The adapter and nothing else: it declares the argument and the flags (`--help` is the interface,
 * so each carries a one-line description and the verb's own block carries its whole exit table),
 * runs the pure verb, and emits its outcome. Every decision lives in the verb modules beside it,
 * which is what makes each refusal testable without spawning a process.
 */
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {parkCauseKey} from "../config/keys/park-cause.ts";
import {readKey} from "../config/read-key.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {configRootOrRefuse, resolveRootOrRefuse} from "../lane/ground.ts";
import {DEFAULT_LANES_ROOT} from "../lane/store.ts";
import {runRerun} from "./rerun-verb.ts";
import {runRoute} from "./route-verb.ts";
import {runUnpark} from "./unpark-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const unpark = leafCommand(
	"unpark",
	{
		lane: Argument.string("lane").pipe(
			Argument.withDescription("the lane id under the root — by convention the issue number"),
		),
		root: Flag.string("root").pipe(
			Flag.optional,
			Flag.withDescription(
				`the lanes root directory (default: the owning repository's ${DEFAULT_LANES_ROOT}, derived off the primary checkout so every worktree reads the same ledger)`,
			),
		),
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the parked task; omittable on a single-task active phase"),
		),
		repo: repoFlag,
		rationale: Flag.string("rationale").pipe(
			Flag.optional,
			Flag.withDescription(
				"why you are clearing this park, on a park whose cause routes to the driver — required there and recorded on the UNBLOCKED, since no recipe read proves that clear",
			),
		),
	},
	Effect.fn(function* ({lane, root, task, repo, rationale}) {
		const cwd = process.cwd();
		// `driverRouted` is weighed against the lanes root below, which a linked worktree and its
		// primary checkout derive alike — so reading it at the cwd would let a worktree branch's
		// tracked copy decide which parks are cleared on a ledger it does not own.
		const configRoot = yield* configRootOrRefuse("fabrika recipe unpark", cwd);
		if (typeof configRoot !== "string") {
			yield* emit(configRoot);
			return;
		}
		// The lane verbs this one relays derive their root off the owning repository, so deriving it
		// any other way here makes one lane key name two directories and strands every worktree
		// driver on a lane the ledger holds.
		const resolvedRoot = yield* resolveRootOrRefuse(
			"fabrika recipe unpark",
			root,
			DEFAULT_LANES_ROOT,
			cwd,
		);
		if (typeof resolvedRoot !== "string") {
			yield* emit(resolvedRoot);
			return;
		}
		yield* emit(
			yield* runUnpark({
				root: resolvedRoot,
				lane,
				task: Option.getOrNull(task),
				repo: Option.getOrNull(repo),
				cwd,
				env: process.env,
				now: new Date().toISOString(),
				parkCause: yield* readKey(configRoot, parkCauseKey),
				rationale: Option.getOrNull(rationale),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Clear a parked lane when the park is a known recipe."),
	Command.withDescription(
		[
			"Clears a recipe-covered park; prints {lane, task, park, clearance, event, mechanism, current}.",
			"  4: lane record malformed",
			"  7: lane or target absent",
			"  8: event did not land",
			"  9: landed, not proven",
			"  11: read failed (UNKNOWN)",
			"  12: novel park; nothing written",
			"  13: not clearable yet",
			"  14: task not parked",
			"  15: task unresolved",
			"  20: machine refused the event",
			"  23: driver-routed; pass --rationale",
			"  39: no owning repository",
			"  65: root in linked worktree",
			"  head-ci-red: human:cp-approval clears on green+open+gate, blocked on green+open",
			'  Derivation: the operate skill\'s contract.md, "recipe unpark"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika recipe unpark 5847"}]),
);

const rerun = leafCommand(
	"rerun",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription("the pull request whose failed workflow runs are rerequested"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, repo}) {
		yield* emit(yield* runRerun({pr, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Rerun a PR's failed runs behind a governance PASS at head."),
	Command.withDescription(
		[
			"Reruns a PR's failed runs behind a governance PASS at head; prints {pr, head, verdict, rerun}.",
			"  7: the PR is absent or closed",
			"  8: the rerun request did not land",
			"  9: it landed and no new attempt shows",
			"  11: a read failed (UNKNOWN)",
			"  16: no governance verdict; form one",
			"  17: the verdict is bound to another head",
			"  18: the verdict at head is FAIL",
			"  19: no run at this head failed",
			"  21: requested and not re-readable (UNKNOWN)",
			'  Derivation: the operate skill\'s contract.md, "recipe rerun"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika recipe rerun 5851"}]),
);

const route = leafCommand(
	"route",
	{
		state: Argument.string("state").pipe(
			Argument.withDescription("the chore lane's leaf state, exactly as `lane status` prints it"),
		),
		exit: Flag.integer("exit").pipe(
			Flag.optional,
			Flag.withDescription(
				"the exit the state's recipe run answered on; omit to ask which verb it applies",
			),
		),
	},
	Effect.fn(function* ({state, exit}) {
		yield* emit(yield* runRoute({state, exit: Option.getOrNull(exit)}));
	}),
).pipe(
	Command.withShortDescription(
		"Route one chore-lane state to its recipe, and its exit to one event.",
	),
	Command.withDescription(
		[
			"Prints the recipe verb a chore-lane state applies, or with --exit, the event its outcome records.",
			"  stdout: {state, verb, target, summary}, or with --exit {state, verb, exit, event, why}",
			"  22: the state applies no recipe; act on it and run no verb",
			'  Derivation: the operate skill\'s contract.md, "recipe route"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika recipe route unpark"},
		{command: "fabrika recipe route unpark --exit 12"},
	]),
);

export const recipeCommand = Command.make("recipe").pipe(
	Command.withSubcommands([unpark, rerun, route]),
	Command.withShortDescription("Apply one standing driver recipe as a deterministic verb."),
	Command.withDescription(
		"Apply one standing driver recipe: a fixed sequence with a checkable outcome and no judgment in it, versioned once instead of retyped nightly. Each verb relays a decision another verb already owns and proves every mutation with a read-back.",
	),
);
