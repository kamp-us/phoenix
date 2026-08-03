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
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runApply} from "./apply-verb.ts";
import {runCodes} from "./codes-verb.ts";
import {AUDIENCES, PRIORITIES, STANDING_LANES, TYPES} from "./facets.ts";
import {runPark} from "./park-verb.ts";
import {runSplit} from "./split-verb.ts";

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

/**
 * The child body arrives on **stdin only**. There is deliberately no `--body` and no `--body-file`: a
 * flag that takes a path turns the body into a string the verb could post verbatim, which is how a
 * machine-local path reaches a public issue while the poster reads success. A shell redirect is
 * expected — the *shell* reads the file, so what reaches the verb is already bytes.
 */
const split = leafCommand(
	"split",
	{
		parent: Argument.integer("parent").pipe(
			Argument.withDescription("the parent issue this unit is split from"),
		),
		title: Flag.string("title").pipe(
			Flag.withDescription("the child's single-unit title; also half the create-once key"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({parent, title, repo, json}) {
		yield* emit(
			yield* runSplit({
				parent,
				title,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Create one child of a bundled report from the body on STDIN, exactly once, and cross-link the parent. Prints `<created|reused>\\t<number>\\t<url>`; both outcomes exit 0. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (parent absent, or the queue label does not exist), 8 (create failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed — never a silent create). Example: fabrika triage split 4312 --title "Editor loses focus after save" < child.md',
	),
);

/**
 * The classification flags are declared as free strings, not as CLI-level enums, so an off-vocabulary
 * value reaches the verb and is refused there on `10` with the message the contract states. A
 * parser-level rejection would seat it on `1`, fusing "you named a priority that does not exist" with
 * "the binary is broken".
 */
const issueArg = Argument.integer("issue").pipe(
	Argument.withDescription("the issue number to stamp"),
);

const apply = leafCommand(
	"apply",
	{
		issue: issueArg,
		type: Flag.string("type").pipe(
			Flag.withDescription(`the issue's type: one of ${TYPES.join(", ")}`),
		),
		priority: Flag.string("priority").pipe(
			Flag.withDescription(`the priority bucket: one of ${PRIORITIES.join(", ")}`),
		),
		readyFor: Flag.string("ready-for").pipe(
			Flag.withDescription(`who picks it up: ${AUDIENCES.join(" or ")}`),
		),
		home: Flag.integer("home").pipe(
			Flag.optional,
			Flag.withDescription("the number of an open milestone to home the issue in"),
		),
		lane: Flag.string("lane").pipe(
			Flag.optional,
			Flag.withDescription(
				`a standing lane instead of a milestone: ${STANDING_LANES.join(" or ")}`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, type, priority, readyFor, home, lane, repo, json}) {
		yield* emit(
			yield* runApply({
				issue,
				type,
				priority,
				readyFor,
				home: Option.getOrNull(home),
				lane: Option.getOrNull(lane),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Stamp the whole triaged transition — type, priority, audience, status and home — as ONE owned-facet reconcile, then read the end state back positively. Exactly one of --home / --lane. Prints `triaged\\t<n>\\t<type>\\t<priority>\\t<ready-for>\\t<home>`. Exits 7 (no such issue, or a label this run would write does not exist), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 10 (off-vocabulary value, or a non-open milestone), 11 (a precondition read failed). Example: fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47",
	),
);

const park = leafCommand(
	"park",
	{issue: issueArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(
			yield* runPark({
				issue,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Demote an issue to status:needs-info with the questions on STDIN, clearing every priced facet — type, priority, audience, lane and milestone. The comment is posted BEFORE the labels move. Prints `parked\\t<n>\\t<comment-url>`. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (no such issue, or status:needs-info does not exist), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed). Example: fabrika triage park 4290 < questions.md",
	),
);

export const triageCommand = Command.make("triage").pipe(
	Command.withSubcommands([
		// One leaf per line, so five in-flight slices append at five distinct lines rather than all
		// editing one. The comment is what keeps the formatter from collapsing the list back.
		codes,
		split,
		apply,
		park,
	]),
	Command.withDescription(
		"Take one intake-queue issue from arrival to a triaged, homed transition — or park it, split it, or close it not-planned — over reads that page and writes that are read back",
	),
);
