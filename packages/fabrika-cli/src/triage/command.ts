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
import {Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runCodes} from "./codes-verb.ts";

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

export const triageCommand = Command.make("triage").pipe(
	Command.withSubcommands([
		// One leaf per line, so five in-flight slices append at five distinct lines rather than all
		// editing one. The comment is what keeps the formatter from collapsing the list back.
		codes,
	]),
	Command.withDescription(
		"Take one intake-queue issue from arrival to a triaged, homed transition — or park it, split it, or close it not-planned — over reads that page and writes that are read back",
	),
);
