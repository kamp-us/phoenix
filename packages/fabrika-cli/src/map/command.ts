/**
 * The `map` verb group — `fabrika map <open|read|ticket|lane|finding|fork|record|descope>`, the
 * `wayfinding` skill's half of the ideation layer.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **`--kind` and `--outcome` are declared as strings and checked in the verb.** The check is the
 * closed set's, and seating it in the verb is what lets the refusal name the whole vocabulary rather
 * than emit the parser's generic message; it still exits `1`, which is where an off-vocabulary flag
 * value belongs.
 */

import {randomBytes} from "node:crypto";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {KINDS} from "./body.ts";
import {runDescope} from "./descope-verb.ts";
import {runFinding} from "./finding-verb.ts";
import {runFork} from "./fork-verb.ts";
import {runLane} from "./lane-verb.ts";
import {OUTCOMES} from "./markers.ts";
import {runOpen} from "./open-verb.ts";
import {runRead} from "./read-verb.ts";
import {runRecord} from "./record-verb.ts";
import {runTicket} from "./ticket-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const mapArg = Argument.integer("map").pipe(
	Argument.withDescription("the map issue this verb acts on"),
);

const digestFlag = Flag.string("digest").pipe(
	Flag.withDescription(
		"the 12-lowercase-hex body digest `map read` printed; the write is refused with 12 if the body moved",
	),
);

const ticketFlag = Flag.integer("ticket").pipe(
	Flag.withDescription("the frontier ticket this verb acts on"),
);

const nonceFlag = Flag.string("nonce").pipe(
	Flag.withDescription(
		"this run's lane key, eight lowercase hex characters — generated once per run and passed explicitly, never inferred from the environment",
	),
);

