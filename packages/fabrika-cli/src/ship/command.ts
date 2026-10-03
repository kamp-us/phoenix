/**
 * The `ship` verb group — `fabrika ship <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives
 * in the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning
 * a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runChecks} from "./checks-verb.ts";
import {runCpApproval} from "./cp-approval-verb.ts";
import {runDisarm} from "./disarm-verb.ts";
import {runEnqueue} from "./enqueue-verb.ts";
import {runFloorBatch} from "./floor-batch.ts";
import {floorRunner} from "./floor-check.ts";
import {runGate} from "./gate-verb.ts";
import {runMerge} from "./merge-verb.ts";
import {MERGEABILITY_WINDOW_SECONDS} from "./mergeability.ts";
import {runNote} from "./note-verb.ts";
import {runNudge} from "./nudge-verb.ts";
import {ARM_SETTLE_FLOOR_SECONDS, runReconcile} from "./reconcile-verb.ts";
import {runRelease} from "./release-verb.ts";
import {runResolve} from "./resolve-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runThreads} from "./threads-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const prArg = Argument.integer("pr").pipe(
	Argument.withDescription("the pull-request number to act on"),
);

const shaFlag = Flag.string("sha").pipe(
	Flag.withDescription(
		"the head this answer binds to (7-40 lowercase hex); an empty or malformed value is a usage error, never a pattern matching every head",
	),
);

/**
 * The window every mergeability-reading verb gives GitHub's lazy `mergeable` job before calling it
 * UNKNOWN.
 *
 * Shared because they read through one poll loop, and two defaults would be two poll policies.
 */
const mergeabilitySecondsFlag = Flag.integer("mergeability-seconds").pipe(
	Flag.withDefault(MERGEABILITY_WINDOW_SECONDS),
	Flag.withDescription(
		"how long an indefinite `mergeable` is re-read before it is called UNKNOWN (backoff, not a fixed cadence)",
	),
);

const scope = leafCommand(
	"scope",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(
			yield* runScope({
				pr,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				caller: "shipper",
			}),
		);
	}),
).pipe(
	Command.withShortDescription("A PR's head, lifecycle, linked issue, classes and CP state."),
	Command.withDescription(
		"Prints one PR's head, state, linked issue, classes, namespaces, §CP state and landing path." +
			"\n  7: the PR is absent, has no changed files, or its diff derives no namespace" +
			"\n  11: a read failed; the scope is UNKNOWN" +
			"\n  13: the changed-file list hit GitHub's 3000-file ceiling, so it is partial" +
			"\n  33: this is the main working tree; respawn the shipper with `isolation: worktree`" +
			'\n  Derivation: the ship skill\'s contract.md, "ship scope"',
	),
	Command.withExamples([{command: "fabrika ship scope 4321"}]),
);

