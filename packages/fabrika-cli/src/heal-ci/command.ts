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

const diagnose = leafCommand(
	"diagnose",
	{
		pr: prArg,
		sha: shaFlag,
		dwellMinutes: dwellFlag,
		wedgeDwellMinutes: wedgeDwellFlag,
		driftCommits: driftFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, dwellMinutes, wedgeDwellMinutes, driftCommits, repo, json}) {
		yield* emit(
			yield* runDiagnose({
				pr,
				sha,
				dwellMinutes,
				wedgeDwellMinutes,
				driftCommits,
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
		"Classify one PR through an ordered, total predicate chain and print the evidence. First stdout line is `stall\\t<token>\\t<head-sha>\\t<age-minutes>` where the token is one of attended, ungated, gated-unshipped, claim-stale, red, check-surface, linkage-refused, blocked-human, wedged, not-open; then the fixed evidence lines owner, gates, ci, queue, link and facts, each present always. Every one of those tokens is an ANSWER at exit 0, including not-open. Where the protection surface is unprobeable the check-surface arm is skipped with a stderr notice rather than passed — a permission the token lacks never reads as a surface that is clean. The blocked-human arm is likewise narrowed and says so on stderr every run: its unresolved-thread clause has no REST form and this group takes no GraphQL carve, so blocked-human is derived from reviews alone and a PR blocked only by an unresolved thread reads as whatever the later arms make of it. Exits 7 (the PR is proven absent, or --sha names no commit on it), 11 (the PR, its comments, its check runs, its verdicts, its timeline or its base could not be read — the stall class is UNKNOWN, never attended), 13 (an enumeration is provably short of its declared count, or the timeline read never reached a terminal page). Example: fabrika heal-ci diagnose 4321",
	),
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
			Flag.withDescription("emit attended rows too, rather than only the stalled ones"),
		),
		dwellMinutes: dwellFlag,
		wedgeDwellMinutes: wedgeDwellFlag,
		driftCommits: driftFlag,
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
		"Classify every open pull request through `heal-ci diagnose`'s shared predicate chain and emit the stalled ones, ordered by strand age descending with ties broken by ascending PR number. First stdout line is `swept\\t<scanned>\\t<stalled>` — both counts always, so a zero-stall answer carries the scope it rests on rather than standing as a bare claim — then one `pr\\t<number>\\t<token>\\t<age>\\t<head>\\t<lane>` line per emitted PR, the lane being the note's arrow looked up off the class (build|review|ship|author|human|nobody) so a caller relays it instead of deriving one. This verb writes nothing: it files no issue, assigns nobody and spawns nothing (ADR 0205). A PR that closed between the list read and its classification stays in the scanned count and leaves the stalled one. Exits 11 (the open-PR list or a per-PR read failed, or the rate limit was exhausted mid-sweep — the sweep is UNKNOWN, never a shorter list), 13 (the enumeration never reached a terminal page, or the open-PR count exceeds --limit). Example: fabrika heal-ci sweep --min-age-minutes 30",
	),
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
		"Compare the contexts a base branch declares required — branch protection unioned with the rulesets that match it — against the gating runs that actually post at a head. First stdout line is `surface\\t<covered|gap|no-requirements|unprobeable>\\t<sha>`, then one `required\\t<name>\\t<producing|absent>` line per declared context, one `extra\\t<name>` line per gating run answering no requirement, and a facts line whose `producing` counts declared contexts that have a producing run. `unprobeable` is the permission answer and is NOT `no-requirements`: the protection endpoint answers 404 both when a branch is unprotected and when the token cannot see it, so no-requirements needs a successful rules read returning nothing as well. This verb changes nothing — arming, renaming and disarming a required context are a human's act. Exits 7 (the PR or the --sha commit is proven absent), 11 (protection, rulesets or check runs could not be read — coverage is UNKNOWN, never covered and never no-requirements), 13 (an enumeration is provably incomplete). Example: fabrika heal-ci surface 4321",
	),
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
		"Read the failed-job log for EVERY failing gating context at a head, not the first — an N-context red is N routed actions. First stdout line is `logs\\t<count>\\t<sha>`, then per context a `==== context <name> job <id> bytes <k> truncated <bool> ====` header, the log bytes, and an `==== end <name> ====` terminator, which is the framing `heal-ci classify` splits on. `logs 0 <sha>` is a proven answer: nothing gating is failing here. Informational contexts are excluded before anything is fetched (ADR 0061), truncation is declared rather than silent, and a failing context with no workflow job behind it is emitted with an empty body rather than failing the whole read. Exits 7 (the PR or --sha commit is proven absent, or --context names no failing gating context here), 11 (the check runs, run list or a job log could not be read — UNKNOWN, never empty), 13 (an enumeration is provably short), 15 (the platform reports the run's logs expired, which no retry changes). Example: fabrika heal-ci logs 4322 --sha 9fe12ab0",
	),
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
		"Classify log text arriving on STDIN against a closed, ordered ten-row signature table — the first row whose pattern matches wins, and the ordering is part of the contract because the classes genuinely overlap. Pure: no network, no state, no flags but --json, so a classification is reproducible from the bytes alone. First stdout line is `classified\\t<n>`, then one `class\\t<context>\\t<transient|logic|unclassified>\\t<signature-id>\\t<matched-line>` line per context, in the order received. It consumes `heal-ci logs`' framed multi-context stream directly, so nothing splits it by hand; a bare body with no framing is one block under context `-`. `unclassified` is a third token, distinct from `logic`, and there is no path from ambiguous input to `transient`. Exits 3 (stdin was read and held nothing — an empty read is not an unclassified failure). Example: fabrika heal-ci logs 4322 | fabrika heal-ci classify",
	),
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
		"Re-run one workflow run's failed jobs AT MOST ONCE per head, re-deriving every precondition inside the verb and trusting nothing it was told: the live head must prefix-match --sha, the run must have concluded failure at that head, and the head must not already have been rerun — proven from two independent, fully paginated signals, the run's own run_attempt and a bound marker comment. The request is then read back and a new attempt REQUIRED before any marker is written, so a dispatch that never produced an attempt leaves no marker behind. Stdout is one line: `rerun\\t<new-attempt>\\t<run-id>\\t<marker-url>`, where the attempt is the one read back and never the value the caller held. Exits 7 (the PR or run is proven absent), 8 (the request or its confirming read failed — UNKNOWN, and NO marker was written), 9 (the rerun landed and the marker read-back does not match), 10 (--signature is off the classify table), 11 (a precondition read failed — nothing was requested), 12 (the live head moved past --sha), 13 (the comment enumeration never proved complete), 14 (proven: not a failed run, already rerun, or the PR is not open — a refusal that is a success, since nothing was mutated), 16 (the rerun provably landed and its marker could not be written — spent and unrecorded, escalate first). Example: fabrika heal-ci rerun 4322 --run 9182736450 --sha 9fe12ab0 --signature preview-warmup",
	),
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
		"Post the durable record of what this lane decided, as a NEW comment — a strand's history is a history, not a state, so each classification is its own record and a note on a closed or merged PR is legal. What is not its own record is the SAME classification of the same head by a second caller: --class and --sha, with the PR number, form the key `<pr>:<class>:<head>`, which the verb emits as the HTML-comment marker `<!-- heal-ci-note key=<pr>:<class>:<head> -->` on the note's last line and reads back over the pull request's WHOLE comment history before creating. A comment already carrying that exact key is exit 14 with nothing posted; a comment list that could not be read is 11, never an absent note. One key earns one note for as long as the PR is open, so a strand is re-noticed only when its class changes or a new commit lands. The body arrives on stdin only; there is no path flag. Leak-scanned before the write and read back after it. Stdout is one line: `noted\\t<comment-url>`. A --sha that is not the live head is a stderr notice, never a refusal — the note records a classification at the head it was taken at. Exits 1 (--sha is not a full 40-hex sha), 3 (stdin held nothing), 5 (the body carries a machine-local path), 6 (the body is a bare @ path reference), 7 (the PR is proven absent), 8 (the create or its confirming re-read failed — UNKNOWN whether it landed), 9 (it landed and the read-back does not match), 10 (--class is off the stall vocabulary), 11 (the PR or its comments could not be read — nothing was posted), 13 (the comment enumeration is short of the declared count), 14 (proven: this key is already recorded — a refusal that is a success, since nothing was written). Example: fabrika heal-ci note 4321 --class gated-unshipped --sha 03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c < note.md",
	),
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
		"The per-lane scratch path, allocated fail-closed: <temp root>/fabrika-heal-ci/<session-id>/<pr>/<slug>, one absolute path on stdout, the directory created if absent. The session id and the PR number key the namespace, so two concurrent healers cannot derive one path. There is no nonce and no --token, unlike `build scratch` and `triage scratch`: this group has no claim verb, and a heal-ci run is one forked shell. The printed path is machine-local and must never reach a posted artifact — `heal-ci note` reds on one. Exits 1 (the directory could not be created, the positional is not a PR number, no session id is set (the FABRIKA_SESSION_ID → CLAUDE_CODE_SESSION_ID → PI_SUBAGENT_PARENT_SESSION chain), or the id is not one path segment), 10 (--slug carries a path separator or is not kebab-case). Example: fabrika heal-ci scratch 4321 --slug note",
	),
);

export const healCiCommand = Command.make("heal-ci").pipe(
	Command.withSubcommands([diagnose, sweep, surface, logs, classify, rerun, note, scratch]),
	Command.withShortDescription("Classify a stranded or red PR and drive it toward green."),
	Command.withDescription(
		"The repair lane: classify one stranded or red pull request — or sweep the whole board for them — read the failing logs, match them against a closed signature table, spend the one guarded rerun a transient earns, and leave the durable record of what was decided",
	),
);