const open = leafCommand(
	"open",
	{
		destination: Flag.string("destination").pipe(
			Flag.withDescription(
				"the fog to chart, as a short noun phrase; becomes the map's title and its `## Destination`",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({destination, repo}) {
		yield* emit(
			yield* runOpen({
				destination,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Mint or resume the map for a destination."),
	Command.withDescription(
		[
			"Mints or resumes a destination's map from stdin questions, one per line, and prints it as JSON.",
			"  3: stdin held no question",
			"  4: the existing map's body does not parse",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no wayfinding:map label",
			"  8: a write failed",
			"  9: the read-back differs",
			"  11: a read failed, so nothing was written",
			"  16: two or more open maps match",
			"  17: no supplied line is stated as a question",
			"  19: already recorded out of scope",
			'  Derivation: the wayfinding skill\'s contract.md, "map open"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"printf 'does a suspended account keep its weight?\\n' | fabrika map open --destination \"how moderation weight is earned\"",
		},
	]),
);

const read = leafCommand(
	"read",
	{map: mapArg, repo: repoFlag},
	Effect.fn(function* ({map, repo}) {
		yield* emit(yield* runRead({map, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("The map's whole state, section by section."),
	Command.withDescription(
		[
			"Prints the map's whole state as JSON: its sections, ticket rows, frontier token and body digest.",
			"  Every frontier token, `empty` included, is an answer.",
			"  4: the body does not hold the five sections in order",
			"  7: no such map",
			"  11: a child, edge or comment read failed, so the frontier is UNKNOWN",
			'  Derivation: the wayfinding skill\'s contract.md, "map read"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika map read 9140"}]),
);

const ticket = leafCommand(
	"ticket",
	{
		map: mapArg,
		digest: digestFlag,
		kind: Flag.string("kind").pipe(
			Flag.withDescription(`what clears this ticket: one of ${KINDS.join(", ")}`),
		),
		question: Flag.string("question").pipe(
			Flag.withDescription("the open question, stated without answering it"),
		),
		blocks: Flag.integer("blocks").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a ticket of this map that cannot proceed until this one clears; repeatable",
			),
		),
		blockedBy: Flag.integer("blocked-by").pipe(
			Flag.atLeast(0),
			Flag.withDescription("a ticket of this map this one waits on; repeatable"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({map, digest, kind, question, blocks, blockedBy, repo}) {
		yield* emit(
			yield* runTicket({
				map,
				digest,
				kind,
				question,
				blocks,
				blockedBy,
				repo: Option.getOrNull(repo),
				env: process.env,
				nonce: () => randomBytes(4).toString("hex"),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("File a frontier ticket and splice its row onto the map."),
	Command.withDescription(
		[
			"Files a frontier ticket, links it, sets its edges, splices its row onto the map and prints JSON.",
			"  4: the map body does not parse",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no such map",
			"  8: a write failed",
			"  9: the read-back differs",
			"  11: a precondition read failed",
			"  12: the body moved since --digest",
			"  13: an edge target is not a ticket of this map",
			"  14: the edge would cycle, or an id is unresolved",
			"  18: an edge target already left the frontier",
			"  19: the question restates a rejected direction",
			'  Derivation: the wayfinding skill\'s contract.md, "map ticket"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika map ticket 9140 --digest a1b2c3d4e5f6 --kind research --question "does better-auth mint a single-use token without a new table?"',
		},
	]),
);

const lane = leafCommand(
	"lane",
	{map: mapArg, ticket: ticketFlag, nonce: nonceFlag, repo: repoFlag},
	Effect.fn(function* ({map, ticket: number, nonce, repo}) {
		yield* emit(
			yield* runLane({map, ticket: number, nonce, repo: Option.getOrNull(repo), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Claim a research lane on one ticket."),
	Command.withDescription(
		[
			"Claims a research lane on one ticket, keyed on the run nonce, and prints the claim as JSON.",
			"  7: no such map",
			"  8: the claim write failed",
			"  9: the read-back differs",
			"  11: the comment read failed, so the lane's state is UNKNOWN",
			"  13: not a ticket of this map",
			"  15: another nonce holds the lane",
			"  18: the ticket already left the frontier",
			"  20: a decision ticket is routed, never researched",
			'  Derivation: the wayfinding skill\'s contract.md, "map lane"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika map lane 9140 --ticket 9143 --nonce 7f3a9c21"}]),
);

const finding = leafCommand(
	"finding",
	{
		map: mapArg,
		ticket: ticketFlag,
		nonce: nonceFlag,
		outcome: Flag.string("outcome").pipe(
			Flag.withDescription(`what the lane established: one of ${OUTCOMES.join(", ")}`),
		),
		finding: Flag.string("finding").pipe(
			Flag.optional,
			Flag.withDescription(
				"a path holding the finding; required with --outcome answered, optional otherwise",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({map, ticket: number, nonce, outcome, finding: path, repo}) {
		yield* emit(
			yield* runFinding({
				map,
				ticket: number,
				nonce,
				outcome,
				finding: Option.getOrNull(path),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Close a lane with an outcome, writing on the ticket."),
	Command.withDescription(
		[
			"Closes a lane with a closed-set outcome written on the ticket, never the map, and prints JSON.",
			"  4: answered with no --finding, or an empty finding",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no such map",
			"  8: the comment write failed",
			"  9: the read-back differs",
			"  11: a precondition read failed",
			"  13: not a ticket of this map",
			"  15: this nonce does not hold the lane",
			"  18: the ticket already left the frontier",
			"  20: a decision has no lane",
			'  Derivation: the wayfinding skill\'s contract.md, "map finding"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika map finding 9140 --ticket 9143 --nonce 7f3a9c21 --outcome no-evidence"},
	]),
);

const fork = leafCommand(
	"fork",
	{
		map: mapArg,
		digest: digestFlag,
		ticket: ticketFlag,
		session: Flag.integer("session").pipe(
			Flag.optional,
			Flag.withDescription(
				"the grilling session issue the decision now lives in; admitted only for a decision ticket",
			),
		),
		spike: Flag.integer("spike").pipe(
			Flag.optional,
			Flag.withDescription(
				"the prototyping spike issue the empirical question now lives in; admitted only for a prototype ticket",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({map, digest, ticket: number, session, spike, repo}) {
		yield* emit(
			yield* runFork({
				map,
				digest,
				ticket: number,
				session: Option.getOrNull(session),
				spike: Option.getOrNull(spike),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record that a ticket's question is being answered elsewhere."),
	Command.withDescription(
		[
			"Records that a ticket is answered in a grilling session or a spike, and prints the fork as JSON.",
			"  4: the map body does not parse",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no such map",
			"  8: a write failed",
			"  9: the read-back differs",
			"  11: a precondition read failed",
			"  12: the body moved since --digest",
			"  13: not a ticket of this map, or --session is no grilling session",
			"  18: the ticket already left the frontier",
			"  20: the ticket's kind does not admit this route",
			'  Derivation: the wayfinding skill\'s contract.md, "map fork"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika map fork 9140 --digest a1b2c3d4e5f6 --ticket 9144 --session 9301"},
	]),
);

const record = leafCommand(
	"record",
	{
		map: mapArg,
		digest: digestFlag,
		ticket: ticketFlag,
		finding: Flag.string("finding").pipe(
			Flag.withDescription("a path holding the answer, as it will read under `## Decisions`"),
		),
		ruledOn: Flag.integer("ruled-on").pipe(
			Flag.optional,
			Flag.withDescription(
				"the grilling session the ruling was recorded in; required for a forked decision",
			),
		),
		spike: Flag.integer("spike").pipe(
			Flag.optional,
			Flag.withDescription(
				"the prototyping spike whose captured decision this records; required for a forked prototype",
			),
		),
		questionId: Flag.string("question-id").pipe(
			Flag.optional,
			Flag.withDescription(
				"the question id in that session, matching R<round>.<n>; required with --ruled-on",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({
		map,
		digest,
		ticket: number,
		finding: path,
		ruledOn,
		spike,
		questionId,
		repo,
	}) {
		yield* emit(
			yield* runRecord({
				map,
				digest,
				ticket: number,
				finding: path,
				ruledOn: Option.getOrNull(ruledOn),
				spike: Option.getOrNull(spike),
				questionId: Option.getOrNull(questionId),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Land the answer and retire the ticket in one write."),
	Command.withDescription(
		[
			"Moves a ticket's answer into Decisions in one body write, closes the ticket and prints JSON.",
			"  4: the body does not parse, or --finding is empty",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no such map",
			"  8: a write failed",
			"  9: the read-back differs",
			"  11: a precondition read failed",
			"  12: the body moved since --digest",
			"  13: not a ticket of this map, or its ruling does not read ruled",
			"  18: the ticket already left the frontier",
			"  21: the lane returned unreachable, so there is no answer",
			'  Derivation: the wayfinding skill\'s contract.md, "map record"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika map record 9140 --digest a1b2c3d4e5f6 --ticket 9143 --finding finding.md"},
	]),
);

const descope = leafCommand(
	"descope",
	{
		map: mapArg,
		digest: digestFlag,
		direction: Flag.string("direction").pipe(
			Flag.withDescription("the rejected direction, as a short noun phrase"),
		),
		reason: Flag.string("reason").pipe(
			Flag.withDescription("a path holding why it was rejected; quoted onto the map verbatim"),
		),
		ticket: Flag.integer("ticket").pipe(
			Flag.optional,
			Flag.withDescription(
				"a frontier ticket this direction retires — the second exit off the frontier, for a question nobody can answer",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({map, digest, direction, reason, ticket: number, repo}) {
		yield* emit(
			yield* runDescope({
				map,
				digest,
				direction,
				reason,
				ticket: Option.getOrNull(number),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append a rejected direction to the out-of-scope section."),
	Command.withDescription(
		[
			"Appends a rejected direction to the out-of-scope section and prints the new count as JSON.",
			"  4: the body does not parse, or --reason is empty",
			"  5: a machine-local path leaked",
			"  6: a bare @ reference",
			"  7: no such map",
			"  8: the write failed",
			"  9: the read-back differs",
			"  11: a precondition read failed",
			"  12: the body moved since --digest",
			"  13: --ticket is not a ticket of this map",
			"  18: --ticket already left the frontier",
			"  19: already out of scope",
			'  Derivation: the wayfinding skill\'s contract.md, "map descope"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika map descope 9140 --digest a1b2c3d4e5f6 --direction "a per-topic weight multiplier" --reason reason.md',
		},
	]),
);

export const mapCommand = Command.make("map").pipe(
	Command.withSubcommands([open, read, ticket, lane, finding, fork, record, descope]),
	Command.withShortDescription("Chart one destination's fog into frontier tickets."),
	Command.withDescription(
		"Chart one destination's fog: mint the map, decompose it into frontier tickets with native dependency edges, run lanes under a run nonce, route decisions to grilling and empirical questions to prototyping, and record each answer in lockstep",
	),
);
