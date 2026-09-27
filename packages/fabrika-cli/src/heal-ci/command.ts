/**
 * The `heal-ci` verb group — `fabrika heal-ci <diagnose|sweep|surface|logs|classify|rerun|note|scratch>`,
 * the `heal-ci` skill's repair lane.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * `--sha` defaults to the empty string rather than being optional, and the verbs read that as "the
 * live head": a caller that passes the flag gets it bound and prefix-matched, and one that omits it
 * never reaches the matching logic at all.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {MERGEABILITY_WINDOW_SECONDS} from "../ship/mergeability.ts";
import {runClassify} from "./classify-verb.ts";
import {runDiagnose} from "./diagnose-verb.ts";
import {runLogs} from "./logs-verb.ts";
import {runNote} from "./note-verb.ts";
import {runRerun} from "./rerun-verb.ts";
import {runScratch} from "./scratch-verb.ts";
import {SIGNATURE_IDS} from "./signatures.ts";
import {STALL_TOKENS} from "./stall.ts";
import {runSurface} from "./surface-verb.ts";
import {runSweep} from "./sweep-verb.ts";

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
	Flag.withDefault(""),
	Flag.withDescription(
		"the head this answer binds to (7-40 lowercase hex); omitted means the live head, and a malformed value is a usage error, never a pattern matching every head",
	),
);

const dwellFlag = Flag.integer("dwell-minutes").pipe(
	Flag.withDefault(45),
	Flag.withDescription("how long a claimed PR may go without activity before it reads claim-stale"),
);

const wedgeDwellFlag = Flag.integer("wedge-dwell-minutes").pipe(
	Flag.withDefault(20),
	Flag.withDescription("how long a queued-never-started check dwells before it reads wedged"),
);

const driftFlag = Flag.integer("drift-commits").pipe(
	Flag.withDefault(10),
	Flag.withDescription(
		"how far a claimed head may sit behind its base before the claim reads stale on ground drift",
	),
);

/**
 * The window GitHub's lazy `mergeable` job gets before the conflict arm is skipped as indefinite.
 *
 * The default is `ship`'s, imported rather than restated: both groups wait on the one background job,
 * and two defaults would be two answers about one pull request.
 */
const mergeabilitySecondsFlag = Flag.integer("mergeability-seconds").pipe(
	Flag.withDefault(MERGEABILITY_WINDOW_SECONDS),
	Flag.withDescription(
		"how long an indefinite `mergeable` is re-read before the conflict arm is skipped; 0 reads once and never re-reads",
	),
);

