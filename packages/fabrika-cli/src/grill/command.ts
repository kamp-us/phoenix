/**
 * The `grill` verb group — `fabrika grill <open|round|answer|rule|read>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), reads the two document paths off disk, runs the pure verb, and
 * emits its outcome. Every decision lives in the `*-verb.ts` modules beside it, which is what makes
 * each refusal testable without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * There is no `--json` flag: the answer channel is already one JSON object on stdout, and a second
 * rendering would be a second contract to keep in step.
 */

import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readFile} from "../io/fs.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {type DocumentRead, runAnswer} from "./answer-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runRead} from "./read-verb.ts";
import {runRound} from "./round-verb.ts";
import {runRule} from "./rule-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

/**
 * Read a document the verb was pointed at, as a value.
 *
 * The read happens here rather than in the verb so a verb stays a pure function of its
 * dependencies: a test hands it the bytes, and a failed read is a value the verb branches on rather
 * than an exception it has to catch.
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

const sessionArg = Argument.integer("session").pipe(
	Argument.withDescription("the session issue number"),
);

const questionArg = Argument.string("question").pipe(
	Argument.withDescription("the question id, R<round>.<n>"),
);

const open = leafCommand(
	"open",
	{
		topic: Flag.string("topic").pipe(
			Flag.withDescription(
				"the subject of the session; becomes the issue title and is matched against open grilling:session titles to resume rather than mint a duplicate",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({topic, repo}) {
		yield* emit(yield* runOpen({topic, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'Open, or resume, the session issue for a topic. Prints {"session":n,"topic":"…","created":true|false,"url":"…"}. Topic matching is exact under NFC + case folding + whitespace collapse, never fuzzy. Exits 5 (machine-local path in --topic), 6 (bare @ reference), 7 (the grilling:session label does not exist), 8 (the create or the label write failed — UNKNOWN), 9 (read-back mismatch), 11 (the search could not complete, so "none" is unproven), 16 (more than one open session matches). Example: fabrika grill open --topic "sozluk moderation model"',
	),
);

const round = leafCommand(
	"round",
	{
		session: sessionArg,
		supersedes: Flag.string("supersedes").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a question id this round replaces; the named question is retired and stops holding the frontier",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({session, supersedes, repo}) {
		yield* emit(
			yield* runRound({
				session,
				supersedes,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Validate one round read from STDIN against the grammar, post it, and print {"session":n,"round":n,"digest":"…","questions":[…],"supersedes":[…],"comment":n,"supersedeComment":n|null}. The round number is derived, never supplied. Exits 3 (empty stdin), 4 (grammar), 5 (machine-local path), 6 (bare @ reference), 7 (no such session), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 11 (the existing rounds could not be read), 13 (--supersedes names no question), 14 (the round holding a superseded question could not be digested), 18 (already superseded). Example: fabrika grill round 9412 --supersedes R1.4 < round.md',
	),
);

const answerCmd = leafCommand(
	"answer",
	{
		session: sessionArg,
		question: questionArg,
		finding: Flag.string("finding").pipe(
			Flag.withDescription("a file holding the established answer and the evidence it rests on"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({session, question, finding, repo}) {
		yield* emit(
			yield* runAnswer({
				session,
				question,
				findingPath: finding,
				finding: document(finding),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Record an agent-established answer to a fact question. Prints {"session":n,"question":"R2.1","kind":"fact","comment":n,"recordedAs":"agent"}. Exits 4 (--finding is empty), 5 (machine-local path), 6 (bare @ reference), 7 (no such session), 8 (the write failed — UNKNOWN), 9 (read-back mismatch), 11 (the rounds could not be read), 13 (the id names no question), 14 (the round could not be digested), 17 (the id is a decision question), 18 (superseded). Example: fabrika grill answer 9412 R2.1 --finding finding.md',
	),
);

const rule = leafCommand(
	"rule",
	{
		session: sessionArg,
		question: questionArg,
		authorization: Flag.string("authorization").pipe(
			Flag.withDescription(
				"a file quoting the founder's authorization verbatim, carrying an ISO-8601 date; posted as an adjacent comment, never summarized",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({session, question, authorization, repo}) {
		yield* emit(
			yield* runRule({
				session,
				question,
				authorizationPath: authorization,
				authorization: document(authorization),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Record a founder ruling, refusing without a verbatim dated authorization. Writes the authorization comment FIRST and the marker second, then prints {"session":n,"question":"R2.3","digest":"…","authorization":n,"marker":n,"resolvesTo":"ruled"}. Exits 5 (machine-local path), 6 (bare @ reference), 7 (no such session), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed), 12 (the invoking token is below write), 13 (the id names no question), 14 (the round could not be digested), 15 (--authorization missing, empty or undated), 17 (the id is a fact question), 18 (superseded). Example: fabrika grill rule 9412 R2.3 --authorization authorization.md',
	),
);

const read = leafCommand(
	"read",
	{session: sessionArg, repo: repoFlag},
	Effect.fn(function* ({session, repo}) {
		yield* emit(yield* runRead({session, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'Read the whole session state: {"session":n,"frontier":"awaiting-founder|facts-pending|clear|empty","questions":[…],"disregarded":[…],"counts":{…},"scanned":{…}}. All four frontier tokens exit 0 — an open frontier is this skill working. Never refuses on marker content: a malformed, unauthorized or unbindable marker is a disregarded row at exit 0. Exits 7 (no such session), 11 (a comment or permission read could not complete, so every state is UNKNOWN). Example: fabrika grill read 9412',
	),
);

export const grillCommand = Command.make("grill").pipe(
	Command.withSubcommands([open, round, answerCmd, rule, read]),
	Command.withDescription(
		"Run a grilling session on a GitHub issue: post rounds of fact and decision questions, record agent-established answers and founder rulings against them, and read back the frontier — every recorded ruling bound to an authority and to the round text it ruled",
	),
);
