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
import {runPreBash} from "./pre-bash-verb.ts";
import {type CliEntry, runWorktreeCreate} from "./worktree-create-verb.ts";

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
		"Judge the PreToolUse Bash envelope on STDIN and refuse a command whose LEADING directory jump (`cd`, `pushd`) resolves outside the linked worktree it runs in — whatever follows it, because a program that reaches git in a child process carries no `git` token for the harness's textual check to match and has moved a shared checkout's HEAD in the field. Arms only inside a linked worktree; the primary checkout and a cwd under no repository are allowed untouched, since isolation is the operator's call. A jump whose target expands at run time is refused too — where it lands cannot be decided before it runs. THE VERDICT IS JSON ON STDOUT, NEVER AN EXIT CODE: a deny is `hookSpecificOutput.permissionDecision` at exit 0, because `2` is the harness's one blocking code and fabrika allocates it nowhere; an allow carries no decision field at all, since `allow` would bypass the operator's own permission rules. Exits 3 (stdin held nothing), 12 (not a hook envelope), 13 (fd 0 unreadable — UNKNOWN), 14 (an event or tool this verb does not judge), 19 (the cwd's working tree could not be established — the jump was NOT judged and the command proceeds). Every non-zero exit shows stderr and lets the command through. Example: fabrika hook pre-bash",
	),
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
		"Create the `isolation: worktree` tree the WorktreeCreate envelope on STDIN names, with its deps installed, and print its absolute path on stdout — the path the harness adopts. REAPS BEFORE IT PROVISIONS: it runs `fabrika build reap --execute --limit 4` as a child in the repository the envelope named, before the fetch and the add, because whatever creates a worktree is what bounds how many accumulate and the failure it prevents is a full volume refusing the add — freeing the disk after that refusal is a spawn too late. It is a child rather than a call so the sweep runs in that repository rather than in the hook's own cwd, it is bounded by --limit and by a 120s timeout so the fetch and the add still fit in the hook's 600s budget, and NOTHING IT ANSWERS CAN REFUSE THE SPAWN — a reclaimer that could block one would turn a housekeeping miss into the total stop it exists to end, so a failed or cut-off sweep is a stderr line and the provisioning proceeds. Fetches the base into a per-spawn ref and resolves it to a commit id — never the shared `FETCH_HEAD`, which a sibling spawn's fetch truncates mid-read — then runs `git worktree add --detach` at that id under a PATH that resolves the toolchain so lefthook's post-checkout install runs, and refuses unless the tree exists and its virtual store landed. The fetch and the add each recover from the two sibling-worktree faults a parallel spawn causes — a fetch reading a half-built `worktrees/<name>/HEAD`, an add reading a half-built `worktrees/<name>/commondir` — by pruning dead worktree entries and re-attempting, bounded to five attempts and up to 3s of delay per command, taking no lock; any other diagnostic refuses on the first attempt. Exits 3 (stdin held nothing), 12 (not a hook envelope), 13 (fd 0 unreadable — UNKNOWN), 14 (a harness event this verb does not judge), 15 (the envelope names no creatable worktree), 16 (the base could not be fetched), 17 (`git worktree add` failed), 18 (the tree was created dep-less). Every non-zero exit blocks the spawn. Example: fabrika hook worktree-create",
	),
);

export const hookCommand = Command.make("hook").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		check,
		codes,
		preBash,
		worktreeCreate,
	]),
	Command.withShortDescription("Own fabrika's Claude Code hook surface."),
	Command.withDescription(
		"Own fabrika's Claude Code hook surface — read the harness envelope a hook is handed on stdin and say whether it is one fabrika can act on",
	),
);
