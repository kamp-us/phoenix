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

import {Effect, type FileSystem, Option, type Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {corpusOverride, decisionsDirOr} from "../config/paths.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {runBase} from "./base-verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDigest} from "./digest-verb.ts";
import {runGuards} from "./guards-verb.ts";
import {runPost} from "./post-verb.ts";
import {runReadout} from "./readout-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runSweep} from "./sweep-verb.ts";

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
	Flag.withDefault(false),
	Flag.withDescription("emit the result object on stdout instead of the line grammar"),
);

const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the decision-record corpus to read (default: `decisionsDir` in .fabrika.jsonc, itself defaulting to .decisions)",
	),
);

/**
 * The corpus the two contradiction-half verbs read, or the refusal that ends the run.
 *
 * A repo that declines `decisionsDir` keeps no decision corpus, so there is no contradiction check
 * to run over it — and this half must never answer `no-overlap` there, because that word reads as
 * "checked, nothing found". The verdict such a repo can still earn comes from
 * `governance guards`, the weakens-a-guard half, which reads no corpus at all; the refusal says so.
 */
const corpusFor = (
	verb: string,
	declared: Option.Option<string>,
): Effect.Effect<
	| {readonly _tag: "Dir"; readonly dir: string}
	| {readonly _tag: "Stop"; readonly outcome: VerbOutcome},
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const read = yield* decisionsDirOr(
			verb,
			process.cwd(),
			corpusOverride("--dir", Option.getOrNull(declared)),
			"there is no contradiction check to run and this verb will not answer no-overlap over a corpus that does not exist — `governance guards`, the weakens-a-guard half, is the whole of what this repo's governance run can derive.",
		);
		switch (read._tag) {
			case "Dir":
				return {_tag: "Dir" as const, dir: read.dir};
			case "Declined":
				return {_tag: "Stop" as const, outcome: refuse(ZERO_SCOPE, read.message)};
			case "Refused":
				return {_tag: "Stop" as const, outcome: refuse(PRECONDITION_UNKNOWN, read.message)};
		}
	});

const prArgument = Argument.integer("pr").pipe(Argument.withDescription("the pull-request number"));

/**
 * The positional the two read verbs take, optional because a range names its own subject: an epic
 * child has no pull request to give, and requiring a number there would mean inventing one.
 */
const subjectArgument = Argument.integer("pr").pipe(
	Argument.optional,
	Argument.withDescription("the pull-request number; omitted when --base/--tip scope a range"),
);

const rangeBaseFlag = Flag.string("base").pipe(
	Flag.optional,
	Flag.withDescription(
		"with --tip: read a range <base>..<tip> instead of a pull request — the epic-child form, which takes no positional",
	),
);

const rangeTipFlag = Flag.string("tip").pipe(
	Flag.optional,
	Flag.withDescription("the range's tip revision — the other half of --base"),
);

