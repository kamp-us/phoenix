/**
 * The `decision` verb group — `fabrika decision <rule|ruling>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision the
 * verbs make lives in the `*-verb.ts` modules beside it, which is what makes each refusal testable
 * without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */

import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import type {AuthorizationDocument} from "../authorization.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readFile} from "../io/fs.ts";
import {readBoard} from "../status/label-remedy.ts";
import {FAILED, refuse} from "../verb.ts";
import {type RulingSource, runRule} from "./rule-verb.ts";
import {runRuling} from "./ruling-verb.ts";

/**
 * Read the quoted authorization the verb was pointed at, as a value.
 *
 * The read happens here rather than in the verb so a verb stays a pure function of its dependencies:
 * a test hands it the bytes, and a failed read is a value the verb branches on rather than an
 * exception it has to catch.
 */
const document = (
	path: string,
): Effect.Effect<AuthorizationDocument, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const read = yield* Effect.result(readFile(path));
		return Result.isFailure(read)
			? ({_tag: "Failed", reason: read.failure.reason} satisfies AuthorizationDocument)
			: ({_tag: "Text", text: read.success} satisfies AuthorizationDocument);
	});

/**
 * Which of the two shapes the invocation gave, refusing both and neither at the flags.
 *
 * The verb takes one `RulingSource`, so an invocation that names both authorities or none has to be
 * refused here — passing an ambiguity down would make the verb pick, and picking is how a ruling
 * comes to cite a comment nobody meant.
 */
const rulingSource = (
	cites: Option.Option<string>,
	authorization: Option.Option<string>,
): RulingSource<FileSystem.FileSystem> | null => {
	const citedUrl = Option.getOrNull(cites);
	const path = Option.getOrNull(authorization);
	if (citedUrl !== null && path !== null) return null;
	if (citedUrl !== null) return {_tag: "Cited", cites: citedUrl};
	if (path !== null) {
		return {_tag: "Quoted", authorizationPath: path, authorization: document(path)};
	}
	return null;
};

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const issueArg = Argument.integer("number").pipe(
	Argument.withDescription("the issue the ruling is recorded on"),
);

const rule = leafCommand(
	"rule",
	{
		number: issueArg,
		cites: Flag.string("cites").pipe(
			Flag.optional,
			Flag.withDescription(
				"the issue-comment URL the ruling is already written in, checked against this repository and this issue; pass exactly one of --cites and --authorization",
			),
		),
		authorization: Flag.string("authorization").pipe(
			Flag.optional,
			Flag.withDescription(
				"instead of --cites: a file quoting the ruling verbatim, carrying an ISO-8601 date; posted as a comment on the issue and cited by the marker, never summarized",
			),
		),
		supersedes: Flag.integer("supersedes").pipe(
			Flag.optional,
			Flag.withDescription(
				"the 1-based position of the body acceptance criterion this ruling replaces; the graded set then reports that row as superseded instead of grading it",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, cites, authorization, supersedes, repo}) {
		const ruling = rulingSource(cites, authorization);
		if (ruling === null) {
			yield* emit(
				refuse(
					FAILED,
					"decision rule: pass exactly one of --cites <url> (the ruling is already a comment) or --authorization <file> (it was given in conversation); nothing was written.",
				),
			);
			return;
		}
		yield* emit(
			yield* runRule({
				number,
				ruling,
				supersedes: Option.getOrNull(supersedes),
				repo: Option.getOrNull(repo),
				env: process.env,
				board: yield* readBoard(process.cwd()),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record a control-plane account's ruling so every gate grades it."),
	Command.withDescription(
		[
			"Posts a ruling marker and flips the issue to ready-for:agent; a type:epic is never flipped.",
			"  4: marker posted, no criteria block, not flipped",
			"  5: a machine-local path in the authorization",
			"  6: the authorization is a bare @ reference",
			"  7: the issue, comment or ready-for:agent label is absent",
			"  8: a write or re-read failed (UNKNOWN)",
			"  9: the marker or audience does not read back",
			"  11: an authority read failed (UNKNOWN)",
			"  20: the account is off the control-plane roster",
			"  21: the authorization is empty or undated",
			'  Derivation: claude-plugins/fabrika/docs/wire-formats.md, "decision-ruling"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika decision rule 9412 --authorization ruling.md --supersedes 3"},
	]),
);

const ruling = leafCommand(
	"ruling",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runRuling({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Whether an issue carries a current founder ruling."),
	Command.withDescription(
		[
			'Prints {"answer":"ruling","state":"current|stale|absent",…} for the newest ruling marker.',
			"  7: the issue is absent or is a pull request",
			"  11: the roster or comments are unreadable (UNKNOWN)",
			'  Derivation: claude-plugins/fabrika/docs/wire-formats.md, "decision-ruling"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika decision ruling 6569"}]),
);

export const decisionCommand = Command.make("decision").pipe(
	Command.withSubcommands([rule, ruling]),
	Command.withShortDescription("Record and read founder rulings on issues."),
	Command.withDescription(
		"Record and read founder rulings on issues: a control-plane human's ruling becomes a marker comment bound to the issue body it ruled on, and that proven marker — never intent — is what `review criteria` folds into the graded set, what `lane prove` dates a verdict against, and — on every type but an epic — what flips a parked issue from ready-for:human to ready-for:agent so the normal build lane picks it up",
	),
);