const diagnose = leafCommand(
	"diagnose",
	{
		pr: prArg,
		sha: shaFlag,
		dwellMinutes: dwellFlag,
		wedgeDwellMinutes: wedgeDwellFlag,
		driftCommits: driftFlag,
		mergeabilitySeconds: mergeabilitySecondsFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		pr,
		sha,
		dwellMinutes,
		wedgeDwellMinutes,
		driftCommits,
		mergeabilitySeconds,
		repo,
		json,
	}) {
		yield* emit(
			yield* runDiagnose({
				pr,
				sha,
				dwellMinutes,
				wedgeDwellMinutes,
				driftCommits,
				mergeabilitySeconds,
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
				now: Date.now(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("One PR's stall class, with the evidence that proves it."),
	Command.withDescription(
		[
			"Classifies one PR's stall; prints `stall\\t<token>\\t<head-sha>\\t<age-minutes>`, then evidence.",
			"  Tokens: attended, ungated, gated-unshipped, claim-stale, red, check-surface, conflicted,",
			"  linkage-refused, blocked-human, wedged, not-open; each one is an answer, not a refusal.",
			"  Evidence lines, always present: owner, author, gates, ci, queue, link, facts.",
			"  7: the PR or --sha commit is absent, or the changed-file list is empty",
			"  11: a read failed (UNKNOWN, never attended)",
			"  13: an enumeration is provably partial",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci diagnose"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci diagnose 4321"}]),
);

const sweep = leafCommand(
	"sweep",
	{
		minAgeMinutes: Flag.integer("min-age-minutes").pipe(
			Flag.withDefault(30),
			Flag.withDescription("omit PRs whose strand age is below this grace window"),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(200),
			Flag.withDescription(
				"the maximum number of open PRs to classify; a scan that would exceed it refuses rather than answering over a subset",
			),
		),
		includeAttended: Flag.boolean("include-attended").pipe(
			Flag.withDefault(false),
			Flag.withDescription("emit attended rows too, rather than only the stalled ones"),
		),
		dwellMinutes: dwellFlag,
		wedgeDwellMinutes: wedgeDwellFlag,
		driftCommits: driftFlag,
		mergeabilitySeconds: mergeabilitySecondsFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		minAgeMinutes,
		limit,
		includeAttended,
		dwellMinutes,
		wedgeDwellMinutes,
		driftCommits,
		mergeabilitySeconds,
		repo,
		json,
	}) {
		yield* emit(
			yield* runSweep({
				minAgeMinutes,
				limit,
				includeAttended,
				dwellMinutes,
				wedgeDwellMinutes,
				driftCommits,
				mergeabilitySeconds,
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
				now: Date.now(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Every open PR classified with its strand age."),
	Command.withDescription(
		[
			"Classifies every open PR; prints `swept\\t<scanned>\\t<stalled>`, then one row per stalled PR.",
			"  Row: `pr\\t<number>\\t<token>\\t<age>\\t<head>\\t<build|review|ship|author|human|nobody>`",
			"  Rows run oldest strand first, ties by PR number; this verb writes nothing.",
			"  11: the PR list or a per-PR read failed, or the rate limit ran out (UNKNOWN)",
			"  13: the enumeration never ended, or the open-PR count exceeds --limit",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci sweep"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci sweep --min-age-minutes 30"}]),
);

const surface = leafCommand(
	"surface",
	{pr: prArg, sha: shaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(yield* runSurface({pr, sha, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Declared required contexts against the runs at a head."),
	Command.withDescription(
		[
			"Compares a base's required contexts with a head's runs; prints `surface\\t<verdict>\\t<sha>` first.",
			"  Verdicts: covered, gap, no-requirements, unprobeable (a permission answer).",
			"  Then `required\\t<name>\\t<producing|absent>` and `extra\\t<name>` lines, and a facts line.",
			"  7: the PR or --sha commit is absent",
			"  11: protection, rulesets or check runs could not be read (UNKNOWN)",
			"  13: an enumeration is provably incomplete",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci surface"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci surface 4321"}]),
);

const logs = leafCommand(
	"logs",
	{
		pr: prArg,
		sha: shaFlag,
		context: Flag.string("context").pipe(
			Flag.withDefault(""),
			Flag.withDescription(
				"read only this gating context's log rather than every failing one; the header count still reports the whole failing set",
			),
		),
		maxBytes: Flag.integer("max-bytes").pipe(
			Flag.withDefault(65536),
			Flag.withDescription("per-context tail budget; the log's LAST N bytes are kept"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, context, maxBytes, repo, json}) {
		yield* emit(
			yield* runLogs({
				pr,
				sha,
				context,
				maxBytes,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The failed-job log text for every failing gating context."),
	Command.withDescription(
		[
			"Prints `logs\\t<count>\\t<sha>`, then the framed failed-job log of every failing gating context.",
			"  Frame: `==== context <name> job <id> bytes <k> truncated <bool> ====`, the log bytes,",
			"  then `==== end <name> ====`; `logs 0 <sha>` means nothing gating is failing.",
			"  7: the PR or --sha commit is absent, or --context names no failing gating context",
			"  11: a check-run, run, log or required-set read failed (UNKNOWN, never empty)",
			"  13: an enumeration is provably short",
			"  15: the platform expired the run's logs",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci logs"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci logs 4322 --sha 9fe12ab0"}]),
);

const classify = leafCommand(
	"classify",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emit(yield* runClassify({json, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription("Match log text against the closed failure-signature table."),
	Command.withDescription(
		[
			"Classifies log text on stdin; prints `classified\\t<n>`, then one `class` line per context.",
			"  Line: `class\\t<context>\\t<transient|logic|unclassified>\\t<signature-id>\\t<matched-line>`",
			"  Pure, and it reads `heal-ci logs` framing; an unframed body is one block under context `-`.",
			"  3: stdin was empty",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci classify"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci logs 4322 | fabrika heal-ci classify"}]),
);

const rerun = leafCommand(
	"rerun",
	{
		pr: prArg,
		run: Flag.integer("run").pipe(
			Flag.withDescription("the workflow run whose failed jobs are to be re-run"),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription(
				"the head the transient was diagnosed at; the at-most-once guard is per head, so this is required",
			),
		),
		signature: Flag.string("signature").pipe(
			Flag.withDescription(
				`the classify signature id justifying the rerun, recorded in the durable marker: one of ${SIGNATURE_IDS.join(", ")}`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, run, sha, signature, repo, json}) {
		yield* emit(
			yield* runRerun({
				pr,
				run,
				sha,
				signature,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Re-run a run's failed jobs once, guarded and verified."),
	Command.withDescription(
		[
			"Re-runs failed jobs once per head; prints `rerun\\t<new-attempt>\\t<run-id>\\t<marker-url>`.",
			"  7: the PR or run is absent",
			"  8: the request or its re-read failed (UNKNOWN), no marker written",
			"  9: the marker read-back does not match",
			"  10: --signature is off the classify table",
			"  11: a precondition read failed; nothing was requested",
			"  12: the live head moved past --sha",
			"  13: the comment enumeration never proved complete",
			"  14: not a failed run, already rerun, or the PR is not open",
			"  16: the rerun landed unrecorded; escalate",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci rerun"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika heal-ci rerun 4322 --run 9182736450 --sha 9fe12ab0 --signature preview-warmup",
		},
	]),
);

const note = leafCommand(
	"note",
	{
		pr: prArg,
		stallClass: Flag.string("class").pipe(
			Flag.withDescription(
				`the stall class this note records, the key's middle field: one of ${STALL_TOKENS.join(", ")}`,
			),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription(
				"the full 40-hex head the classification was taken at; the key compares it as equality, so an abbreviation is a usage error",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, stallClass, sha, repo, json}) {
		yield* emit(
			yield* runNote({
				pr,
				stallClass,
				sha,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the durable stop-path note, once per class and head."),
	Command.withDescription(
		[
			"Posts the stdin note once per PR, class and head; prints `noted\\t<comment-url>`.",
			"  3: stdin was empty",
			"  5: the body carries a machine-local path",
			"  6: the body is a bare @ reference",
			"  7: the PR is absent",
			"  8: the create or its re-read failed (UNKNOWN)",
			"  9: the read-back does not match",
			"  10: --class is off the stall vocabulary",
			"  11: the PR or its comments could not be read; nothing was posted",
			"  13: the comment enumeration is short",
			"  14: this key is already recorded; nothing was written",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci note"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika heal-ci note 4321 --class gated-unshipped --sha 03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c < note.md",
		},
	]),
);

const scratch = leafCommand(
	"scratch",
	{
		pr: prArg,
		slug: Flag.string("slug").pipe(
			Flag.withDescription(
				"the leaf filename under the lane's directory; kebab-case, no separators",
			),
		),
	},
	Effect.fn(function* ({pr, slug}) {
		yield* emit(yield* runScratch({pr, slug, env: process.env, tmpRoot: tmpdir()}));
	}),
).pipe(
	Command.withShortDescription("The per-lane scratch path a healer's note bodies go under."),
	Command.withDescription(
		[
			"Prints this lane's absolute scratch path, creating the directory if absent.",
			"  Path: <temp root>/fabrika-heal-ci/<session-id>/<pr>/<slug>; never post it.",
			"  10: --slug carries a path separator or is not kebab-case",
			'  Derivation: the heal-ci skill\'s contract.md, "heal-ci scratch"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika heal-ci scratch 4321 --slug note"}]),
);

export const healCiCommand = Command.make("heal-ci").pipe(
	Command.withSubcommands([diagnose, sweep, surface, logs, classify, rerun, note, scratch]),
	Command.withShortDescription("Classify a stranded or red PR and drive it toward green."),
	Command.withDescription(
		"The repair lane: classify one stranded or red pull request — or sweep the whole board for them — read the failing logs, match them against a closed signature table, spend the one guarded rerun a transient earns, and leave the durable record of what was decided",
	),
);
