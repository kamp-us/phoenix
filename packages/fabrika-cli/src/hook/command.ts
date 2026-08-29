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
import {runWorktreeCreate} from "./worktree-create-verb.ts";

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

const worktreeCreate = leafCommand(
	"worktree-create",
	{
		dryRun: Flag.boolean("dry-run").pipe(
			Flag.withDescription("print the path this would create, and create nothing"),
		),
	},
	Effect.fn(function* ({dryRun}) {
		yield* emitOutcome(
			yield* runWorktreeCreate({
				stdin: Effect.sync(readStdin),
				dryRun,
				env: globalThis.process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Provision the isolation worktree a WorktreeCreate envelope names."),
	Command.withDescription(
		"Create the `isolation: worktree` tree the WorktreeCreate envelope on STDIN names, with its deps installed, and print its absolute path on stdout — the path the harness adopts. Fetches the base before branching, runs `git worktree add --detach` under a PATH that resolves the toolchain so lefthook's post-checkout install runs, and refuses unless the virtual store landed. Exits 3 (stdin held nothing), 12 (not a hook envelope), 13 (fd 0 unreadable — UNKNOWN), 14 (a harness event this verb does not judge), 15 (the envelope names no creatable worktree), 16 (the base could not be fetched), 17 (`git worktree add` failed), 18 (the tree was created dep-less). Every non-zero exit blocks the spawn. Example: fabrika hook worktree-create",
	),
);

export const hookCommand = Command.make("hook").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		check,
		codes,
		worktreeCreate,
	]),
	Command.withShortDescription("Own fabrika's Claude Code hook surface."),
	Command.withDescription(
		"Own fabrika's Claude Code hook surface — read the harness envelope a hook is handed on stdin and say whether it is one fabrika can act on",
	),
);
