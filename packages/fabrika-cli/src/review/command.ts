/**
 * The `review` verb group — `fabrika review <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {refuse} from "../verb.ts";
import {runAppendCriterion} from "./append-criterion-verb.ts";
import {runCi} from "./ci-verb.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {runCriteria} from "./criteria-verb.ts";
import {runDeviations} from "./deviations-verb.ts";
import {runDiff} from "./diff-verb.ts";
import type {FilterPlacement} from "./filter-spike.ts";
import {runPost} from "./post-verb.ts";
import {runPreview} from "./preview-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runScratch} from "./scratch-verb.ts";
import {runSeat} from "./seat-verb.ts";
import {runVerdicts} from "./verdicts-verb.ts";

/**
 * The two flags every verb in this group shares, declared once here.
 *
 * They are not imported from a sibling group's adapter: that would couple two groups' `--help` text
 * together. The wording is shared because the contract states it, not because the declaration is.
 */
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
	Argument.withDescription("the pull-request number to read"),
);

const filterPlacementFlag = Flag.string("filter-placement").pipe(
	Flag.optional,
	Flag.withDescription(
		"review diff filtering: use `after` to omit content while retaining every required review; omitted, no filtering runs",
	),
);

const excludeFlag = Flag.string("exclude").pipe(
	Flag.optional,
	Flag.withDescription(
		"review diff filtering: comma-separated extra exclusion globs beyond the defaults; refused at 21 when one intersects a governed root",
	),
);

/** Omitted filtering and the supported placement are distinct inputs. */
const placementOf = (
	verb: string,
	value: string | null,
): FilterPlacement | null | ReturnType<typeof refuse> =>
	value === null || value === "after"
		? value
		: refuse(
				OFF_VOCABULARY,
				`review ${verb}: --filter-placement must be \`after\`, got "${value}"`,
			);

/**
 * The read verbs' `--sha`: the head the caller scoped, asserted so the answer's provenance is the
 * caller's claim and not whatever the endpoint happened to serve. Omitted, the verb binds to the
 * PR's live head — which is still read out of the object database, so the answer names its commit
 * either way.
 */
const boundShaFlag = Flag.string("sha").pipe(
	Flag.optional,
	Flag.withDescription(
		"the head to read the artifact at (default: the PR's live head); the verb reads it out of the object database and refuses when it is not the PR's head",
	),
);