const scope = leafCommand(
	"scope",
	{
		pr: subjectArgument,
		sha: shaFlag,
		base: rangeBaseFlag,
		tip: rangeTipFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, base, tip, repo, json}) {
		yield* emit(
			yield* runScope({
				pr: Option.getOrNull(pr),
				sha: Option.getOrNull(sha),
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether a diff requires the governance namespace."),
	Command.withDescription(
		[
			"Prints `governance\\t<required|not-required>\\t<head>`, then root, self and record lines.",
			"  7: the PR or range is absent, closed or changes no path",
			"  10: a malformed --sha, range or subject",
			"  11: a read failed; the requirement is UNKNOWN",
			"  12: --sha is not the PR's head",
			"  13: the range's file list is provably short",
			'  Derivation: the governance skill\'s contract.md, "governance scope"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika governance scope 4321"},
		{command: "fabrika governance scope --base 9f2c1ab --tip 03135b9"},
	]),
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
		const corpus = yield* corpusFor("governance sweep", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(
			yield* runSweep({
				pr: Option.getOrNull(pr),
				record: Option.getOrNull(record),
				landed: Option.getOrNull(landed),
				sha: Option.getOrNull(sha),
				dir: corpus.dir,
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
		[
			"Prints shortlist, no-overlap or indeterminate (none a clearance), then a line per ranked record.",
			"  7: the corpus holds no record, or the PR is absent, closed or empty",
			"  10: a malformed id, --sha or --limit, or a PR beside --landed",
			"  11: a read failed; an incomplete corpus is UNKNOWN",
			"  12: --sha is not the PR's head",
			'  Derivation: the governance skill\'s contract.md, "governance sweep"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika governance sweep 4321 --record 0240"},
		{command: "fabrika governance sweep --landed 0240"},
	]),
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
		[
			"Prints `guards\\t<hits|no-anchor-change|no-anchors-in-reach>\\t<n>`, then anchor and guard lines.",
			"  7: the PR is absent or closed, or changes no path",
			"  10: --sha is not a head SHA",
			"  11: the diff could not be read (UNKNOWN)",
			"  12: --sha is not the PR's head",
			"  13: the served diff is provably short",
			'  Derivation: the governance skill\'s contract.md, "governance guards"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika governance guards 4321"}]),
);

const base = leafCommand(
	"base",
	{
		pr: subjectArgument,
		path: Flag.string("path").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a repo-relative path inside this skill's own resolved directory to read at the merge base; repeatable, defaults to SKILL.md and contract.md",
			),
		),
		base: rangeBaseFlag,
		tip: rangeTipFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, path, base: rangeBase, tip, repo}) {
		yield* emit(
			yield* runBase({
				pr: Option.getOrNull(pr),
				path,
				base: Option.getOrNull(rangeBase),
				tip: Option.getOrNull(tip),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("This skill's own text at a diff's merge base."),
	Command.withDescription(
		[
			"Prints `base\\t<merge-base>\\t<count>`, then a `file\\t<path>\\t<bytes>` header and bytes per file.",
			"  7: the PR is absent or closed, or no skill file resolves",
			"  10: a bad --path, range or subject",
			"  11: a read failed, or the skill root is ambiguous",
			"  12: the head moved while the base was resolved",
			'  Derivation: the governance skill\'s contract.md, "governance base"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika governance base 4321"},
		{command: "fabrika governance base --base 9f2c1ab --tip 03135b9"},
	]),
);

const post = leafCommand(
	"post",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription(
				"the pull-request number — with --base/--tip, the child issue instead",
			),
		),
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity"),
		),
		sha: Flag.string("sha").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head the reviewer actually inspected (7-40 lowercase hex); required unless --base/--tip scope the verdict to a range",
			),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the human clause; blank is not a clause"),
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
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, polarity, sha, clause, base, tip, supersede, repo, json}) {
		yield* emit(
			yield* runPost({
				pr,
				polarity,
				sha: Option.getOrNull(sha),
				clause,
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				supersede,
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: Effect.sync(() => Date.now()),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the governance verdict on stdin as one comment."),
	Command.withDescription(
		[
			"Appends the stdin verdict to its comment and prints the read-back line below.",
			"  posted\\tgovernance\\t<polarity>\\t<sha|base..tip>\\t<content>\\t<created|superseded>\\t<url>",
			"  3: stdin held nothing",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the PR or issue is absent or closed",
			"  8: the write is unproven",
			"  9: the read-back differs",
			"  10: a bad flag or flag combination",
			"  11: a read failed; nothing posted",
			"  12: the head moved past --sha",
			"  14: no governance namespace is required",
			"  17: an opposite verdict stands (--supersede)",
			'  Derivation: the governance skill\'s contract.md, "governance post"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika governance post 4321 --polarity PASS --sha 03135b91 --clause "no contradiction, no weakening" < verdict.md',
		},
		{
			command:
				'fabrika governance post 5830 --polarity PASS --base 9f2c1ab --tip 03135b9 --clause "no contradiction, no weakening" < verdict.md',
		},
	]),
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
		const corpus = yield* corpusFor("governance digest", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(
			yield* runDigest({
				since,
				until: Option.getOrNull(until),
				dir: corpus.dir,
				base: ref,
				json,
				now: Effect.sync(() => Date.now()),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The decision records that landed in a window."),
	Command.withDescription(
		[
			"Prints `digest\\t<landed|none>\\t<count>`, then a `landed` line per record landed in the window.",
			"  7: --dir is absent or holds zero records",
			"  10: a malformed date, or --until before --since",
			"  11: a fetch or read failed (UNKNOWN, never none)",
			"  13: a shallow clone's graft cuts the window",
			'  Derivation: the governance skill\'s contract.md, "governance digest"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika governance digest --since 2026-08-02"}]),
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
		[
			"Publishes the rows on stdin and prints `readout\\t<issue>\\t<rows>\\t<created|edited>\\t<url>`.",
			"  3: stdin held nothing",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the readout issue is absent, closed or unresolvable",
			"  8: the write is unproven",
			"  9: the read-back differs",
			"  10: a row's kind or id is off the vocabulary",
			"  11: a read failed; nothing was written",
			"  13: the comment list is provably short",
			'  Derivation: the governance skill\'s contract.md, "governance readout"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"printf 'row\\t0240\\troutine\\tno tension found\\n' | fabrika governance readout 4952",
		},
	]),
);

export const governanceCommand = Command.make("governance").pipe(
	Command.withSubcommands([scope, sweep, guards, base, post, digest, readout]),
	Command.withShortDescription("Keep the governance corpus honest across a diff."),
	Command.withDescription(
		"Keep the governance corpus honest: derive the namespace a diff requires, rank the records it may contradict, scan the anchored invariants it moves, read this skill's own text at the merge base, emit the one verdict, and publish the periodic non-blocking readout",
	),
);
