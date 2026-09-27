/**
 * The `report` verb group — `fabrika report <dedup|file|note|amend|scratch>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives
 * in the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning
 * a process.
 *
 * **The body is a value, never a path.** There is deliberately no `--body` flag, no `--body-file`
 * and no temp file: a flag that accepts a path turns the body into a string the verb could post
 * verbatim, and a posting call that does not expand `@` then ships the literal path into a public
 * artifact. A shell redirect is fine and expected — the
 * *shell* reads the file, so what reaches the verb is already the bytes. `scratch` allocates the
 * file that redirect reads and adds no argument to any writing verb, which is why it is the staged
 * route's allocator rather than a body flag.
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runAmend} from "./amend-verb.ts";
import {DEFAULT_LIMIT} from "./dedup.ts";
import {runDedup} from "./dedup-verb.ts";
import {runFile} from "./file-verb.ts";
import {DEFAULT_CLOSED_DAYS} from "./issue-index.ts";
import {runNote} from "./note-verb.ts";
import {runScratch} from "./scratch-verb.ts";

const DEFAULT_LABEL = "status:needs-triage";

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

const redactFlag = Flag.boolean("redact").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"mask each machine-local path down to its class root and post the masked body, instead of refusing",
	),
);

const dedup = leafCommand(
	"dedup",
	{
		query: Flag.string("query").pipe(
			Flag.withDescription("the observation text to compare with open and recently closed issues"),
		),
		closedDays: Flag.integer("closed-days").pipe(
			Flag.withDefault(DEFAULT_CLOSED_DAYS),
			Flag.withDescription(
				"integer from 0 to 36500; include issues closed within this many days; 0 searches open only (default: 14)",
			),
		),
		refresh: Flag.boolean("refresh").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"refresh the repository issue cache now; otherwise reuse it for up to five minutes",
			),
		),
		label: Flag.string("label").pipe(
			Flag.withDefault(DEFAULT_LABEL),
			Flag.withDescription(
				`the intake-queue label whose open issues are read (default: ${DEFAULT_LABEL})`,
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(DEFAULT_LIMIT),
			Flag.withDescription(
				`nonnegative safe integer; maximum candidates to print, 0 prints only the outcome (default: ${DEFAULT_LIMIT})`,
			),
		),
		exclude: Flag.integer("exclude").pipe(
			Flag.optional,
			Flag.withDescription(
				"an issue number to omit from both sources — the issue being deduped, so it never flags itself",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({query, closedDays, refresh, label, limit, exclude, repo, json}) {
		yield* emit(
			yield* runDedup({
				query,
				closedDays,
				refresh,
				label,
				limit,
				exclude: Option.getOrNull(exclude),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Find open and recently closed issues that may cover an observation.",
	),
	Command.withDescription(
		[
			"Prints candidates, none or indeterminate, each an answer, then one line per candidate issue.",
			"  Matches are advisory.",
			"  7: --label does not exist, so the queue half would scan nothing",
			"  27: the queue is unreadable",
			"  28: the issue corpus is unreadable",
			'  Derivation: the report skill\'s contract.md, "report dedup"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika report dedup --query "retry helper swallows the abort reason" --exclude 4312',
		},
	]),
);

const fileCmd = leafCommand(
	"file",
	{
		title: Flag.string("title").pipe(
			Flag.withDescription("the issue title: a short, specific, type-neutral summary"),
		),
		label: Flag.string("label").pipe(
			Flag.withDefault(DEFAULT_LABEL),
			Flag.withDescription(
				`the single intake-queue label the new issue carries (default: ${DEFAULT_LABEL})`,
			),
		),
		redact: redactFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({title, label, redact, repo, json}) {
		yield* emit(
			yield* runFile({
				title,
				label,
				redact,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Compose and file the intake issue from the sections on stdin."),
	Command.withDescription(
		[
			"Files the intake issue composed from the six stdin sections and prints `<number>\\t<url>`.",
			"  3: empty stdin",
			"  4: bad sections",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: no such label",
			"  8: the create failed (UNKNOWN)",
			"  9: the read-back differs",
			"  10: the title or label classifies",
			"  11: the label set is unreadable",
			'  Derivation: the report skill\'s contract.md, "report file"',
		].join("\n"),
	),
	Command.withExamples([
		{command: 'fabrika report file --title "Retry helper swallows the abort reason" < body.md'},
	]),
);

const note = leafCommand(
	"note",
	{
		issue: Flag.integer("issue").pipe(Flag.withDescription("the issue number to add the note to")),
		redact: redactFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, redact, repo, json}) {
		yield* emit(
			yield* runNote({
				issue,
				redact,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Add a note from stdin to an existing issue."),
	Command.withDescription(
		[
			"Adds a stdin note to an existing issue, reads it back and prints `<comment-id>\\t<url>`.",
			"  3: empty stdin",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: no such issue",
			"  8: the post failed (UNKNOWN)",
			"  9: the read-back differs",
			"  11: the issue is unreadable",
			'  Derivation: the report skill\'s contract.md, "report note"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika report note --issue 4312 < note.md"}]),
);

const scratch = leafCommand(
	"scratch",
	{
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, ≤5 words, no path separators"),
		),
	},
	Effect.fn(function* ({slug}) {
		yield* emit(yield* runScratch({slug, allocation: randomUUID(), tmpRoot: tmpdir()}));
	}),
).pipe(
	Command.withShortDescription("The staging path a body is written into before stdin carries it."),
	Command.withDescription(
		[
			"Allocates a fresh staging path for a stdin body, creates its directory and prints the path.",
			"  The path is not re-derivable, and it is machine-local, so it never goes in a posted artifact.",
			"  29: --slug has a separator, is not kebab-case or runs past 5 words",
			'  Derivation: the report skill\'s contract.md, "report scratch"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika report scratch --slug body"}]),
);

const amend = leafCommand(
	"amend",
	{
		issue: Flag.integer("issue").pipe(
			Flag.withDescription("the issue number whose body the amendment is appended to"),
		),
		redact: redactFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, redact, repo, json}) {
		yield* emit(
			yield* runAmend({
				issue,
				redact,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append a dated amendment from stdin to an existing issue's body."),
	Command.withDescription(
		[
			"Appends a dated stdin amendment under an issue's body and prints `<issue>\\t<url>`.",
			"  The prior body is kept verbatim, never replaced.",
			"  3: empty stdin",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: no such issue",
			"  8: the write failed (UNKNOWN)",
			"  9: the read-back differs",
			"  11: the issue is unreadable",
			'  Derivation: the report skill\'s contract.md, "report amend"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika report amend --issue 4312 < correction.md"}]),
);

export const reportCommand = Command.make("report").pipe(
	Command.withSubcommands([dedup, fileCmd, note, amend, scratch]),
	Command.withShortDescription("File one follow-up observation into the intake queue."),
	Command.withDescription(
		"File one follow-up observation into the intake queue: check for a duplicate, then compose and post it over a guarded path that refuses a leak, an empty body, or a hand-applied classification",
	),
);
