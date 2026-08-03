/**
 * The `triage` verb group — `fabrika triage <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives
 * in the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * This is the group's foundation slice: the shared exit table (`codes.ts`), the scanned-count
 * convention (`scope.ts`) and the GitHub reads and writes in `../io/issues.ts` land here, ahead of
 * the verbs that consume them. Later slices append their leaves below and add one line each to the
 * `withSubcommands` list at the end of the file, which is why that list is one entry per line.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runCodes} from "./codes-verb.ts";
import {DEFAULT_ROADMAP, runHomes} from "./homes-verb.ts";
import {runProvenance} from "./provenance-verb.ts";
import {DEFAULT_QUEUE_LABEL, DEFAULT_QUEUE_LIMIT, runQueue} from "./queue-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

/**
 * The two flags every verb in this group shares, declared once here.
 *
 * They are not imported from `../report/command.ts`: that module is an adapter, and a group reaching
 * into a sibling group's adapter for a flag couples their `--help` text together. The wording is
 * shared because the contract states it, not because the declaration is.
 */
export const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

export const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const codes = leafCommand(
	"codes",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emit(runCodes({json}));
	}),
).pipe(
	Command.withDescription(
		"Print the exit taxonomy every verb in this group allocates from, one `<code>\\t<meaning>` line per code. Reads nothing and always exits 0. Example: fabrika triage codes",
	),
);

const queue = leafCommand(
	"queue",
	{
		label: Flag.string("label").pipe(
			Flag.withDefault(DEFAULT_QUEUE_LABEL),
			Flag.withDescription(
				`the intake-queue label whose open issues form the queue (default: ${DEFAULT_QUEUE_LABEL})`,
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(DEFAULT_QUEUE_LIMIT),
			Flag.withDescription(`the maximum number of rows to print (default: ${DEFAULT_QUEUE_LIMIT})`),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({label, limit, repo, json}) {
		yield* emit(
			yield* runQueue({
				label,
				limit,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"List the claimable intake queue, oldest first. First stdout line is the outcome token — queued | empty — and a queued list adds one `<number>\\t<age-days>\\t<title>` line per issue; the scanned count is on stderr. Exits 7 (--label does not exist, so the queue would scan nothing), 11 (the queue read failed — UNKNOWN, never `empty`). Example: fabrika triage queue --limit 20",
	),
);

const provenance = leafCommand(
	"provenance",
	{
		issue: Argument.integer("issue").pipe(Argument.withDescription("the issue number to inspect")),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(
			yield* runProvenance({issue, repo: Option.getOrNull(repo), json, env: process.env}),
		);
	}),
).pipe(
	Command.withDescription(
		"Say whether an issue was filed by an agent or typed by a human, from the agent footer rather than the author — every report-filed issue shows the same account (ADR 0159). Prints `agent` or `human`; an empty body answers `human` fail-closed, an unreadable one refuses. Exits 7 (issue proven absent), 11 (unreadable — the provenance is UNKNOWN, never `human`). Example: fabrika triage provenance 4312",
	),
);

const homes = leafCommand(
	"homes",
	{
		roadmap: Flag.string("roadmap").pipe(
			Flag.withDefault(DEFAULT_ROADMAP),
			Flag.withDescription(
				`the roadmap file whose ## Arcs and ## Campaigns tables the open milestones join to (default: ${DEFAULT_ROADMAP})`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({roadmap, repo, json}) {
		yield* emit(yield* runHomes({roadmap, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withDescription(
		"List the assignable homes: every OPEN milestone joined to its roadmap arc/campaign row by `#<number>`, plus the two standing lanes. First stdout line is `homes`, then one `<kind>\\t<key>\\t<label>` line per candidate. Exits 7 (zero open milestones, or the roadmap parsed to 0 arc rows), 11 (the milestone list or the roadmap could not be read). Example: fabrika triage homes",
	),
);

export const triageCommand = Command.make("triage").pipe(
	Command.withSubcommands([
		// One leaf per line, so five in-flight slices append at five distinct lines rather than all
		// editing one. The comment is what keeps the formatter from collapsing the list back.
		codes,
		queue,
		provenance,
		homes,
	]),
	Command.withDescription(
		"Take one intake-queue issue from arrival to a triaged, homed transition — or park it, split it, or close it not-planned — over reads that page and writes that are read back",
	),
);
