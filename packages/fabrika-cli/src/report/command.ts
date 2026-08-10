/**
 * The `report` verb group — `fabrika report <dedup|file|note>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives
 * in the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning
 * a process.
 *
 * **The body is a value, never a path.** There is deliberately no `--body` flag, no `--body-file`
 * and no temp file: a flag that accepts a path turns the body into a string the verb could post
 * verbatim, which is how #3086 and #3945 happened. A shell redirect is fine and expected — the
 * *shell* reads the file, so what reaches the verb is already the bytes.
 */
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {DEFAULT_LIMIT} from "./dedup.ts";
import {runDedup} from "./dedup-verb.ts";
import {runFile} from "./file-verb.ts";
import {runNote} from "./note-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const DEFAULT_LABEL = "status:needs-triage";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const redactFlag = Flag.boolean("redact").pipe(
	Flag.withDescription(
		"mask each machine-local path down to its class root and post the masked body, instead of refusing",
	),
);

const dedup = leafCommand(
	"dedup",
	{
		query: Flag.string("query").pipe(
			Flag.withDescription("the observation text to check for an already-open issue"),
		),
		label: Flag.string("label").pipe(
			Flag.withDefault(DEFAULT_LABEL),
			Flag.withDescription(
				`the intake-queue label whose open issues are read (default: ${DEFAULT_LABEL})`,
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(DEFAULT_LIMIT),
			Flag.withDescription(`the maximum number of candidates to print (default: ${DEFAULT_LIMIT})`),
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
	Effect.fn(function* ({query, label, limit, exclude, repo, json}) {
		yield* emit(
			yield* runDedup({
				query,
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
	Command.withShortDescription("Rank the open issues that may already cover an observation."),
	Command.withDescription(
		'Rank the open issues that may already cover an observation. First stdout line is the outcome token — candidates | none | indeterminate — and ALL THREE exit 0; a candidates list adds one `<number>\\t<source>\\t<score>\\t<title>` line per entry. Exits 3 (queue unreadable), 4 (search index unreadable), 7 (--label does not exist, so the queue half would scan nothing). Example: fabrika report dedup --query "retry helper swallows the abort reason" --exclude 4312',
	),
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
		'Compose the intake issue from the six sections on STDIN, guard it, create it, and read back what landed. Prints `<number>\\t<url>`. Exits 3 (empty stdin), 4 (bad sections), 5 (machine-local path), 6 (bare @ reference), 7 (no such label), 8 (create failed — UNKNOWN), 9 (read-back mismatch), 10 (title or label classifies), 11 (label set unreadable). Example: fabrika report file --title "Retry helper swallows the abort reason" < body.md',
	),
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
		"Add a note from STDIN to an existing issue over the same guarded path, then read the comment back. Prints `<comment-id>\\t<url>`. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (no such issue), 8 (post failed — UNKNOWN), 9 (read-back mismatch), 11 (issue unreadable). Example: fabrika report note --issue 4312 < note.md",
	),
);

export const reportCommand = Command.make("report").pipe(
	Command.withSubcommands([dedup, fileCmd, note]),
	Command.withDescription(
		"File one follow-up observation into the intake queue: check for a duplicate, then compose and post it over a guarded path that refuses a leak, an empty body, or a hand-applied classification",
	),
);
