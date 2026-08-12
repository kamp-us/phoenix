/**
 * The `governance` verb group — `fabrika governance <scope|sweep|guards|base|post|digest|readout>`,
 * the `governance` skill's machine half.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), reads the one machine fact this group does not derive — the wall
 * clock — runs the pure verb, and emits its outcome. Every decision lives in the `*-verb.ts` modules
 * beside it, which is what makes each refusal testable without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **`--polarity` is declared as a string and checked in the verb.** The check is the closed set's, and
 * seating it in the verb is what lets the refusal name the whole vocabulary and seat it on `10` rather
 * than emit the parser's generic message.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runBase} from "./base-verb.ts";
import {runDigest} from "./digest-verb.ts";
import {runGuards} from "./guards-verb.ts";
import {runPost} from "./post-verb.ts";
import {runReadout} from "./readout-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runSweep} from "./sweep-verb.ts";

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

const shaFlag = Flag.string("sha").pipe(
	Flag.optional,
	Flag.withDescription(
		"the head to read at; must be the PR's head, or the verb refuses on 12 rather than judging a tree the PR moved past",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the result object on stdout instead of the line grammar"),
);

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".decisions"),
	Flag.withDescription("the decision-record corpus to read"),
);

const prArgument = Argument.integer("pr").pipe(Argument.withDescription("the pull-request number"));

const scope = leafCommand(
	"scope",
	{pr: prArgument, sha: shaFlag, repo: repoFlag, json: jsonFlag},
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
	Command.withShortDescription("Whether this PR's diff requires the governance namespace."),
	Command.withDescription(
		"Derive whether this PR's diff requires the governance namespace, over which of the four harness roots, at the bound head. Prints `governance\\t<required|not-required>\\t<head>`, then a `root` line per touched root, `self`, and a `record` line per decision record in the diff. This is NOT a §CP classification — §CP is CODEOWNERS' answer, and the verb says so on stderr every run. Exits 7 (the PR is absent, closed, or has zero changed files), 10 (--sha is not a head SHA), 11 (the PR or the commit binding could not be read — the derivation is UNKNOWN, never not-required), 12 (--sha is not the PR's head), 13 (the changed-file enumeration is provably short). Example: fabrika governance scope 4321",
	),
);

const sweep = leafCommand(
	"sweep",
	{
		pr: Argument.integer("pr").pipe(
			Argument.optional,
			Argument.withDescription(
				"the pull-request the subject record lives in; required unless --landed is given",
			),
		),
		record: Flag.string("record").pipe(
			Flag.optional,
			Flag.withDescription("the four-digit id of the decision record in that PR to sweep"),
		),
		landed: Flag.string("landed").pipe(
			Flag.optional,
			Flag.withDescription(
				"sweep a record already in --dir instead of one in a PR — the digest-time mode; never combined with the positional",
			),
		),
		sha: shaFlag,
		dir: dirFlag,
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(8),
			Flag.withDescription("the maximum shortlist entries"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, record, landed, sha, dir, limit, repo, json}) {
		yield* emit(
			yield* runSweep({
				pr: Option.getOrNull(pr),
				record: Option.getOrNull(record),
				landed: Option.getOrNull(landed),
				sha: Option.getOrNull(sha),
				dir,
				limit,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Rank the live records whose domain this subject touches."),
	Command.withDescription(
		"Rank the uncited live-accepted records whose decision domain the subject touches, reading the subject out of a bound commit or out of the corpus. All three outcomes — shortlist, no-overlap, indeterminate — exit 0 and none of them is a clearance. Exits 7 (--dir holds zero records, or the PR is absent or closed), 10 (a non-four-digit id, a --sha that is not a head SHA, a negative --limit, or both a PR and --landed), 11 (the subject or a corpus member could not be read — an incomplete corpus is UNKNOWN), 12 (--sha is not the PR's head), 13 (the changed-file list proving the record is in this PR is provably short). Example: fabrika governance sweep 4321 --record 0240",
	),
);

const guards = leafCommand(
	"guards",
	{pr: prArgument, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runGuards({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The anchored invariants this diff removes or modifies."),
	Command.withDescription(
		"Scan the bound diff for anchored invariants it removes or modifies, and report the guard-bearing files it touches. Prints `guards\\t<hits|no-anchor-change|no-anchors-in-reach>\\t<anchors-in-reach>` then an `anchor` line per hit and a `guard-file` line per touched guard-bearing file. no-anchors-in-reach is the scan reporting its own silence, never a clearance. Exits 7 (the PR is absent, closed, or empty), 10 (--sha is not a head SHA), 11 (the diff could not be read — UNKNOWN, never no-anchor-change), 12 (--sha is not the PR's head), 13 (the diff is provably incomplete). Example: fabrika governance guards 4321",
	),
);

const base = leafCommand(
	"base",
	{
		pr: prArgument,
		path: Flag.string("path").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a repo-relative path inside this skill's own resolved directory to read at the merge base; repeatable, defaults to SKILL.md and contract.md",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, path, repo}) {
		yield* emit(yield* runBase({pr, path, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("This skill's own text at a PR's merge base."),
	Command.withDescription(
		"Read this skill's own text at the merge base of a PR that edits it — the self fence's bytes, as a pasteable literal. Prints `base\\t<merge-base>\\t<file-count>` then a `file\\t<path>\\t<byte-count>` header and that file's bytes per path; the byte count is the delimiter, there is no separator line. Exits 7 (the PR is absent or closed, the skill root resolved to zero matches, or every --path is absent at the merge base), 10 (a --path outside the resolved skill root), 11 (the merge base or a path could not be read, or the skill root resolved to more than one candidate), 12 (the head moved while the base was being resolved). Example: fabrika governance base 4321",
	),
);

const post = leafCommand(
	"post",
	{
		pr: prArgument,
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity"),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription("the head the reviewer actually inspected (7-40 lowercase hex)"),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the human clause; blank is not a clause"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, polarity, sha, clause, repo, json}) {
		yield* emit(
			yield* runPost({
				pr,
				polarity,
				sha,
				clause,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the governance verdict on stdin as one comment."),
	Command.withDescription(
		'Post the governance verdict read from STDIN: compose through the verdict-marker format, re-resolve the head, re-derive the namespace at the bound commit, leak-scan, upsert one comment, read it back. The namespace is fixed — there is no --namespace, so this verb cannot be aimed at another gate\'s. Prints `posted\\tgovernance\\t<polarity>\\t<sha>\\t<created|edited>\\t<url>`. Exits 3 (stdin held nothing), 5/6 (a machine-local path, a bare @ reference), 7 (the PR is absent or closed), 8/9 (the write was unproven, the read-back differs), 10 (a bad --polarity, --sha or blank --clause), 11 (a precondition read failed — nothing was posted), 12 (the head moved past --sha), 14 (the diff derives no governance namespace). Example: fabrika governance post 4321 --polarity PASS --sha 03135b91 --clause "no contradiction, no weakening" < verdict.md',
	),
);

const digest = leafCommand(
	"digest",
	{
		since: Flag.string("since").pipe(
			Flag.withDescription("the window's inclusive start, YYYY-MM-DD"),
		),
		until: Flag.string("until").pipe(
			Flag.optional,
			Flag.withDescription("the window's inclusive end, YYYY-MM-DD; defaults to today"),
		),
		dir: dirFlag,
		base: Flag.string("base").pipe(
			Flag.withDefault("origin/main"),
			Flag.withDescription("the ref whose history is walked; fetched before the walk"),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({since, until, dir, base: ref, json}) {
		yield* emit(
			yield* runDigest({
				since,
				until: Option.getOrNull(until),
				dir,
				base: ref,
				json,
				now: Effect.sync(() => Date.now()),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The decision records that landed in a window."),
	Command.withDescription(
		"List the decision records that landed in a window, each with its status as written, its landing commit, and that commit's anchor delta. `none` is a PROVEN answer at exit 0 — the window was walked and nothing landed. This verb ranks nothing: tension and blast radius are judgment. Exits 7 (--dir is absent or holds zero records), 10 (a malformed date, or --until before --since), 11 (--base could not be fetched or a landing commit could not be read — UNKNOWN, never none), 13 (a shallow clone whose graft boundary falls inside the window). Example: fabrika governance digest --since 2026-08-02",
	),
);

const readout = leafCommand(
	"readout",
	{
		issue: Argument.integer("issue").pipe(
			Argument.optional,
			Argument.withDescription(
				'the durable readout artifact\'s issue number; resolved from $FABRIKA_GOVERNANCE_READOUT_ISSUE, else the single open issue titled "Governance readout", when omitted',
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(
			yield* runReadout({
				issue: Option.getOrNull(issue),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Publish the ranked rows on stdin to the durable readout."),
	Command.withDescription(
		"Publish the ranked rows read from STDIN onto the durable readout artifact: compose through the governance-digest format, leak-scan, upsert the one comment, read it back in order. It gates nothing — there is no outcome here meaning the corpus is in a bad state. Prints `readout\\t<issue>\\t<rows>\\t<created|edited>\\t<url>`. Exits 3 (stdin held nothing), 5/6 (a machine-local path, a bare @ reference), 7 (the artifact is absent, closed, or unresolvable), 8/9 (the write was unproven, the read-back differs), 10 (a row's kind or id is off the vocabulary), 11 (the issue or its comments could not be read — nothing was written), 13 (the comment enumeration is provably short). Example: printf 'row\\t0240\\troutine\\tno tension found\\n' | fabrika governance readout 4952",
	),
);

export const governanceCommand = Command.make("governance").pipe(
	Command.withSubcommands([scope, sweep, guards, base, post, digest, readout]),
	Command.withShortDescription("Keep the governance corpus honest across a diff."),
	Command.withDescription(
		"Keep the governance corpus honest: derive the namespace a diff requires, rank the records it may contradict, scan the anchored invariants it moves, read this skill's own text at the merge base, emit the one verdict, and publish the periodic non-blocking readout",
	),
);
