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
 *
 * There is no `--json` flag: `trail`, `emit` and `read` already answer with one JSON object, and
 * `compose`'s answer is the markdown body a caller hands straight to `emit --spec`.
 */

import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readFile} from "../io/fs.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import type {DocumentRead} from "./compose-verb.ts";
import {runCompose} from "./compose-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {runRead} from "./read-verb.ts";
import {runTrail} from "./trail-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emitOutcome = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

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
		'Resolve a grilling session or wayfinding map THROUGH ITS OWN SIBLING RESOLVER and normalize it into one trail: {"source":n,"kind":"grilling|map","readiness":"ready|blocked|empty","trailDigest":"…","decisions":[…],"unresolved":[…],"outOfScope":[…],"counts":{…}}. All three readiness tokens exit 0 — a blocked trail is this skill working. Exits 4 (the map body does not parse), 7 (no such issue), 11 (a read could not complete, so the trail is UNKNOWN), 12 (the issue carries neither source label, or both). Example: fabrika graduate trail 9412',
	),
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
		"Read the three authored sections (## Problem, ## Solution, ## Out of scope) from STDIN, render ## Decisions from --trail, and print the composed markdown body — the bytes `graduate emit --spec` takes. The decisions section is never authored: a stdin body carrying that heading is 17. Exits 3 (empty stdin), 4 (an authored section is missing, out of order or empty; or --decisions names a ref not on the trail), 5 (machine-local path), 6 (bare @ reference), 11 (--trail could not be read), 13 (the trail is blocked), 14 (no 12-hex trailDigest, or a decision missing a digested field), 16 (zero decisions selected), 17 (stdin carries ## Decisions). Example: fabrika graduate compose --trail trail.json < spec.md",
	),
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
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("File the one spec issue and record the emission on the source."),
	Command.withDescription(
		'File exactly ONE spec issue carrying only status:needs-triage, read it back, then post the graduate-emitted marker on the source, and print {"source":n,"issue":n,"url":"…","specDigest":"…","labels":["status:needs-triage"],"marker":n}. The trail and the digest are re-derived from the source, never passed in. Exits 4 (--spec sections), 5 (machine-local path), 6 (bare @ reference), 7 (no such source, or no status:needs-triage label), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 10 (--title classifies), 11 (a precondition read failed), 12 (neither source label), 13 (blocked trail), 14 (a decision cannot be digested), 15 (this spec digest already emitted an issue), 16 (zero decisions), 18 (a ref the spec carries moved on the trail, or a decisions line does not parse). Example: fabrika graduate emit 9412 --spec spec.md --title "Cap moderation weight per topic"',
	),
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
		'Read a source\'s emission markers: {"source":n,"state":"graduated|ungraduated","emissions":[…],"disregarded":[…],"scanned":{"comments":n}}. Never refuses on marker content — a malformed marker is a disregarded row at exit 0, never an absence. Exits 7 (no such source), 11 (the comment read could not complete, so whether it graduated is UNKNOWN), 12 (neither source label). Example: fabrika graduate read 9412',
	),
);

export const graduateCommand = Command.make("graduate").pipe(
	Command.withSubcommands([trail, compose, emit, read]),
	Command.withShortDescription("Turn a cleared decision trail into one buildable spec issue."),
	Command.withDescription(
		"Turn a cleared decision trail into ONE buildable spec issue: resolve a grilling session or a wayfinding map through its own sibling reader, render a spec whose ## Decisions section separates what the founder ruled from what an agent established, file it at status:needs-triage, and record the emission on the source",
	),
);