const cpApproval = leafCommand(
	"cp-approval",
	{
		pr: prArg,
		sha: shaFlag,
		mergeabilitySeconds: mergeabilitySecondsFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, mergeabilitySeconds, repo, json}) {
		yield* emit(
			yield* runCpApproval({
				pr,
				sha,
				mergeabilitySeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether the control-plane approval is discharged at a head."),
	Command.withDescription(
		"Prints one PR's §CP approval answer at a head: discharge, stop, base-conflicted or n/a, and how." +
			"\n  base-conflicted: no approval, and the head conflicts with its base; report BASE-CONFLICTED" +
			"\n  7: the PR is absent or closed, or has no changed files" +
			"\n  11: the boundary, roster, reviews, markers, live head or mergeability could not be read" +
			"\n  13: a comment, review or changed-file read is provably incomplete" +
			'\n  Derivation: the ship skill\'s contract.md, "ship cp-approval"',
	),
	Command.withExamples([{command: "fabrika ship cp-approval 4321 --sha 03135b91"}]),
);

const gate = leafCommand(
	"gate",
	{
		pr: prArg,
		sha: shaFlag,
		// `atLeast(1)` is the repeatable form AND the floor: a gate with no required namespace is
		// vacuously green, so the parser refuses it before the verb has to.
		require: Flag.string("require").pipe(
			Flag.atLeast(1),
			Flag.withDescription(
				"a required review namespace; repeat the flag once per namespace, exactly as `ship scope` printed them. The set is a floor the verb may raise, never a ceiling: a governance-root diff requires `governance` whether or not it is passed",
			),
		),
		cp: Flag.boolean("cp").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"resolve §CP advisory carriers for the code namespace; pass iff `ship cp-approval` discharged",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, require, cp, repo, json}) {
		yield* emit(
			yield* runGate({
				pr,
				sha,
				require,
				cp,
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The verdict conjunction over every required namespace."),
	Command.withDescription(
		"Prints whether every required namespace's verdict holds at one head, then one line per namespace." +
			"\n  7: the PR is absent or closed, or has no changed files" +
			"\n  10: a --require value is not a gateable namespace" +
			"\n  11: a read failed; the conjunction is UNKNOWN, never blocked or satisfied" +
			"\n  13: a changed-file, comment or review read is provably incomplete" +
			'\n  Derivation: the ship skill\'s contract.md, "ship gate"',
	),
	Command.withExamples([
		{command: "fabrika ship gate 4321 --sha 03135b91 --require review-code --require review-doc"},
	]),
);

const floor = leafCommand(
	"floor",
	{
		pr: prArg,
		sha: shaFlag,
		publishCheck: Flag.boolean("publish-check").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"publish the answer as the `governance floor at head` check-run (needs `checks: write`) instead of seating it on this verb's exit code; the process then exits 0 whenever the check-run landed",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, publishCheck, repo, json}) {
		const options = {
			pr,
			sha,
			repo: Option.getOrNull(repo),
			json,
			cwd: process.cwd(),
			env: process.env,
		};
		yield* emit(yield* floorRunner(publishCheck)(options));
	}),
).pipe(
	Command.withShortDescription("Whether a governance-root diff carries its governance verdict."),
	Command.withDescription(
		"Prints whether the governance floor binds on one PR at a head: satisfied or n/a, and the verdict." +
			"\n  7: the PR is absent or closed, or has no changed files" +
			"\n  8: --publish-check only: the check-run could not be written" +
			"\n  9: --publish-check only: GitHub echoed a state this run did not decide" +
			"\n  11: a read failed; the floor is UNKNOWN, never n/a" +
			"\n  13: the changed-file list hit GitHub's 3000-file ceiling, so it is partial" +
			"\n  18: the governance verdict is absent, stale or fail; a human owes this PR one" +
			'\n  Derivation: the ship skill\'s contract.md, "ship floor"',
	),
	Command.withExamples([
		{command: "fabrika ship floor 4321 --sha 03135b91"},
		{command: "fabrika ship floor 4321 --sha 03135b91 --publish-check"},
	]),
);

const floorBatch = leafCommand(
	"floor-batch",
	{
		sha: shaFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({sha, repo, json}) {
		yield* emit(yield* runFloorBatch({sha, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Put the floor's required context on a merge queue's batch ref."),
	Command.withDescription(
		"Publishes the governance floor check-run on a merge queue's batch head and prints what landed." +
			"\n  8: the check-run could not be written" +
			"\n  9: GitHub echoed a state this run did not decide" +
			"\n  11: the head's check-runs could not be enumerated; nothing was published" +
			'\n  Derivation: the ship skill\'s contract.md, "ship floor-batch"',
	),
	Command.withExamples([{command: "fabrika ship floor-batch --sha 03135b91"}]),
);

const checks = leafCommand(
	"checks",
	{
		pr: prArg,
		sha: shaFlag,
		wait: Flag.boolean("wait").pipe(
			Flag.withDefault(false),
			Flag.withDescription("poll until a terminal state or the budget expires"),
		),
		budgetSeconds: Flag.integer("budget-seconds").pipe(
			Flag.withDefault(600),
			Flag.withDescription("--wait only: total wall-clock budget, gh-call latency included"),
		),
		cadenceSeconds: Flag.integer("cadence-seconds").pipe(
			Flag.withDefault(30),
			Flag.withDescription("--wait only: sleep between polls"),
		),
		wedgeDwellSeconds: Flag.integer("wedge-dwell-seconds").pipe(
			Flag.withDefault(120),
			Flag.withDescription(
				"--wait only: how long a queued-never-started check dwells before it reads wedged",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		pr,
		sha,
		wait,
		budgetSeconds,
		cadenceSeconds,
		wedgeDwellSeconds,
		repo,
		json,
	}) {
		yield* emit(
			yield* runChecks({
				pr,
				sha,
				wait,
				budgetSeconds,
				cadenceSeconds,
				wedgeDwellSeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				cwd: process.cwd(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Roll up the head CI, latest run per context."),
	Command.withDescription(
		"Prints one PR's head CI rollup, latest run per context, then its tally by class." +
			"\n  7: the PR or --sha is absent, or the repo has no repo-authored workflow and does not degrade" +
			"\n  11: a check-run, workflow, required-set or config read failed; CI is UNKNOWN" +
			"\n  13: a run count or the base's ruleset walk is provably incomplete" +
			"\n  20: every check passed but no workflow this repo authors inspected this head" +
			'\n  Derivation: the ship skill\'s contract.md, "ship checks"',
	),
	Command.withExamples([{command: "fabrika ship checks 4321 --sha 03135b91 --wait"}]),
);

const threads = leafCommand(
	"threads",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(yield* runThreads({pr, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Every unresolved review thread with its class facts."),
	Command.withDescription(
		"Prints the count of one PR's unresolved review threads, then one line per thread with its class." +
			"\n  7: the PR is absent" +
			"\n  11: the thread read failed or is malformed; UNKNOWN, never zero" +
			"\n  13: a thread or comment enumeration is provably short" +
			'\n  Derivation: the ship skill\'s contract.md, "ship threads"',
	),
	Command.withExamples([{command: "fabrika ship threads 4321"}]),
);

const resolve = leafCommand(
	"resolve",
	{
		pr: prArg,
		thread: Flag.string("thread").pipe(
			Flag.withDescription("the review-thread node id to resolve"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, thread, repo, json}) {
		yield* emit(
			yield* runResolve({
				pr,
				thread,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Resolve one bot-classed review thread with a rationale."),
	Command.withDescription(
		"Resolves one bot-classed review thread with the rationale on stdin and prints the reply URL." +
			"\n  3: no rationale on stdin" +
			"\n  5: the rationale carries a machine-local path" +
			"\n  6: the rationale carries a bare @ reference" +
			"\n  7: the PR or thread is absent" +
			"\n  8: a write or its re-read failed; what landed is UNKNOWN" +
			"\n  9: the read-back does not show it resolved with the rationale" +
			"\n  11: the thread's state could not be read; nothing was written" +
			"\n  16: already resolved, or not positively bot-classed" +
			'\n  Derivation: the ship skill\'s contract.md, "ship resolve"',
	),
	Command.withExamples([
		{command: "fabrika ship resolve 4321 --thread PRRT_kwDOLxx1 < rationale.md"},
	]),
);

const enqueue = leafCommand(
	"enqueue",
	{
		pr: prArg,
		sha: shaFlag,
		mergeabilitySeconds: mergeabilitySecondsFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, mergeabilitySeconds, repo, json}) {
		yield* emit(
			yield* runEnqueue({
				pr,
				sha,
				mergeabilitySeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Arm the merge queue at a pinned head and prove it landed."),
	Command.withDescription(
		"Arms the merge queue's auto-merge at a pinned head and prints `enqueued`, queued or settling." +
			"\n  7: the PR is absent, closed or already merged" +
			"\n  8: the arm or its read-back failed; run `ship disarm --site refuse` before stopping" +
			"\n  11: head, owner or mergeability unread or indefinite; nothing was armed" +
			"\n  12: the live head moved past --sha" +
			"\n  16: provably not mergeable for a reason other than a conflicted base" +
			"\n  21: the base moved and the merge conflicts; report BASE-CONFLICTED" +
			"\n  22: PR not ours, no takeover grant; nothing was armed" +
			'\n  Derivation: the ship skill\'s contract.md, "ship enqueue"',
	),
	Command.withExamples([{command: "fabrika ship enqueue 4321 --sha 03135b91"}]),
);

const merge = leafCommand(
	"merge",
	{
		pr: prArg,
		sha: shaFlag,
		mergeabilitySeconds: mergeabilitySecondsFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, mergeabilitySeconds, repo, json}) {
		yield* emit(
			yield* runMerge({
				pr,
				sha,
				mergeabilitySeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Land a PR on a base no merge queue governs, proof read back."),
	Command.withDescription(
		"Lands one PR on a base no merge queue governs and prints the merge commit and method." +
			"\n  7: the PR is absent, closed or already merged" +
			"\n  8: the merge or its read-back failed; landing is UNKNOWN" +
			"\n  9: the read-back does not show it merged at a commit" +
			"\n  11: a read failed or stayed indefinite; nothing merged" +
			"\n  12: the live head moved past --sha" +
			"\n  16: a merge queue governs the base (use `ship enqueue`), or not mergeable" +
			"\n  19: the repository permits no merge method; a human must enable one" +
			"\n  22: PR not ours, no takeover grant; nothing merged" +
			'\n  Derivation: the ship skill\'s contract.md, "ship merge"',
	),
	Command.withExamples([{command: "fabrika ship merge 4321 --sha 03135b91"}]),
);

const reconcile = leafCommand(
	"reconcile",
	{
		pr: prArg,
		polls: Flag.integer("polls").pipe(
			Flag.withDefault(16),
			Flag.withDescription("classification attempts before the horizon"),
		),
		cadenceSeconds: Flag.integer("cadence-seconds").pipe(
			Flag.withDefault(30),
			Flag.withDescription("sleep between polls (between only — no trailing sleep)"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, polls, cadenceSeconds, repo, json}) {
		yield* emit(
			yield* runReconcile({
				pr,
				polls,
				cadenceSeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Watch a queued PR to a terminal classification."),
	Command.withDescription(
		"Watches a queued PR and prints landed, ejected, unresolved or parked, with the polls used." +
			"\n  parked needs a never-queued arm on a queue-governed base that has waited past the floor" +
			`\n  (its latest auto_merge_enabled event is ${ARM_SETTLE_FLOOR_SECONDS} s old or more); a younger one reads unresolved` +
			"\n  7: the PR is absent" +
			"\n  11: every poll failed to read; UNKNOWN, not unresolved" +
			"\n  13: the timeline read never reached a terminal page" +
			'\n  Derivation: the ship skill\'s contract.md, "ship reconcile"',
	),
	Command.withExamples([{command: "fabrika ship reconcile 4321"}]),
);

const disarm = leafCommand(
	"disarm",
	{
		pr: prArg,
		site: Flag.string("site").pipe(
			Flag.withDescription(
				"preflight | refuse | post-enqueue | ejected — the merge-intent lifecycle site; the policy differs per site",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, site, repo, json}) {
		yield* emit(yield* runDisarm({pr, site, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Clear or deliberately keep a parked merge intent."),
	Command.withDescription(
		"Clears or deliberately keeps a parked merge intent at one site and prints kept or disarmed." +
			"\n  8: the re-read cannot confirm the intent is clear; report `merge intent: NOT cleared`" +
			"\n  10: --site is not one of the four sites" +
			"\n  11: the armed-state read failed before any write" +
			'\n  Derivation: the ship skill\'s contract.md, "ship disarm"',
	),
	Command.withExamples([{command: "fabrika ship disarm 4321 --site preflight"}]),
);

const nudge = leafCommand(
	"nudge",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(yield* runNudge({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Remedy a dropped CI trigger by close then reopen, once."),
	Command.withDescription(
		"Closes and reopens one PR, once per head, to remedy a dropped CI trigger; prints `nudged`." +
			"\n  7: the PR is absent" +
			"\n  8: the close failed; nothing changed state" +
			"\n  11: a precondition read failed; nothing was touched" +
			"\n  12: the live head moved past --sha" +
			"\n  13: the timeline read never reached a terminal page" +
			"\n  16: not in the dropped-trigger state, or this head was already nudged" +
			"\n  17: THE CLOSE LANDED AND THE REOPEN IS UNCONFIRMED; reopen the PR by hand now" +
			'\n  Derivation: the ship skill\'s contract.md, "ship nudge"',
	),
	Command.withExamples([{command: "fabrika ship nudge 4322 --sha 9fe12ab0"}]),
);

const note = leafCommand(
	"note",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(
			yield* runNote({
				pr,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the durable stop-path note on stdin to the PR."),
	Command.withDescription(
		"Posts the stop-path note on stdin as a new PR comment and prints its URL." +
			"\n  3: no body on stdin" +
			"\n  5: the body carries a machine-local path" +
			"\n  6: the body carries a bare @ reference" +
			"\n  7: the PR is absent" +
			"\n  8: the create or its re-read failed; whether it landed is UNKNOWN" +
			"\n  9: it landed and the read-back does not match" +
			"\n  11: the PR could not be read; nothing was posted" +
			'\n  Derivation: the ship skill\'s contract.md, "ship note"',
	),
	Command.withExamples([{command: "fabrika ship note 4322 < stop.md"}]),
);

const release = leafCommand(
	"release",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(yield* runRelease({pr, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Detect a dark ship and queue its issue for release."),
	Command.withDescription(
		"Prints whether one PR is a dark ship, and queues its linked issue for release when it is." +
			"\n  7: the PR is absent, or has no changed files" +
			"\n  8: the label write or its re-read failed; escalate" +
			"\n  9: the label landed and the read-back does not show it" +
			"\n  11: the diff, body, registry or linked issue could not be read; UNKNOWN" +
			"\n  13: the changed-file list hit GitHub's 3000-file ceiling, so it is partial" +
			"\n  23: the release label is absent from the repository's taxonomy" +
			'\n  Derivation: the ship skill\'s contract.md, "ship release"',
	),
	Command.withExamples([{command: "fabrika ship release 4321"}]),
);

export const shipCommand = Command.make("ship").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		scope,
		cpApproval,
		gate,
		floor,
		floorBatch,
		checks,
		threads,
		resolve,
		enqueue,
		merge,
		reconcile,
		disarm,
		nudge,
		note,
		release,
	]),
	Command.withShortDescription("Drive one pull request down the merge path."),
	Command.withDescription(
		"Everything the merge path needs off one pull request — scope, §CP discharge, the verdict conjunction, head CI and review threads — plus the writes that arm, land, watch, disarm and record it",
	),
);
