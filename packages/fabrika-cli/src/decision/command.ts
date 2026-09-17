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
	Argument.withDescription("the type:decision issue"),
);

const rule = leafCommand(
	"rule",
	{
		number: issueArg,
		cites: Flag.string("cites").pipe(
			Flag.optional,
			Flag.withDescription(
				"the issue-comment URL the ruling is already written in, checked against this repository and this issue and carried in the marker so a builder reads the ruling rather than inferring it",
			),
		),
		authorization: Flag.string("authorization").pipe(
			Flag.optional,
			Flag.withDescription(
				"instead of --cites: a file quoting the founder's ruling verbatim, carrying an ISO-8601 date; posted as a comment on the issue and cited by the marker, never summarized",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, cites, authorization, repo}) {
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
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Record a founder ruling on a decision and hand it to the agent lane.",
	),
	Command.withDescription(
		'Record a control-plane human\'s ruling on one type:decision issue: post a decision-ruled marker bound to a digest this verb derives itself over the issue body, read it back, and ONLY THEN flip the audience from ready-for:human to ready-for:agent, reported from a re-read rather than asserted. Exactly one flag names the ruling: --cites <url> when it is already a comment on the issue, or --authorization <file> when the founder gave it in conversation — that file is posted verbatim as a dated comment FIRST and the marker cites it, which is grill rule\'s shape, so a ruling he already made costs him no comment to type. Prints {"answer":"ruled","issue":n,"digest":"…","ruling":"…","by":"…","at":"…","comment":n,"audience":"ready-for:agent","observed":[…]}. The marker is unconditional and the flip is not: a body carrying no readable ### Acceptance criteria block keeps its marker and stays on ready-for:human, because ready-for:agent promises a builder can grade it cold. Exits 1 (neither flag or both given, --cites is not an issue-comment URL for this repository and issue, or --authorization could not be read), 4 (the marker stands but the body carries no readable acceptance-criteria block, so the audience was not flipped — author or repair it with fabrika triage enrich/repair-criteria and re-run), 5 (the quoted authorization carries a machine-local path), 6 (it is a bare @ path reference), 7 (the issue is absent, is a pull request, is not a type:decision, the cited comment is not on it, or ready-for:agent is absent from the repository taxonomy), 8 (a write failed, or the issue could not be re-read — UNKNOWN), 9 (the marker or the audience does not read back), 11 (the roster, the comments or the invoking account could not be read — authority is UNKNOWN, never granted), 20 (proven: the invoking account is off the control-plane roster, or that roster names nobody), 21 (the quoted authorization is empty or carries no ISO-8601 date). Example: fabrika decision rule 9412 --authorization ruling.md',
	),
);

const ruling = leafCommand(
	"ruling",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runRuling({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Whether a decision carries a current founder ruling."),
	Command.withDescription(
		'Report whether a decision issue carries a current founder ruling: {"answer":"ruling","issue":n,"state":"current|stale|absent","by":…,"markerDigest":…,"derivedDigest":"…","ruling":…,"at":…,"comment":…,"audience":…,"disregarded":n,"unauthorized":n}. All three states exit 0 — a missing ruling is the answer, not a refusal. A marker whose author is off the control-plane roster is counted unauthorized and never stands; a drifted one is counted disregarded rather than dropped. Exits 1 (not an issue number, or no target repo), 7 (the issue is absent, is a pull request, or is not a type:decision), 11 (the roster or the comments could not be read — the state is UNKNOWN, not absent). Example: fabrika decision ruling 6569',
	),
);

export const decisionCommand = Command.make("decision").pipe(
	Command.withSubcommands([rule, ruling]),
	Command.withShortDescription("Record and read founder rulings on type:decision issues."),
	Command.withDescription(
		"Record and read founder rulings on type:decision issues: a control-plane human's ruling becomes a marker comment bound to the issue body it ruled on, and that proven marker — never intent — is what flips the issue from ready-for:human to ready-for:agent so the normal build lane picks it up",
	),
);
