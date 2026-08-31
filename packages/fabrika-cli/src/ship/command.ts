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
import {runEvidence} from "./evidence-verb.ts";
import {runFloorBatch} from "./floor-batch.ts";
import {floorRunner} from "./floor-check.ts";
import {runGate} from "./gate-verb.ts";
import {runMerge} from "./merge-verb.ts";
import {runNote} from "./note-verb.ts";
import {runNudge} from "./nudge-verb.ts";
import {runReconcile} from "./reconcile-verb.ts";
import {runRelease} from "./release-verb.ts";
import {runResolve} from "./resolve-verb.ts";
import {runReviewUiRequest} from "./review-ui-request-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runThreads} from "./threads-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
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

const fullShaFlag = Flag.string("sha").pipe(
	Flag.withDescription(
		"the full exact lowercase 40-character head whose governed review-ui evidence event is requested",
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
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("A PR's head, lifecycle, linked issue, classes and CP state."),
	Command.withDescription(
		"Report one PR's head, lifecycle state, linked issue, artifact classes with the review namespaces they require, and the three-state §CP classification derived from .github/CODEOWNERS at the base branch. First stdout line is `scoped\\t<head>\\t<open|draft|merged|closed>\\t<fixes:n|part-of:n|->`, then one `class\\t<name>\\t<files>` line per present class, one `namespace\\t<ns>` line per required namespace, `cp\\t<state>`, `landing\\t<queue|direct|none|unknown>\\t<squash|merge|rebase|->` and `files\\t<n>`. The landing line names which of the two landing paths this base branch has — `queue` is `ship enqueue`'s, `direct` is `ship merge`'s. It is the one field that degrades to `unknown` rather than refusing; `ship merge` re-derives the same fact and refuses on its own read. A merged, draft or closed PR is an ANSWER, not a refusal. Exits 7 (PR proven absent, zero changed files, or a non-empty diff deriving zero namespaces — a vacuous conjunction), 11 (the PR, its file list or the §CP boundary could not be read — the scope is UNKNOWN), 13 (the file list is provably short of the declared count). Example: fabrika ship scope 4321",
	),
);

const cpApproval = leafCommand(
	"cp-approval",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runCpApproval({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether the control-plane approval is discharged at a head."),
	Command.withDescription(
		"Discharge the ADR 0175 §CP cardinality table at one head: `cp-approval\\t<discharge|stop|n/a>\\t<mechanism>`. The roster is the control-plane team parsed off .github/CODEOWNERS, read fresh; every discharge signal is head-bound, so a stale approval on a superseded head never counts. A failed read is UNRESOLVED, never `stop` and never `awaiting-approval`. A stderr notice fires when the banked head is behind the base. Exits 7 (PR proven absent or closed), 11 (the boundary, roster, reviews, markers or live head could not be read), 13 (the comment enumeration is provably short of the declared count, or the review read — which the platform gives no count for — never reached a terminal page with no `next` link). Example: fabrika ship cp-approval 4321 --sha 03135b91",
	),
);

const gate = leafCommand(
	"gate",
	{
		pr: prArg,
		sha: shaFlag,
		// `atLeast(1)` is the repeatable form AND the floor: a gate with no required namespace is
		// vacuously green, so the parser refuses it before the verb has to (#2765).
		require: Flag.string("require").pipe(
			Flag.atLeast(1),
			Flag.withDescription(
				"a required review namespace; repeat the flag once per namespace, exactly as `ship scope` printed them. The set is a floor the verb may raise, never a ceiling: a governance-root diff requires `governance` whether or not it is passed (#5036)",
			),
		),
		cp: Flag.boolean("cp").pipe(
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
		"Resolve the verdict conjunction over every required namespace at one head. First stdout line is `gate\\t<satisfied|blocked>\\t<sha>`, then one `ns\\t<namespace>\\t<pass|fail|absent|stale|routed>\\t<marker|advisory|review-fold|routed-elsewhere|->` line per required namespace, in the order required; `satisfied` iff every one reads pass or routed, and the coverage of the required set is asserted before that word is printed. In-force resolution is head-bound-first then by write stamp, ACL-gated fail-closed (ADR 0055). Both `absent` and `stale` block. `routed` is the fifth state: a head-bound `routed-elsewhere` record, readable only for `review-ui`, saying the gate owes this PR no verdict; it satisfies beside pass and carries no polarity (ADR 0316). The required set is a floor the verb raises from the diff itself: a PR touching `.decisions/`, `.claude/`, `.github/` or `claude-plugins/` gates on `governance` whether or not --require named it. Exits 7 (PR proven absent or closed, or the diff has zero changed files), 10 (a --require value is not a gateable namespace), 11 (the changed-file list, comments, reviews or the ACL could not be read — the conjunction is UNKNOWN, never blocked and never satisfied), 13 (the changed-file or comment enumeration is provably short of the declared count, or the review read — which the platform gives no count for — never reached a terminal page with no `next` link). Example: fabrika ship gate 4321 --sha 03135b91 --require review-code --require review-doc",
	),
);

const floor = leafCommand(
	"floor",
	{
		pr: prArg,
		sha: shaFlag,
		publishCheck: Flag.boolean("publish-check").pipe(
			Flag.withDescription(
				"publish the answer as a check-run on the head instead of seating it on this verb's exit code; the process then exits 0 whenever the check-run landed",
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
		"Decide whether the governance floor binds on this PR at one head, and seat the answer on an exit code a CI job can red on. Prints `floor\\t<satisfied|n/a>\\t<sha>` then `ns\\tgovernance\\t<pass|->`; `n/a` is a proven answer about the diff — it touches no governance root — and never a discharged verdict. The verdict itself is `ship gate`'s, asked for the one `governance` namespace; this decides nothing about enqueue. Exits 7 (PR proven absent or closed, or zero changed files), 11 (the PR, its file list or the conjunction could not be read — the floor is UNKNOWN, never n/a), 13 (the changed-file enumeration is provably short — a governance root could sit in the part nobody read), 18 (the diff touches a governance root and its governance verdict is absent, stale or fail — the one refusal that means a human owes this PR a verdict). With --publish-check the same answer is seated on a check-run named `governance floor at head` instead (`checks: write` required): `satisfied`/`n/a` conclude success, `absent` leaves the check-run in_progress, `stale`/`fail` conclude failure, and UNKNOWN concludes failure too (ADR 0092). In that mode the process exits 0 whenever the check-run landed — a non-zero means the verb could not publish, never that the floor is unmet — and it seats 8 (the check-run could not be written) and 9 (GitHub echoed a state this run did not decide). Every other caller's exit semantics are unchanged. Example: fabrika ship floor 4321 --sha 03135b91",
	),
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
		"Publish the `governance floor at head` check-run on a merge queue's batched `merge_group` head, concluded success (`checks: write` required). Prints `check\\t<status>\\t<conclusion>\\t<id>`, then `floor\\tbatch\\t<sha>` and `ns\\tgovernance\\t-`. It takes no PR number and resolves no floor: a batch ref is not a pull request, so `ship floor` has no input on it. What still holds the floor, and why the batch needs its own publish, is in claude-plugins/fabrika/skills/ship/contract.md. Exits 1 (usage: --sha is not 7-40 lowercase hex, or no target repo resolves), 8 (the check-run could not be written), 9 (GitHub echoed a state this run did not decide), 11 (the check-runs at the head could not be enumerated, so nothing was published rather than a duplicate row). Example: fabrika ship floor-batch --sha 03135b91",
	),
);

const checks = leafCommand(
	"checks",
	{
		pr: prArg,
		sha: shaFlag,
		wait: Flag.boolean("wait").pipe(
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
		"Roll up the head CI from REST check-runs, latest-per-context. First stdout line is `checks\\t<sha>\\t<green|red|pending|wedged|no-runs|no-producer>`, then `run\\t<count>` — the latest-per-context runs read, gating and informational both — then the collapsed tally of those runs, one `check\\t<status>/<gating|informational>\\t<count>` line per class, count-descending with ties broken on the class, and `facts\\tworkflows:<n>\\truns:<n>` — the zero-checkset discriminators. The runs a terminal reads by name are named on stderr instead: the wedged run, and the failing gating runs to route to heal-ci (informational failures are excluded — they gate nothing). A repo with zero workflows is `no-producer`, never `pending`. That case refuses unless `.fabrika.jsonc` declares `ci.noProducer: \"degrade\"`. A `green` is served only over bytes a gate of this repo's own inspected: where the rollup would be green the head's workflow runs are read against the active inventory through the same `review ci` coverage module, repo-authored `.github/workflows/…` paths told from the platform's `dynamic/<provider>/<name>` ones, and a head where the repo declares workflows and none of them ran refuses on 20; otherwise the coverage rides the notes channel. With --wait a `settle\\t<settled|budget-exhausted|head-moved>` line leads the emission. The rollup is fail-closed on the ambiguous rows and the informational carve-out is ADR 0061's denylist; a wedge is diagnosed and named, and the cancel-and-rerun lever stays an operator's. Exits 7 (PR or --sha proven absent, or zero workflows under the default — ADR 0092), 11 (the check-run read, the workflow read or `.fabrika.jsonc` failed — CI state is UNKNOWN, never green), 13 (entries received < declared), 20 (every check passed and no workflow the repo authors produced a run at this head — no gate inspected these bytes). Example: fabrika ship checks 4321 --sha 03135b91 --wait",
	),
);

const evidence = leafCommand(
	"evidence",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runEvidence({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Read the SHA-bound run-evidence bundle."),
	Command.withDescription(
		"Read the SHA-bound run-evidence bundle as five states. First stdout line is `evidence\\t<present|pending|failed|absent|unknown>\\t<sha>`, then `lookup\\trun:<id|->\\tartifact:<id|->\\tstatus:<status|->` — the evidence that makes the claim falsifiable — then the manifest's checks as a status tally, one `check\\t<status>\\t<count>` line per status, count-descending with ties broken on the status; a state that read no manifest carries no such line, and on `failed` the non-passing checks are named on stderr. `failed` is a bundle that binds this head and attests a failing run; `unknown` means the opposite — the answer cannot bind this head. Pending is not absent: a completed run with zero artifacts reads `pending` within 120s of its `completed_at` against the local clock and `absent` outside it. A failed read is not absent either, and the fetched artifact's zip magic number is checked before anything parses it. Exits 7 (PR or --sha proven absent), 11 (the run list, artifact list or artifact content could not be read after retries), 13 (a run or artifact enumeration is provably short). Example: fabrika ship evidence 4321 --sha 03135b91",
	),
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
		"List every unresolved review thread with its class facts, both pagination layers count-proved. First stdout line is `threads\\t<count>` — 0 is a proven answer — then one `thread\\t<id>\\t<bot|human>\\t<path:line|pr-level>\\t<author>\\t<excerpt>` line each. A thread is `bot` only when EVERY comment author is a GraphQL Bot; everything else is human by construction, with no login-suffix inference and no allowlist. This is the sanctioned GraphQL exception — thread resolution state has no REST equivalent. Exits 7 (PR proven absent), 11 (the thread read failed or fails shape validation — UNKNOWN, never zero), 13 (a thread or comment enumeration is provably short). Example: fabrika ship threads 4321",
	),
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
		"Resolve ONE bot-classed review thread: re-derive its live state and class, leak-scan the rationale on STDIN, post the rationale as a reply, fire the resolve mutation, and read both back. Prints `resolved\\t<thread-id>\\t<comment-url>`. The rationale arrives on stdin only; there is no path flag. Exits 3 (no rationale — a silent resolve is unauditable), 5 (machine-local path in the rationale), 6 (bare @ reference), 7 (PR or thread proven absent), 8 (the reply, the mutation or the confirming re-read failed — UNKNOWN what landed), 9 (the read-back does not show it resolved with the rationale), 11 (the thread's state could not be re-derived — nothing was written), 16 (proven: already resolved, or not positively bot-classed — a human objection is theirs to resolve). Example: fabrika ship resolve 4321 --thread PRRT_kwDOLxx1 < rationale.md",
	),
);

const enqueue = leafCommand(
	"enqueue",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(yield* runEnqueue({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Arm the merge queue at a pinned head and prove it landed."),
	Command.withDescription(
		"Arm the merge queue's auto-merge at a pinned head and prove the arm landed. Prints `enqueued\\t<sha>\\t<queued|settling>` — `settling` is the normal race, not a failure. There is NO merge-method flag: the queue owns the method. `auto_merge: null` post-enqueue is expected and is never read as a jam. Before the arm, a DEFINITE and TRUE `mergeable` is asserted: `mergeable` is computed lazily so an indefinite value is polled, and if it is still indefinite it is UNKNOWN and refuses on 11; a definite `mergeable: false` refuses on 16. Exits 7 (PR proven absent, closed or already merged), 8 (the arm or its confirming read-back failed — whether an intent is parked is UNKNOWN, so run `fabrika ship disarm --site refuse` before stopping), 11 (the live head or the mergeability could not be read, or mergeability stayed indefinite — nothing was armed), 12 (the live head moved past --sha — refusing to arm a tree nobody verified), 16 (the PR is provably not mergeable — nothing was armed). Example: fabrika ship enqueue 4321 --sha 03135b91",
	),
);

const merge = leafCommand(
	"merge",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(yield* runMerge({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Land a PR on a base no merge queue governs, proof read back."),
	Command.withDescription(
		"Land a pull request directly on a base branch NO merge queue governs, and prove the landing. Prints `merged\\t<merge-commit-sha>\\t<squash|merge|rebase>`. This is the second landing path, not a flag on the first: `ship enqueue` stays method-free. The method is READ off the repository's allow_squash_merge / allow_merge_commit / allow_rebase_merge, preferring squash because its subject is the `(#<pr>)` anchor `ship reconcile` proves a landing with; a repo permitting none refuses rather than guessing. A definite `mergeable_state` is asserted before the write and a definite `false` refuses. The merge call's own response is never the proof — `merged` plus the merge commit are read back off the PR after it. Exits 7 (PR proven absent, closed or already merged), 8 (the merge, or its confirming read-back, failed — whether it landed is UNKNOWN; re-read the PR), 9 (the read-back does not show it merged at a commit), 11 (the live head, the landing path or the mergeability could not be read, or mergeability stayed indefinite — nothing was merged), 12 (the live head moved past --sha), 16 (a merge queue governs the base — run `fabrika ship enqueue`; or the PR is provably not mergeable), 19 (the repository permits no merge method at all — a human enables one in the repository settings). Example: fabrika ship merge 4321 --sha 03135b91",
	),
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
		"Watch a queued PR to a terminal classification. Prints `reconcile\\t<landed|ejected|unresolved|parked>\\t<polls-used>\\t<horizon-seconds>` — all four are proven answers at exit 0. `landed` on merged:true or a base-branch squash whose subject ENDS with `(#<pr>)`; `ejected` only on a removal NOT paired with a merge; `unresolved` means still-queued at the horizon, the expected outcome of a healthy long dwell; `parked` means the arm never entered a queue on a queue-governed base. Exits 7 (PR proven absent), 11 (every poll failed to read — UNKNOWN, distinct from `unresolved`), 13 (the timeline read — which the platform gives no count for — never reached a terminal page with no `next` link). Example: fabrika ship reconcile 4321",
	),
);

const disarm = leafCommand(
	"disarm",
	{
		pr: prArg,
		site: Flag.string("site").pipe(
			Flag.withDescription(
				"preflight | refuse | post-enqueue | ejected — the ADR 0198 lifecycle site; the policy differs per site",
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
		"Clear or deliberately keep a parked merge intent at one ADR 0198 lifecycle site. Prints `disarm\\t<kept|disarmed>\\t<site>\\t<reason>`, where kept reasons are the closed set merged | live-queued | not-armed | pre-queue-regime and the disarmed reason is `cleared`, proven by re-reading auto_merge after the write; the disable call's own exit status is never trusted. An unreadable armed-state reads armed and an unreadable queue regime reads queue-governed; a live queue entry is never disturbed. There is no 7 seat: a disarm aimed at a merged or absent PR answers `kept`. Exits 8 (the re-read cannot confirm the intent is clear — report `merge intent: NOT cleared`), 10 (--site is not one of the four sites), 11 (the armed-state read failed before any write). Example: fabrika ship disarm 4321 --site preflight",
	),
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
		"Remedy a dropped CI trigger by close→reopen, at most once per head, after re-deriving the precondition itself. Prints `nudged\\t<sha>`. The verb trusts nothing it was told: zero check runs, zero commit statuses, at least one workflow and an open PR are all re-read here. The head ref is untouched by construction, so SHA-bound verdicts survive. Exits 7 (PR proven absent), 8 (the close failed — nothing changed state), 11 (a precondition read failed — nothing was proven, nothing touched), 12 (the live head moved past --sha), 13 (the timeline read never reached a terminal page with no `next` link — the platform gives no count for it), 16 (proven not in the dropped-trigger state, or this head was already nudged), 17 (THE CLOSE LANDED AND THE REOPEN IS UNCONFIRMED — the PR may be closed; reopen it by hand now). Example: fabrika ship nudge 4322 --sha 9fe12ab0",
	),
);

const reviewUiRequest = leafCommand(
	"review-ui-request",
	{
		pr: prArg,
		sha: fullShaFlag,
		harness: Flag.string("harness").pipe(
			Flag.withDescription(
				"the localhost-only harness id from the governed default-branch declaration",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, harness, repo, json}) {
		yield* emit(
			yield* runReviewUiRequest({
				pr,
				sha,
				harness,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Request one missing governed review-ui evidence run, once."),
	Command.withDescription(
		"Operator-owned targeted recovery for a governed localhost review-ui producer. Requires the full exact live head and a harness from the current default-branch declaration; exhaustively enumerates all check runs, commit statuses, and runs of the declared workflow; refuses pending, successful, failed, or ambiguous rows for the exact governed producer while ignoring unrelated checks; claims one durable head+harness request marker, rejects marker races, then close→reopens the PR and reads both legs back. Prints `requested\\t<sha>\\t<harness>\\tchecks:<n>\\tstatuses:<n>\\truns:<n>`. Exits 1 (bad PR or non-full --sha), 7 (PR absent), 8 (request-marker write/read outcome unknown, or close was not proven closed but a safe-open read-back is confirmed), 9 (request marker read-back mismatch), 10 (unknown harness), 11 (a PR, authority, check, status, workflow-run, or marker-list read failed), 12 (the live head is stale or moved during the event; a moved-during-event answer confirms the reopen), 13 (check/status enumeration is incomplete), 16 (PR not open, declaration absent/malformed, governed check/status/run present in any state, ambiguous current-head evidence, or this head was already requested), 17 (THE CLOSE LANDED AND THE REOPEN IS UNCONFIRMED — the PR may be closed). Example: fabrika ship review-ui-request 7190 --sha d293fe694bfd740475753bad3b00c630a9835122 --harness tuval",
	),
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
		"Post the durable stop-path note on STDIN as a new PR comment, leak-scanned and read back. Prints `noted\\t<comment-url>`. Stop-path notes are a history, not a state: each run's refusal is its own record, and a note on a closed or merged PR is legal. Exits 3 (no body on stdin — a silent stop is the defect), 5 (machine-local path), 6 (bare @ reference), 7 (PR proven absent), 8 (the create or its confirming re-read failed — UNKNOWN whether it landed), 9 (it landed and the read-back does not match), 11 (the PR could not be read — nothing was posted). Example: fabrika ship note 4322 < stop.md",
	),
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
		"Detect a dark ship over the PR itself and queue its linked issue for release. Prints `release\\t<queued|n/a|no-issue>\\t<flag-key|->`. Three ground-truth signals, any one sufficient: the diff adds a flag declaration, the body carries a `Flag:` line, or the body names a key declared in the registry at the base branch inside a gating-context line. The linked issue's inherited `Containment:` stamp is NEVER read — it describes the epic, not this PR. `no-issue` is its own answer, never folded into n/a. Agents deploy, humans release — this ends at the label (ADR 0083). Exits 7 (PR proven absent), 8 (the label write or its re-read failed — escalate), 9 (it landed and the read-back does not show it), 11 (the diff, body, registry or linked issue could not be read — dark-ship-ness is UNKNOWN, never n/a), 13 (the changed-file enumeration is provably short). Example: fabrika ship release 4321",
	),
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
		evidence,
		threads,
		resolve,
		enqueue,
		merge,
		reconcile,
		disarm,
		nudge,
		reviewUiRequest,
		note,
		release,
	]),
	Command.withShortDescription("Drive one pull request down the merge path."),
	Command.withDescription(
		"Everything the merge path needs off one pull request — scope, §CP discharge, the verdict conjunction, head CI, run evidence and review threads — plus the writes that arm, land, watch, disarm and record it",
	),
);
