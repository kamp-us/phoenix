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
		"Clear one parked lane when its park matches the known-recipe table, and refuse with the ledger untouched when it does not. The park is seated by its leaf state AND the cause its parking event named (`lane report`/`lane transition --cause`, a closed set in code) — a BLOCKED with no cause keys on nothing and is novel. The recipe's clearing condition is read off the verb that owns it: `ship cp-approval`'s discharge at the PR's live head for the §CP park, for the worktree-holds-branch park the same working-tree read `build branch --resume-lane` refuses on, and for the campaign-paused park the lane milestone's `## Campaigns` State cell at origin/main, which is the whole dispatch permission — cleared only on `active`, and never resumed here. The spawn-dead park is the one whose read is the lane rather than the cause: no verb can spawn an agent to ask whether the provider is back, so it proves only that the dead shell left nothing that would refuse the same brief being dispatched again — no build claim standing on the issue, and no working tree holding its lane branch. There is no heartbeat, so what proves the shell dead is its claim outliving the budget for the kind of work it took: a claim past that budget is RETRACTED here and re-read to prove it gone, so a fresh shell can claim the number with no hand adopt-and-release, while a claim still inside its budget holds the park at 13 and a retraction the board does not confirm is 9. The tree-hijacked park — a builder that stopped because its checkout held another lane's branch or unauthored work — reads that same spawn-dead clearance, since what the next dispatch needs is the same. The claim-stranded park — a builder that lost `build claim` to a claim a stopped shell of the same session left behind, which `build adopt` cannot reach — clears only when `build claimants` reads the issue `unclaimed`, and retracts nothing on any arm: a same-session claimant may still be live, so a claim still standing holds the park at 13 until the driver releases it under its token. The red-CI park is the second row on the `human:cp-approval` leaf, told apart from the §CP one by its cause alone: a shipper that routed to `heal-ci` and one that stopped on an approval both fold to that state, so the row keyed `head-ci-red` clears the first and the null-cause row still clears the second. Its read is the shipper's own step 4 taken again — `ship checks`'s rollup at the live head, where only `green` clears and every other word is exit 13 — conjoined with the floor that step stood on: `ship scope` for the PR still being open and not a draft, and `ship gate` (with no --cp, which is the shipper's to discharge) for every namespace the diff derives still holding a binding verdict at that head. Any of those reads failing is 11, never a clear. The routed-UI park (`blocked` keyed `no-rendered-delta`) is that same floor minus CI, and it clears the lanes stranded before `lane report` learned to advance a satisfied route: `ship scope` for the PR still being open, and `ship gate` (no --cp) for the conjunction at the live head, which must read `satisfied` AND leave some required namespace still reading `routed` there. The second half is what keeps the clear the inverse of this cause rather than a generic everything-passed: a PR whose rendered gate came back and judged it is a different park, and it holds at 13 with the reason named. The queue-stall park is the one row whose clear also GRANTS: its read is `ship reconcile`'s answer relayed, where `landed` and `ejected` clear and `unresolved` is exit 13, and because the park IS a spent wait budget the clear records the waits it buys on the very same UNBLOCKED — one event, so the resumed lane comes back one conclusive read below its budget instead of re-parking. A park no row covers is not always a human's: every park cause carries a route, and where that route is `driver` — the park is machinery a driver session owns — a repo declaring `parkCause.driverRouted: \"clear\"` lets this verb clear it on the driver's own `--rationale` instead of refusing at 12. That key is read from the `.fabrika.jsonc` of the repository that OWNS the cwd, never the cwd's own copy, because the rule is weighed against the one shared lane ledger a linked worktree and its primary checkout derive alike — so a worktree branch's tracked copy governs no park here. There is no proving read on that arm, so the rationale is what stands in its place and is required: without one the clear is refused at 23 with nothing written, and with one it rides the UNBLOCKED and reads back as the task's standing `rationale`. A `founder` route reaches none of that and refuses at 12 exactly as before, and so does every park under the shipped `parkCause.driverRouted: \"refuse\"`. The clear is recorded through `lane transition … UNBLOCKED`, and the answer is emitted only after a second fold reads the task out of the park. stdout is `{lane, task, park, clearance, mechanism, current}`, plus `waitGrant` on a clear that granted and `rationale` on one the driver named — `clearance` is the recipe's read, else `driver-rationale`. Respawning what the lane parked out of is the operator's, not this verb's. Exits 4 (a lane record was read in full and is not the shape), 7 (no lane there; the PR the park waits on is proven absent, or closed where the row needs it open — the queue-stall row nominates at open-or-merged scope, since a landed PR is closed; or the lane's issue is absent, homed on no milestone, or homed on one no ## Campaigns row pins), 8 (the UNBLOCKED append did not land — it is NOT recorded), 9 (the append landed and the re-fold does not prove the clear — the lane needs a human), 11 (a precondition could not be read — UNKNOWN, never cleared; `parkCause` itself is one, and so is the repository identity its owning root is derived from, since a cwd whose repository will not read leaves the declaration unresolved rather than guessed at the cwd), 12 (the park's cause is outside the recipe table and does not route to the driver here — nothing was written; route it to a human), 13 (a known recipe whose clearing condition is not met yet — nothing was written), 14 (the task is not parked), 15 (the task is not in the active phase, --task was omitted where it is required, or no issue number can be resolved), 20 (the machine refused the UNBLOCKED, log unappended), 23 (the park routes to the driver and this run named no --rationale — nothing was written; re-run naming one), 39 (the lanes root resolves nowhere: --root is absent and no .git entry exists at or above the cwd, so there is no owning repository from which to derive the default lanes root, or a relative --root stands on a cwd holding neither .fabrika nor .git; the `parkCause` read ahead of it never exits here, since a cwd in no repository reads the shipped declaration at itself, and an unreadable repository identity is UNKNOWN at 11; NOT \"no lane here\", so never a park), 65 (the lanes root stands inside a linked worktree instead of the repository that owns it, so it is a second copy of that ledger frozen at whatever moment it was written — nothing was read and nothing was appended; pass a root under the owning repository, or drop --root). Example: fabrika recipe unpark 5847",
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
		"Answer what a chore drive does at one chore-lane state. Without --exit, stdout is `{state, verb, target, summary}` — which recipe verb the state applies and whether it is pointed at a lane key or a pull-request number. With --exit, stdout is `{state, verb, exit, event, why}` — the single machine event that run's outcome records, from the closed table in `recipe/drive.ts`; an exit the table has no reading for records BLOCKED, never a permissive default. Nothing here reads a lane or the board: it is the routing answer `operate`'s chore drive relays instead of restating it in prose. Exits 22 (the state applies no recipe — act on that state, do not run a verb). Examples: fabrika recipe route unpark · fabrika recipe route unpark --exit 12",
	),
);

export const recipeCommand = Command.make("recipe").pipe(
	Command.withSubcommands([unpark, rerun, route]),
	Command.withShortDescription("Apply one standing driver recipe as a deterministic verb."),
	Command.withDescription(
		"Apply one standing driver recipe: a fixed sequence with a checkable outcome and no judgment in it, versioned once instead of retyped nightly. Each verb relays a decision another verb already owns and proves every mutation with a read-back.",
	),
);
