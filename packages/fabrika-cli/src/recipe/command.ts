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
import {leafCommand} from "../excess-operand.ts";
import {DEFAULT_LANES_ROOT} from "../lane/store.ts";
import type {VerbOutcome} from "../verb.ts";
import {runRerun} from "./rerun-verb.ts";
import {runUnpark} from "./unpark-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

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
			Flag.withDefault(DEFAULT_LANES_ROOT),
			Flag.withDescription(`the lanes root directory (default: ${DEFAULT_LANES_ROOT})`),
		),
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the parked task; omittable on a single-task active phase"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({lane, root, task, repo}) {
		yield* emit(
			yield* runUnpark({
				root,
				lane,
				task: Option.getOrNull(task),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Clear a parked lane when the park is a known recipe."),
	Command.withDescription(
		"Clear one parked lane when its park matches the known-recipe table, and refuse with the ledger untouched when it does not. The park is read off `lane status`'s fold, the recipe's clearing condition is read off the verb that owns it (`ship cp-approval`'s ADR 0175 discharge at the PR's live head), the clear is recorded through `lane transition … UNBLOCKED`, and the answer is emitted only after a second fold reads the task out of the park. stdout is `{lane, task, park, clearance, mechanism, current}`. Respawning what the lane parked out of is the operator's, not this verb's. Exits 4 (a lane record was read in full and is not the shape), 7 (no lane there, or the PR the park waits on is proven absent or closed), 8 (the UNBLOCKED append did not land — it is NOT recorded), 9 (the append landed and the re-fold does not prove the clear — the lane needs a human), 11 (a precondition could not be read — UNKNOWN, never cleared), 12 (the park's cause is outside the recipe table — nothing was written; route it to a human), 13 (a known recipe whose clearing condition is not met yet — nothing was written), 14 (the task is not parked), 15 (the task is not in the active phase, --task was omitted where it is required, or no issue number can be resolved), 20 (the machine refused the UNBLOCKED, log unappended). Example: fabrika recipe unpark 5847",
	),
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
		"Rerun every workflow run that concluded in failure at a pull request's live head, and only behind a `governance` verdict that is PASS and bound to that head. The verdict is read first and the rerun is the only write, so every refusal is a proven no-op; each rerun is proven by re-reading its own run record — a new attempt, or a run no longer completed — never by the POST's own status. stdout is `{pr, head, verdict, rerun}`. Exits 7 (the PR is proven absent or closed), 8 (the rerun request did not land — it is NOT rerequested), 9 (the request landed and the run's re-read shows no new attempt — NOT proven), 11 (a precondition could not be read — UNKNOWN, never \"PASS\"), 16 (no governance verdict at all — form one), 17 (the latest governance verdict is bound to another head — re-form it here), 18 (the governance verdict at head is FAIL — repair the PR), 19 (no run at this head concluded in failure), 21 (the rerun was requested and could not be re-read — UNKNOWN). Example: fabrika recipe rerun 5851",
	),
);

export const recipeCommand = Command.make("recipe").pipe(
	Command.withSubcommands([unpark, rerun]),
	Command.withShortDescription("Apply one standing driver recipe as a deterministic verb."),
	Command.withDescription(
		"Apply one standing driver recipe: a fixed sequence with a checkable outcome and no judgment in it, versioned once instead of retyped nightly. Each verb relays a decision another verb already owns and proves every mutation with a read-back (ADR 0228; epic #5840)",
	),
);
