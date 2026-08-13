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
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runAppendCriterion} from "./append-criterion-verb.ts";
import {runCi} from "./ci-verb.ts";
import {runCriteria} from "./criteria-verb.ts";
import {runDeviations} from "./deviations-verb.ts";
import {runDiff} from "./diff-verb.ts";
import {runPost} from "./post-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runVerdicts} from "./verdicts-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

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
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const prArg = Argument.integer("pr").pipe(
	Argument.withDescription("the pull-request number to read"),
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
	{pr: prArg, sha: boundShaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runScope({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("A PR's artifact classes, head, linked issue and flags."),
	Command.withDescription(
		"Partition a PR's changed files into the code / doc / skill artifact classes and report its head SHA, linked issue and self / harness flags. The file list is read out of the object database at the bound commit, so the printed head and the partitioned files are the same tree. First stdout line is `scoped\\t<head-sha>\\t<fixes:n|part-of:n|->` — the same issue-reference token `ship scope` prints, so a `Part of #N` partial split reads as linked here too. Then one `class\\t<name>\\t<files>` line per present class and the two flag lines; the bound commit and the scanned count are on stderr. Exits 7 (PR absent, closed, or zero changed files — ADR 0092, #4060), 10 (--sha is not a head SHA), 11 (the PR could not be read, or the commit could not be bound — the scope is UNKNOWN), 12 (--sha is not the PR's head — re-scope, never re-bind), 13 (the commit carries fewer files than the PR declares). Example: fabrika review scope 4321 --sha 03135b91",
	),
);

const diff = leafCommand(
	"diff",
	{pr: prArg, sha: boundShaFlag, repo: repoFlag},
	Effect.fn(function* ({pr, sha, repo}) {
		yield* emit(
			yield* runDiff({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Serve a PR's unified diff at the bound commit."),
	Command.withDescription(
		"Serve a PR's unified diff bytes on stdout, read out of the object database at the bound commit and refusing a truncated one rather than passing it through as the whole. Nothing is checked out. No --json: the diff is the object. Exits 7 (PR absent, closed, or zero changed files), 10 (--sha is not a head SHA), 11 (the diff could not be read, or the commit could not be bound — UNKNOWN), 12 (--sha is not the PR's head — re-review, never re-bind), 13 (the diff carries fewer files than the PR declares — #3925's class). Example: fabrika review diff 4321 --sha 03135b91",
	),
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
	Command.withShortDescription("Read an issue's acceptance-criteria block."),
	Command.withDescription(
		"Read an issue's acceptance-criteria block through the registered `acceptance-criteria` wire format — no second parser. First stdout line is `criteria\\t<count>`, then one `<checked|open>\\t<text>` line per criterion. A closed issue is read anyway, with a notice on stderr. Exits 7 (issue absent, or the block is proven absent or malformed — the two are distinguished on stderr, never invented around), 11 (the issue could not be read — whether a block exists is UNKNOWN). Example: fabrika review criteria 4287",
	),
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
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runCi({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Roll up the live check runs at a head, fail-closed."),
	Command.withDescription(
		"Enumerate the live check runs at a head and roll them up green / red / pending, fail-closed on the ambiguous rows — a cancelled or unrecognised conclusion is red, never green. First stdout line is `ci\\t<sha>\\t<rollup>`, then `check\\t<count>` and one `<name>\\t<status>` line per run. Exits 7 (PR or --sha proven absent, or zero check runs declared — ADR 0092), 11 (the enumeration failed — CI state is UNKNOWN, never green), 13 (received fewer runs than declared — #3999). Example: fabrika review ci 4321 --sha 03135b91",
	),
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
		"Sweep every verdict marker on a PR and bind each to the live head as one of three outcomes — current / stale / unbindable, never folded (ADR 0058). First stdout line is `verdicts\\t<live-head>\\t<count>`; a count of 0 is a proven answer. Then one `<namespace>\\t<polarity>\\t<sha>\\t<binding>\\t<comment-id>` line per marker, newest first; a marker that fails the format prints as a `malformed` row rather than being dropped. An unresolvable head prints unbindable on every row. Exits 7 (PR proven absent), 11 (the comment list could not be read — never zero), 13 (the sweep is provably short). Example: fabrika review verdicts 4321",
	),
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
		"Report the PR body's `## Deviations` state — found | none-declared | absent | malformed, three distinct facts — with its entries and the Tier-M token scan over the diff at the bound commit. First stdout line is `deviations\\t<state>`, then one `entry\\t<class-label-or-->\\t<first-line-of-Said>` line per entry and one `tier-m\\t<kind>\\t<file>:<line>\\t<token>` line per hit. Exits 7 (PR proven absent), 10 (--sha is not a head SHA), 11 (the body or diff could not be read, or the commit could not be bound — the disclosure state is UNKNOWN, never `none`), 12 (--sha is not the PR's head — re-scope, never re-bind), 13 (a partial diff must not print a partial scan beside a disclosure claim). Example: fabrika review deviations 4321 --sha 03135b91",
	),
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
			Argument.withDescription("the pull request the verdict is posted on"),
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
			Flag.withDescription("the head the reviewer actually inspected (7–40 lowercase hex)"),
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
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, namespace, polarity, sha, clause, carrier, repo, json}) {
		yield* emit(
			yield* runPost({
				pr,
				namespace,
				polarity,
				sha,
				clause,
				carrier,
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
		'Post the verdict on STDIN as ONE comment for this namespace — re-resolve the live head, recompute the class set at the bound commit, compose the first line through the `verdict-marker` wire format, leak-scan the assembled comment, upsert, and read it back from live state. Prints `posted\\t<namespace>\\t<polarity>\\t<sha>\\t<content>\\t<created|edited>\\t<comment-url>`, where `<content>` is the content digest the verdict binds (ADR 0276). Exits 3 (empty stdin — an empty verdict reads as UNGATED), 5 (machine-local path in the assembled comment), 6 (bare @ reference), 7 (PR absent or closed), 8 (the create/edit failed — UNKNOWN), 9 (read-back does not yield this marker), 10 (namespace this diff did not derive, bad polarity, or advisory with FAIL), 11 (a precondition read failed, or the commit could not be bound — nothing was posted), 12 (the live head moved past --sha — re-review, never re-bind). Example: fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --clause "guide matches shipped behavior" < verdict.md',
	),
);

/** The criterion text arrives on **stdin**, for the same reason `post`'s body does. */
const appendCriterion = leafCommand(
	"append-criterion",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the linked issue receiving the criterion"),
		),
		pr: Flag.integer("pr").pipe(
			Flag.withDescription(
				"the PR whose review round produced the finding — half the provenance tag",
			),
		),
		round: Flag.integer("round").pipe(
			Flag.withDescription(
				"this review round's number; at or past the freeze (3) the verb escalates instead of appending",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, pr, round, repo, json}) {
		yield* emit(
			yield* runAppendCriterion({
				issue,
				pr,
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
		"Append one reviewer-authored acceptance criterion from STDIN under ADR 0079's four fences — ACL-gated fail-closed, append-only, provenance-tagged, frozen at round 3. Prints `appended\\t<issue>\\t<rows-after>`, or `escalated-frozen\\t<issue>\\t<round>` at the freeze; both are proven answers at exit 0. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (issue absent or closed, or no conforming acceptance-criteria block), 8 (the PATCH or the escalation comment failed — UNKNOWN), 9 (read-back does not show the prior rows plus this one), 11 (a precondition read failed), 14 (token below write or the ACL lookup failed — ADR 0055), 15 (the write would drop or mutate an existing row). Example: printf 'a regression test covers qty > 1' | fabrika review append-criterion 4287 --pr 4321 --round 1",
	),
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
		post,
		appendCriterion,
	]),
	Command.withShortDescription("Read what a text review needs off one pull request."),
	Command.withDescription(
		"Read everything a text review needs off one pull request — scope, diff, criteria, CI, verdicts, deviations — and emit the verdict or a reviewer-authored criterion through the one sanctioned write path",
	),
);
