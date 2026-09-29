/**
 * The `graduate` verb group — `fabrika graduate <trail|compose|emit|read>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), reads the two document paths off disk, runs the pure verb, and
 * emits its outcome. Every decision lives in the `*-verb.ts` modules beside it, which is what makes
 * each refusal testable without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */

import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit as emitOutcome} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readFile} from "../io/fs.ts";
import {readStdin} from "../io/stdin.ts";
import {readBoard} from "../status/label-remedy.ts";
import type {DocumentRead} from "./compose-verb.ts";
import {runCompose} from "./compose-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {runRead} from "./read-verb.ts";
import {runTrail} from "./trail-verb.ts";

/**
 * Read a document the verb was pointed at, as a value.
 *
 * The read happens here rather than in the verb so a verb stays a pure function of its dependencies:
 * a test hands it the bytes, and a failed read is a value the verb branches on rather than an
 * exception it has to catch.
 */
const document = (path: string): Effect.Effect<DocumentRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const read = yield* Effect.result(readFile(path));
		return Result.isFailure(read)
			? ({_tag: "Failed", reason: read.failure.reason} satisfies DocumentRead)
			: ({_tag: "Text", text: read.success} satisfies DocumentRead);
	});

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const sourceArg = Argument.integer("source").pipe(
	Argument.withDescription("the grilling session or wayfinding map issue the trail is read from"),
);

const trail = leafCommand(
	"trail",
	{source: sourceArg, repo: repoFlag},
	Effect.fn(function* ({source, repo}) {
		yield* emitOutcome(yield* runTrail({source, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Resolve a source into one provenance-tagged decision trail."),
	Command.withDescription(
		[
			"Resolves a grilling session or wayfinding map into one decision trail and prints it as JSON.",
			"  ready, blocked and empty are all answers.",
			"  4: the map body does not parse",
			"  7: no such issue",
			"  11: a read failed, so the trail is UNKNOWN",
			"  12: the issue carries neither source label, or both",
			'  Derivation: the graduate skill\'s contract.md, "graduate trail"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika graduate trail 9412"}]),
);

const compose = leafCommand(
	"compose",
	{
		trail: Flag.string("trail").pipe(
			Flag.withDescription("a file holding the exact JSON object `graduate trail` printed"),
		),
		decisions: Flag.string("decisions").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"one ref this spec covers, given once per ref (repeatable, never comma-joined — a map ref carries a space); default: every decision on the trail",
			),
		),
	},
	Effect.fn(function* ({trail: trailPath, decisions}) {
		yield* emitOutcome(
			yield* runCompose({
				trailPath,
				trail: document(trailPath),
				decisions,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Render the four-section spec body from the trail and stdin."),
	Command.withDescription(
		[
			"Composes the spec body from the stdin sections and --trail's decisions and prints the markdown.",
			"  3: empty stdin",
			"  4: an authored section is missing, misordered or empty, or a ref is off the trail",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  11: --trail could not be read",
			"  13: the trail is blocked",
			"  14: the trail digest or a decision's digested field is missing",
			"  16: zero decisions selected",
			"  17: stdin carries its own Decisions section",
			'  Derivation: the graduate skill\'s contract.md, "graduate compose"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika graduate compose --trail trail.json < spec.md"}]),
);

const emit = leafCommand(
	"emit",
	{
		source: sourceArg,
		spec: Flag.string("spec").pipe(
			Flag.withDescription("a file holding the body `graduate compose` printed"),
		),
		title: Flag.string("title").pipe(
			Flag.withDescription(
				"the spec issue's title; type-neutral, and refused at 10 if it classifies the work",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({source, spec, title, repo}) {
		yield* emitOutcome(
			yield* runEmit({
				source,
				specPath: spec,
				spec: document(spec),
				title,
				repo: Option.getOrNull(repo),
				env: process.env,
				board: yield* readBoard(process.cwd()),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("File the one spec issue and record the emission on the source."),
	Command.withDescription(
		[
			"Files one spec issue, marks the emission on its source and prints both as JSON.",
			"  4: bad --spec sections",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: no such source, or no status:needs-triage label",
			"  8: a write failed (UNKNOWN)",
			"  9: the read-back differs",
			"  10: --title classifies",
			"  11: a precondition read failed",
			"  12: neither source label",
			"  13: the trail is blocked",
			"  14: a decision cannot be digested",
			"  15: this spec was already emitted",
			"  16: zero decisions",
			"  18: a spec ref moved, or a decisions line is unparseable",
			'  Derivation: the graduate skill\'s contract.md, "graduate emit"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika graduate emit 9412 --spec spec.md --title "Cap moderation weight per topic"',
		},
	]),
);

const read = leafCommand(
	"read",
	{source: sourceArg, repo: repoFlag},
	Effect.fn(function* ({source, repo}) {
		yield* emitOutcome(yield* runRead({source, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Has this source already graduated, and into what."),
	Command.withDescription(
		[
			"Prints a source's graduation state and emission markers as JSON.",
			"  A malformed marker is a disregarded row, never an absence.",
			"  7: no such source",
			"  11: the comment read failed, so graduation is UNKNOWN",
			"  12: neither source label",
			'  Derivation: the graduate skill\'s contract.md, "graduate read"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika graduate read 9412"}]),
);

export const graduateCommand = Command.make("graduate").pipe(
	Command.withSubcommands([trail, compose, emit, read]),
	Command.withShortDescription("Turn a cleared decision trail into one buildable spec issue."),
	Command.withDescription(
		"Turn a cleared decision trail into ONE buildable spec issue: resolve a grilling session or a wayfinding map through its own sibling reader, render a spec whose ## Decisions section separates what the founder ruled from what an agent established, file it at status:needs-triage, and record the emission on the source",
	),
);
