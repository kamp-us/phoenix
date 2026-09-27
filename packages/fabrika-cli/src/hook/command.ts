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
import {Effect, FileSystem} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit as emitOutcome} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runClaudeSpend} from "../spend/claude/collector.ts";
import {VERSION} from "../version.ts";
import {runCheck} from "./check-verb.ts";
import {readFloorFile, runCliFloor} from "./cli-floor-verb.ts";
import {runCodes} from "./codes-verb.ts";
import {runPluginSync} from "./plugin-sync-verb.ts";
import {runPreBash} from "./pre-bash-verb.ts";
import {type CliEntry, runWorktreeCreate} from "./worktree-create-verb.ts";

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const claudeSpend = leafCommand(
	"claude-spend",
	{},
	Effect.fn(function* () {
		yield* emitOutcome(yield* runClaudeSpend({stdin: Effect.sync(readStdin), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Record Claude model and token usage from a native hook."),
	Command.withDescription(
		[
			"Records Claude model and token usage from the native hook payload on stdin.",
			"  stdout: a `systemMessage` warning when collection fails; diagnostics go to stderr",
			"  Never refuses: a collection failure is a visible warning; replay the payload to recover.",
			"  Derivation: the fabrika plugin's docs/claude-usage.md",
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook claude-spend"}]),
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
		[
			"Prints whether the harness hook envelope on stdin is one fabrika can read.",
			"  stdout: `conforms\\t<hook_event_name>\\t<field-count>`; the judged bytes go to stderr",
			"  3: stdin held nothing",
			"  12: the bytes are not a hook envelope",
			"  13: fd 0 could not be read (UNKNOWN, never malformed)",
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook check"}]),
);

const cliFloor = leafCommand(
	"cli-floor",
	{},
	Effect.fn(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* emitOutcome(
			yield* runCliFloor({
				installed: VERSION,
				env: globalThis.process.env,
				read: (path) => readFloorFile(path).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Warn when this CLI is older than the plugin's minimum version."),
	Command.withDescription(
		[
			"Warns when this CLI is older than the plugin's `cli-floor.json` minimum, as hook-output JSON.",
			"  stdout: `systemMessage` below the minimum, else `suppressOutput`; reads no stdin",
			"  23: the plugin root, floor file or a version is unreadable (UNKNOWN, never a pass)",
			"  Any non-zero exit shows stderr and lets the session start.",
			'  Derivation: the fabrika plugin\'s docs/hook-surface.md, "hook cli-floor"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook cli-floor"}]),
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
		[
			"Prints the exit taxonomy every hook verb allocates from, one `<code>\\t<meaning>` line each.",
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook codes"}]),
);

const preBash = leafCommand(
	"pre-bash",
	{},
	Effect.fn(function* () {
		yield* emitOutcome(
			yield* runPreBash({stdin: Effect.sync(readStdin), env: globalThis.process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Refuse a Bash command that jumps out of its isolated worktree."),
	Command.withDescription(
		[
			"Denies a Bash command whose leading `cd` or `pushd` leaves its linked worktree.",
			"  The verdict is hook-output JSON on stdout, never an exit code; an allow carries no decision.",
			"  3: stdin held nothing",
			"  12: not a hook envelope",
			"  13: fd 0 could not be read (UNKNOWN)",
			"  14: an event or tool this verb does not judge",
			"  19: the cwd's working tree is unknown; the jump was NOT judged",
			"  Any non-zero exit shows stderr and lets the command through.",
			'  Derivation: the fabrika plugin\'s docs/hook-surface.md, "hook pre-bash"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook pre-bash"}]),
);

/**
 * The way back into this same build of the CLI, for the sweep the provisioner runs as a child.
 *
 * `argv[1]` rather than a resolved package path: it is the entry module this process was actually
 * started from, so a checkout and an installed copy each re-enter themselves. Absent it, the sweep
 * is skipped and said so — never guessed at.
 */
const cliEntry = (): CliEntry | null => {
	const entry = globalThis.process.argv[1];
	return entry === undefined || entry.trim() === ""
		? null
		: {node: globalThis.process.execPath, entry};
};

const worktreeCreate = leafCommand(
	"worktree-create",
	{
		dryRun: Flag.boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription("print the path this would create, and create nothing"),
		),
	},
	Effect.fn(function* ({dryRun}) {
		yield* emitOutcome(
			yield* runWorktreeCreate({
				stdin: Effect.sync(readStdin),
				dryRun,
				env: globalThis.process.env,
				cli: cliEntry(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Provision the isolation worktree a WorktreeCreate envelope names."),
	Command.withDescription(
		[
			"Creates the worktree the WorktreeCreate envelope on stdin names and prints its absolute path.",
			"  It first runs `fabrika build reap`; its answer never blocks the spawn.",
			"  3: stdin held nothing",
			"  12: not a hook envelope",
			"  13: fd 0 unreadable (UNKNOWN)",
			"  14: an event this verb does not judge",
			"  15: no creatable worktree",
			"  16: the base fetch failed",
			"  17: `git worktree add` failed",
			"  18: the tree was created dep-less",
			"  24: the creation lock was not taken; nothing fetched or added",
			"  Any non-zero exit blocks the spawn.",
			'  Derivation: the fabrika plugin\'s docs/hook-surface.md, "hook worktree-create"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook worktree-create"}]),
);

const pluginSync = leafCommand(
	"plugin-sync",
	{
		dryRun: Flag.boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription("report what this would advance, and move nothing"),
		),
	},
	Effect.fn(function* ({dryRun}) {
		yield* emitOutcome(
			yield* runPluginSync({stdin: Effect.sync(readStdin), dryRun, env: globalThis.process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Advance the checkout a directory-source plugin is served from."),
	Command.withDescription(
		[
			"Fast-forwards the checkout a directory-source plugin is served from, per the envelope on stdin.",
			"  stdout: `current\\t<branch>\\t<commit>` or `advanced\\t<branch>\\t<commit>`",
			"  3: stdin held nothing",
			"  12: not a hook envelope",
			"  13: fd 0 could not be read (UNKNOWN)",
			"  14: a harness event this verb does not judge",
			"  19: no clone's primary worktree could be read",
			"  20: the checkout cannot be advanced",
			"  21: the remote could not be fetched (UNKNOWN)",
			"  22: the planned fast-forward failed",
			"  Any non-zero exit lets the session start.",
			'  Derivation: the fabrika plugin\'s docs/hook-surface.md, "hook plugin-sync"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika hook plugin-sync"}]),
);

export const hookCommand = Command.make("hook").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		check,
		claudeSpend,
		cliFloor,
		codes,
		pluginSync,
		preBash,
		worktreeCreate,
	]),
	Command.withShortDescription("Own fabrika's Claude Code hook surface."),
	Command.withDescription(
		"Own fabrika's Claude Code hook surface — read the harness envelope a hook is handed on stdin and say whether it is one fabrika can act on",
	),
);
