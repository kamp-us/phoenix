/**
 * The `hook` verb group — `fabrika hook <verb>`.
 *
 * The adapter and nothing else: it declares the flags, runs the pure verb, and emits its outcome.
 * Every decision lives in `envelope.ts` / `check-verb.ts` beside it, which is what makes each refusal
 * testable without spawning a process.
 *
 * This group is what `claude-plugins/fabrika/hooks.json` declares against, so its verb names are part
 * of a committed hook declaration: renaming one is a change to the hook surface, not a refactor.
 */
import {Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit as emitOutcome} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runCheck} from "./check-verb.ts";
import {runCodes} from "./codes-verb.ts";
import {runSpawn} from "./spawn-verb.ts";

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const check = leafCommand(
	"check",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emitOutcome(yield* runCheck({json, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription("Whether the hook envelope on stdin is one fabrika can read."),
	Command.withDescription(
		"Say whether the harness hook envelope on STDIN is one fabrika can read. Stdout is the single line `conforms\\t<hook_event_name>\\t<field-count>`. The bytes judged are on stderr on every path. Exits 3 (stdin was read and held nothing), 12 (bytes arrived and are provably not a hook envelope), 13 (fd 0 could not be read — UNKNOWN, never malformed). Example: fabrika hook check",
	),
);

const spawn = leafCommand(
	"spawn",
	{},
	Effect.fn(function* () {
		yield* emitOutcome(
			yield* runSpawn({
				stdin: Effect.sync(readStdin),
				// The one env read in the group. It configures the decision; it locates nothing
				// (cli-interface-convention rule 5), and an absent value is a decided branch, not a failure.
				pin: process.env.WORKFLOW_MODEL ?? null,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether the spawn on stdin may use the model it asked for."),
	Command.withDescription(
		"Decide whether the subagent spawn on STDIN may run on the model it asked for. Stdout is the PreToolUse permission-decision object, whose systemMessage names the allowlist, the requested model, its canonical id and the resolved pin. An off-allowlist model is denied (ADR 0092). Exits 3 (stdin held nothing), 12 (not a hook envelope), 13 (fd 0 unreadable — UNKNOWN), 14 (a harness event this verb does not judge). Example: fabrika hook spawn",
	),
);

const codes = leafCommand(
	"codes",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emitOutcome(runCodes({json}));
	}),
).pipe(
	Command.withShortDescription("Print the exit taxonomy this group allocates from."),
	Command.withDescription(
		"Print the exit taxonomy every verb in this group allocates from. Stdout is one `<code>\\t<meaning>` line per code. Reads nothing and always exits 0. Example: fabrika hook codes",
	),
);

export const hookCommand = Command.make("hook").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		check,
		codes,
		spawn,
	]),
	Command.withShortDescription("Own fabrika's Claude Code hook surface."),
	Command.withDescription(
		"Own fabrika's Claude Code hook surface — read the harness envelope a hook is handed on stdin and say whether it is one fabrika can act on",
	),
);