const scope = leafCommand(
	"scope",
	{
		pr: prArg,
		sha: boundShaFlag,
		repo: repoFlag,
		json: jsonFlag,
		filterPlacement: filterPlacementFlag,
		exclude: excludeFlag,
	},
	Effect.fn(function* ({pr, sha, repo, json, filterPlacement, exclude}) {
		const placement = placementOf("scope", Option.getOrNull(filterPlacement));
		if (placement && typeof placement === "object") {
			yield* emit(placement);
			return;
		}
		yield* emit(
			yield* runScope({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				filterPlacement: placement,
				exclude: Option.getOrNull(exclude),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("A PR's artifact classes, head, issue, flags and governance need."),
	Command.withDescription(
		[
			"Prints `scoped\\t<head>\\t<issue-ref>`, then class, namespace, flag and governance lines for a PR.",
			"  7: PR absent, closed, or zero changed files",
			"  10: --sha is not a head SHA, or --filter-placement is not `after`",
			"  11: a read or the commit binding failed (UNKNOWN)",
			"  12: --sha is not the PR's head; re-scope, never re-bind",
			"  13: the commit carries fewer files than the PR declares",
			"  21: an exclusion pattern intersects a governed root",
			'  Derivation: the review skill\'s contract.md, "review scope"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review scope 4321 --sha 03135b91",
			description: "Scope a PR at the head under review",
		},
	]),
);

const diff = leafCommand(
	"diff",
	{
		pr: prArg,
		sha: boundShaFlag,
		repo: repoFlag,
		filterPlacement: filterPlacementFlag,
		exclude: excludeFlag,
	},
	Effect.fn(function* ({pr, sha, repo, filterPlacement, exclude}) {
		const placement = placementOf("diff", Option.getOrNull(filterPlacement));
		if (placement && typeof placement === "object") {
			yield* emit(placement);
			return;
		}
		yield* emit(
			yield* runDiff({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				filterPlacement: placement,
				exclude: Option.getOrNull(exclude),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Serve a PR's unified diff at the bound commit."),
	Command.withDescription(
		[
			"Prints a PR's unified diff bytes, read at the bound commit with nothing checked out.",
			"  7: PR absent, closed, or zero changed files",
			"  10: --sha is not a head SHA, or --filter-placement is not `after`",
			"  11: the diff read or the commit binding failed (UNKNOWN)",
			"  12: --sha is not the PR's head; re-review, never re-bind",
			"  13: the diff carries fewer files than the PR declares",
			"  21: an exclusion pattern intersects a governed root",
			'  Derivation: the review skill\'s contract.md, "review diff"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review diff 4321 --sha 03135b91",
			description: "Serve a PR's diff at the head under review",
		},
	]),
);

const criteria = leafCommand(
	"criteria",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the issue carrying the acceptance-criteria block"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(yield* runCriteria({issue, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription(
		"Read the graded set: an issue's criteria plus its standing rulings.",
	),
	Command.withDescription(
		[
			"Prints `criteria\\t<n>` and `rulings\\t<n>`, then one row per criterion and standing ruling.",
			"  Row: `<body|ruling>\\t<open|checked|superseded>\\t<text>[\\t<evidence|ruling-url>]`",
			"  7: issue absent, or its criteria block is absent or malformed",
			"  11: the issue, roster or comments could not be read (UNKNOWN)",
			'  Derivation: the review skill\'s contract.md, "review criteria"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika review criteria 4287", description: "Read the set an issue's review grades"},
	]),
);

const ci = leafCommand(
	"ci",
	{
		pr: prArg,
		sha: Flag.string("sha").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head to enumerate check runs at (default: the PR's live head); give the inspected head so the answer binds to what is being judged",
			),
		),
		wait: Flag.boolean("wait").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"poll a `pending` head until CI concludes or the budget expires, and prepend `settle\\t<settled|budget-exhausted|head-moved|governance-owed|governance-stale>`",
			),
		),
		budgetSeconds: Flag.integer("budget-seconds").pipe(
			Flag.withDefault(600),
			Flag.withDescription("--wait only: total wall-clock budget, gh-call latency included"),
		),
		cadenceSeconds: Flag.integer("cadence-seconds").pipe(
			Flag.withDefault(30),
			Flag.withDescription("--wait only: sleep between polls"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, wait, budgetSeconds, cadenceSeconds, repo, json}) {
		yield* emit(
			yield* runCi({
				pr,
				sha: Option.getOrNull(sha),
				wait,
				budgetSeconds,
				cadenceSeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				cwd: process.cwd(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Roll up a head's check runs, fail-closed; --wait waits out a pending.",
	),
	Command.withDescription(
		[
			"Prints `ci\\t<sha>\\t<rollup>`, then run and check tallies for a head's blocking check runs.",
			"  Rollup: green, red, pending or no-producer; never green on an ambiguous run",
			"  7: PR or --sha absent, zero check runs declared, or zero repo-authored workflows",
			"  11: a CI, workflow, required-set or config read failed (UNKNOWN)",
			"  13: fewer runs than declared, or the ruleset walk did not finish",
			"  16: no workflow this repo authors inspected the head",
			'  Derivation: the review skill\'s contract.md, "review ci"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review ci 4321 --sha 03135b91",
			description: "Roll up CI at the head under review",
		},
		{
			command: "fabrika review ci 4321 --sha 03135b91 --wait",
			description: "Wait out a pending head within the budget",
		},
	]),
);

const verdicts = leafCommand(
	"verdicts",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(yield* runVerdicts({pr, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Every verdict marker on a PR, bound to the live head."),
	Command.withDescription(
		[
			"Prints `verdicts\\t<live-head>\\t<count>`, then one row per verdict marker on a PR, newest first.",
			"  Row: `<namespace>\\t<polarity>\\t<sha>\\t<binding>\\t<comment-id>\\t<standing|superseded>`",
			"  Binding: current, stale or unbindable; a marker failing the format prints `malformed`",
			"  7: PR proven absent",
			"  11: the comment list could not be read, never zero",
			"  13: the sweep is provably short",
			'  Derivation: the review skill\'s contract.md, "review verdicts"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika review verdicts 4321", description: "Sweep every verdict marker on a PR"},
	]),
);

const deviations = leafCommand(
	"deviations",
	{pr: prArg, sha: boundShaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runDeviations({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The PR body's Deviations state, entries and token scan."),
	Command.withDescription(
		[
			"Prints `deviations\\t<state>`, then entry and Tier-M rows for a PR body's Deviations section.",
			"  State: found, none-declared, absent or malformed",
			"  Rows: `entry\\t<class|->\\t<Said>`, `tier-m\\t<kind>\\t<file>:<line>\\t<token>`",
			"  7: PR proven absent",
			"  10: --sha is not a head SHA",
			"  11: the body, diff or commit binding failed (UNKNOWN, never `none`)",
			"  12: --sha is not the PR's head; re-scope, never re-bind",
			"  13: the diff is provably short",
			'  Derivation: the review skill\'s contract.md, "review deviations"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review deviations 4321 --sha 03135b91",
			description: "Read the disclosure at the head under review",
		},
	]),
);

/**
 * The verdict body arrives on **stdin only** — no `--body`, no `--body-file`. A flag that takes a
 * path turns the body into a string the verb could post verbatim, which is how a machine-local path
 * reaches a public surface while the poster reads success.
 */
const post = leafCommand(
	"post",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription(
				"the pull request the verdict is posted on — with --base/--tip, the child issue instead",
			),
		),
		namespace: Flag.string("namespace").pipe(
			Flag.withDescription(
				"the namespace this verdict fills; must be one this PR's own diff derived",
			),
		),
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity"),
		),
		sha: Flag.string("sha").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head the reviewer actually inspected (7–40 lowercase hex); required unless --base/--tip scope the verdict to a range",
			),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the human clause the marker ends with; blank is not a clause"),
		),
		carrier: Flag.string("carrier").pipe(
			Flag.withDefault("marker"),
			Flag.withDescription(
				"marker (first-line SHA-bound marker) or advisory (§CP: advisory first line, `Reviewed-head: @ <sha>` in the body); advisory is a PASS path only (default: marker)",
			),
		),
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription(
				"with --tip: post a range-scoped verdict over <base>..<tip> on the child issue named by the positional; never combined with --sha",
			),
		),
		tip: Flag.string("tip").pipe(
			Flag.optional,
			Flag.withDescription("the range's tip revision — the other half of --base"),
		),
		supersede: Flag.boolean("supersede").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"acknowledge that this verdict retires a standing one of the OPPOSITE polarity at the same head, or ranged, over the same range; without it that post is refused at 17",
			),
		),
		round: Flag.integer("round").pipe(
			Flag.optional,
			Flag.withDescription(
				"which review round this verdict ends — the same number `review append-criterion --round` was handed; required on a PASS, where a criterion this round appended is refused at 18",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		pr,
		namespace,
		polarity,
		sha,
		clause,
		carrier,
		base,
		tip,
		supersede,
		round,
		repo,
		json,
	}) {
		yield* emit(
			yield* runPost({
				pr,
				namespace,
				polarity,
				sha: Option.getOrNull(sha),
				clause,
				carrier,
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				supersede,
				round: Option.getOrNull(round),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: Effect.sync(() => Date.now()),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the verdict on stdin as this namespace's one comment."),
	Command.withDescription(
		[
			"Posts the stdin verdict as its namespace's one comment and prints one `posted` line.",
			"  3: empty stdin",
			"  5: machine-local path",
			"  6: bare @ reference",
			"  7: PR, or ranged issue, absent or closed",
			"  8: write failed (UNKNOWN)",
			"  9: read-back mismatch",
			"  10: off-vocabulary input, or --round missing on a PASS",
			"  11: a precondition read failed",
			"  12: the live head moved past --sha",
			"  17: would retire an opposite verdict without --supersede",
			"  18: PASS after this round appended a criterion",
			"  19: PASS names no evidence for a marked criterion",
			'  Derivation: the review skill\'s contract.md, "review post"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --round 1 --clause "guide matches shipped behavior" < verdict.md',
			description: "Post a head-bound PASS",
		},
		{
			command:
				'fabrika review post 5830 --namespace review --polarity PASS --base 9f2c1ab --tip 03135b9 --round 1 --clause "every criterion met" < verdict.md',
			description: "Post a range-scoped PASS on an epic child",
		},
	]),
);

/** The criterion text arrives on **stdin**, for the same reason `post`'s body does. */
const appendCriterion = leafCommand(
	"append-criterion",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the linked issue receiving the criterion"),
		),
		pr: Flag.integer("pr").pipe(
			Flag.optional,
			Flag.withDescription(
				"the PR whose review round produced the finding — half the provenance tag; required unless --base/--tip name an epic child's range instead",
			),
		),
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription(
				"with --tip: the range <base>..<tip> the round was judged over, standing in for --pr on an epic child that has no PR; never combined with --pr",
			),
		),
		tip: Flag.string("tip").pipe(
			Flag.optional,
			Flag.withDescription("the range's tip revision — the other half of --base"),
		),
		round: Flag.integer("round").pipe(
			Flag.withDescription(
				`this review round's number; at or past the freeze (${CAP_ROUND}) the verb escalates instead of appending`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, pr, base, tip, round, repo, json}) {
		yield* emit(
			yield* runAppendCriterion({
				issue,
				pr: Option.getOrNull(pr),
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				round,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append one reviewer-authored acceptance criterion."),
	Command.withDescription(
		[
			"Appends one reviewer-authored criterion from stdin; prints `appended` or `escalated-frozen`.",
			"  3: empty stdin",
			"  5: machine-local path",
			"  6: bare @ reference",
			"  7: issue absent, closed, or without a criteria block",
			"  8: the PATCH or escalation comment failed (UNKNOWN)",
			"  9: read-back mismatch",
			"  10: no subject, two subjects, or a bad range end",
			"  11: a precondition read failed",
			"  14: token below write, or the ACL lookup failed",
			"  15: not provably the prior rows plus one",
			'  Derivation: the review skill\'s contract.md, "review append-criterion"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"printf 'a regression test covers qty > 1' | fabrika review append-criterion 4287 --pr 4321 --round 1",
			description: "Append a criterion found on a PR",
		},
		{
			command:
				"printf 'a regression test covers qty > 1' | fabrika review append-criterion 6095 --base 9f2c1ab --tip 03135b9 --round 1",
			description: "Append a criterion found over an epic child's range",
		},
	]),
);

const scratch = leafCommand(
	"scratch",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription("the pull request this lane is reviewing"),
		),
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, no path separators"),
		),
		lane: Flag.string("lane").pipe(
			Flag.withDescription(
				"the lane key from this reviewer's spawn brief — what tells two reviewers of ONE session apart",
			),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription(
				"the head `review scope` bound (7–40 hex) — what tells two review ROUNDS of one lane apart",
			),
		),
	},
	Effect.fn(function* ({pr, slug, lane, sha}) {
		yield* emit(yield* runScratch({pr, slug, lane, sha, env: process.env, tmpRoot: tmpdir()}));
	}),
).pipe(
	Command.withShortDescription("The per-lane scratch path a reviewer's staged files go under."),
	Command.withDescription(
		[
			"Prints one absolute per-lane scratch path for a review file, creating its directory.",
			"  Path: <temp root>/fabrika-review/<session-id>/<pr>-<lane-nonce>/<slug>",
			"  Session id: $FABRIKA_SESSION_ID, else $CLAUDE_CODE_SESSION_ID, else $PI_SUBAGENT_PARENT_SESSION",
			"  10: --slug is not a kebab-case leaf, or --sha is not a head SHA",
			'  Derivation: the review skill\'s contract.md, "review scratch"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review scratch 4321 --slug diff --lane 4287 --sha 03135b91",
			description: "Allocate the path a staged diff goes under",
		},
	]),
);

const seat = leafCommand(
	"seat",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the epic child whose range this shell was briefed on"),
		),
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription("the range's base revision, exactly as the brief's `range` prints it"),
		),
		tip: Flag.string("tip").pipe(
			Flag.optional,
			Flag.withDescription("the range's tip revision — the commit this tree is seated at"),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, base, tip, json}) {
		yield* emit(
			yield* runSeat({
				issue,
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				json,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Seat this worktree at an epic child's range tip, or refuse."),
	Command.withDescription(
		[
			"Checks this worktree out, detached, at an epic child's range tip and prints one `seated` line.",
			"  Prints `seated\\t<head>\\t<branch>\\t<checked-out|already-seated>`",
			"  8: the checkout failed (UNKNOWN)",
			"  9: HEAD reads another commit after the checkout",
			"  10: a lone --base/--tip, neither, or a bad revision",
			"  11: a git read the answer turns on failed",
			"  20: no lane branch of this child here carries the tip",
			'  Derivation: the review skill\'s contract.md, "review seat"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review seat 8820 --base 99b1453 --tip 4011b1d",
			description: "Seat a reviewer at an epic child's range tip",
		},
	]),
);

const preview = leafCommand(
	"preview",
	{
		diffFile: Flag.string("diff-file").pipe(
			Flag.optional,
			Flag.withDescription(
				"a unified diff on local disk to extract paths from (no PR, no network, no LLM)",
			),
		),
		pr: Argument.integer("pr").pipe(
			Argument.optional,
			Argument.withDescription("the pull-request number to read instead of --diff-file"),
		),
		sha: boundShaFlag,
		repo: repoFlag,
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription(
				"a range's base revision — reads the range's diff from its merge base, beside --tip",
			),
		),
		tip: Flag.string("tip").pipe(
			Flag.optional,
			Flag.withDescription("the range's tip revision; --base and --tip come together"),
		),
		filterPlacement: filterPlacementFlag,
		exclude: excludeFlag,
		emitDiff: Flag.boolean("emit-diff").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"print the filtered diff (header + kept sections) instead of the preview rows",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({
		diffFile,
		pr,
		sha,
		repo,
		base,
		tip,
		filterPlacement,
		exclude,
		emitDiff,
		json,
	}) {
		const placement = placementOf("preview", Option.getOrNull(filterPlacement));
		if (placement && typeof placement === "object") {
			yield* emit(placement);
			return;
		}
		yield* emit(
			yield* runPreview({
				diffFile: Option.getOrNull(diffFile),
				pr: Option.getOrNull(pr),
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				filterPlacement: placement,
				exclude: Option.getOrNull(exclude),
				emitDiff,
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Filtered path extraction for review diffs — no LLM, no write."),
	Command.withDescription(
		[
			"Prints one diff's filtered paths, classes and namespaces, with no LLM and no network write.",
			"  Subject: exactly one of --diff-file, a PR number, or --base with --tip",
			"  7: PR absent, closed, or zero changed files",
			"  10: bad --filter-placement, --emit-diff with --json, or not one subject",
			"  11: a read the answer turns on failed",
			"  12: --sha is not the PR's head",
			"  13: a provably short diff",
			"  21: an exclusion pattern intersects a governed root",
			'  Derivation: the review skill\'s contract.md, "review preview"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review preview --diff-file pr.diff --filter-placement=after --json",
			description: "Preview filtering over a local diff",
		},
	]),
);

export const reviewCommand = Command.make("review").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		scope,
		diff,
		criteria,
		ci,
		verdicts,
		deviations,
		preview,
		post,
		appendCriterion,
		scratch,
		seat,
	]),
	Command.withShortDescription("Read what a text review needs off one pull request."),
	Command.withDescription(
		"Read everything a text review needs off one pull request — scope, diff, criteria, CI, verdicts, deviations — allocate the per-lane scratch path its staged reads go under, seat an epic child's reviewer at the range tip it judges, and emit the verdict or a reviewer-authored criterion through the one sanctioned write path",
	),
);
