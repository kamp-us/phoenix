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

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runRule} from "./rule-verb.ts";
import {runRuling} from "./ruling-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

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
			Flag.withDescription(
				"the issue-comment URL the ruling is written in, checked against this repository and this issue and carried in the marker so a builder reads the ruling rather than inferring it",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, cites, repo}) {
		yield* emit(
			yield* runRule({
				number,
				cites,
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
		'Record a control-plane human\'s ruling on one type:decision issue: post a decision-ruled marker bound to a digest this verb derives itself over the issue body, read it back, and ONLY THEN flip the audience from ready-for:human to ready-for:agent, reported from a re-read rather than asserted. Prints {"answer":"ruled","issue":n,"digest":"…","ruling":"…","by":"…","at":"…","comment":n,"audience":"ready-for:agent","observed":[…]}. There is no --digest flag: a ruling whose scope its caller supplies attests whatever the caller pleased. Exits 1 (--cites is not an issue-comment URL for this repository and issue), 7 (the issue is absent, is a pull request, is not a type:decision, the cited comment is not on it, or ready-for:agent is absent from the repository taxonomy), 8 (a write failed, or the issue could not be re-read — UNKNOWN), 9 (the marker or the audience does not read back), 11 (the roster, the comments or the invoking account could not be read — authority is UNKNOWN, never granted), 20 (proven: the invoking account is off the control-plane roster, or that roster names nobody). Example: fabrika decision rule 6569 --cites https://github.com/kamp-us/phoenix/issues/6569#issuecomment-3512345',
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
