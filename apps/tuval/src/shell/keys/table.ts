/**
 * The prefix table: which key arms the shell, and which sequence after it names which command.
 * tmux's shape, not a shell-wide mode — there is no "normal mode" here, and with the prefix
 * unarmed every key belongs to the focused window (#7547 R1.4).
 *
 * The table is plain data: a binding names a command by string, and `CommandName` is a type-only
 * brand so the command rows (#7555) and this table share one type without this slice importing
 * them. Nothing on a binding is callable — the type-level proof lives in `boundary.unit.test.ts`.
 *
 * Defaults mirror the founder's own tmux config (ruling on #7552, 2026-09-02 PT), not stock tmux:
 * `|` and `-` split, `<c-h>`/`<c-l>` walk workspaces and repeat, and `%`/`"` are unbound.
 */

import {Duration, Result, Schema} from "effect";
import {normalize, parseSequence} from "./syntax.ts";

/** The name of a command row (#7555). A plain string at runtime, a distinct type to the checker. */
export const CommandName = Schema.String.pipe(Schema.brand("tuval/CommandName"));
export type CommandName = typeof CommandName.Type;

/**
 * One binding: the key sequence typed after the prefix, and the command it names. `repeatable` is
 * tmux's `bind -r` — after the command fires the prefix stays armed for the table's
 * `repeatTimeout`, so `<c-b> <c-l> <c-l>` walks two workspaces.
 */
export interface Binding {
	readonly sequence: string;
	readonly command: CommandName;
	readonly repeatable: boolean;
}

/**
 * The whole grammar as data. Both durations are the core's to run: this module says how long an
 * armed window lasts, and firing the timer is the core's Cmd.
 */
export interface PrefixTable {
	readonly prefix: string;
	/** How long the prefix stays armed waiting for a sequence. tmux has no default; Runekeeper's buffer flush is 1s. */
	readonly armTimeout: Duration.Duration;
	/** How long a repeatable command leaves the prefix armed. tmux's `repeat-time` default. */
	readonly repeatTimeout: Duration.Duration;
	readonly bindings: ReadonlyArray<Binding>;
}

const command = (name: string): CommandName => CommandName.make(name);

/** The founder's tmux bindings. Workspaces number from 1 (tmux `base-index 1`). */
export const defaultPrefixTable: PrefixTable = {
	prefix: "<c-b>",
	armTimeout: Duration.millis(1000),
	repeatTimeout: Duration.millis(500),
	bindings: [
		{sequence: "|", command: command("window:split-vertical"), repeatable: false},
		{sequence: "-", command: command("window:split-horizontal"), repeatable: false},
		{sequence: "h", command: command("window:focus-left"), repeatable: false},
		{sequence: "j", command: command("window:focus-down"), repeatable: false},
		{sequence: "k", command: command("window:focus-up"), repeatable: false},
		{sequence: "l", command: command("window:focus-right"), repeatable: false},
		{sequence: "<arrowleft>", command: command("window:focus-left"), repeatable: false},
		{sequence: "<arrowdown>", command: command("window:focus-down"), repeatable: false},
		{sequence: "<arrowup>", command: command("window:focus-up"), repeatable: false},
		{sequence: "<arrowright>", command: command("window:focus-right"), repeatable: false},
		{sequence: "x", command: command("window:close"), repeatable: false},
		{sequence: "N", command: command("workspace:create"), repeatable: false},
		{sequence: "<c-h>", command: command("workspace:previous"), repeatable: true},
		{sequence: "<c-l>", command: command("workspace:next"), repeatable: true},
		{sequence: ":", command: command("command:open"), repeatable: false},
		{sequence: "r", command: command("config:reload"), repeatable: false},
	],
};

/** A config value naming a sequence — or a prefix — the key grammar cannot read. */
export interface UnreadableSequenceError {
	readonly _tag: "UnreadableSequenceError";
	/** The sequence as the config wrote it. */
	readonly sequence: string;
	readonly reason: string;
	readonly message: string;
}

const unreadable = (sequence: string, reason: string): UnreadableSequenceError => ({
	_tag: "UnreadableSequenceError",
	sequence,
	reason,
	message: `unreadable key sequence ${JSON.stringify(sequence)}: ${reason}`,
});

/**
 * A sequence split into its keys, each in its one spelling — `"<C-B>x"` into `["<c-b>", "x"]`.
 * Lookup compares these, so `<C-B>` and `<c-b>` are the same binding however the config spells it.
 */
export const normalizeSequence = (
	sequence: string,
): Result.Result<ReadonlyArray<string>, UnreadableSequenceError> => {
	const keys = parseSequence(sequence);
	if (keys === null || keys.length === 0 || keys[0] === "") {
		return Result.fail(unreadable(sequence, "empty sequence"));
	}
	const normalized: Array<string> = [];
	for (const key of keys) {
		const one = normalize(key);
		if (Result.isFailure(one)) return Result.fail(unreadable(sequence, one.failure.message));
		normalized.push(one.success);
	}
	return Result.succeed(normalized);
};

/**
 * What a user's config module (#7509) may say about keys. Every field is optional; a binding
 * replaces the default with the same sequence and otherwise appends, which is the merge the
 * config layers already use for program rows.
 */
export interface KeysConfig {
	readonly prefix?: string;
	readonly armTimeout?: Duration.Duration;
	readonly repeatTimeout?: Duration.Duration;
	readonly bindings?: ReadonlyArray<Binding>;
}

const sequenceKey = (sequence: string): Result.Result<string, UnreadableSequenceError> =>
	Result.map(normalizeSequence(sequence), (keys) => keys.join(""));

/**
 * The table a config asks for, or the first thing in it the key grammar cannot read. Fail-closed
 * like the config loader itself: a table is never half-applied, so the shell either runs the
 * user's whole grammar or refuses it and keeps the one it had.
 */
export const applyKeysConfig = (
	table: PrefixTable,
	config: KeysConfig,
): Result.Result<PrefixTable, UnreadableSequenceError> => {
	let prefix = table.prefix;
	if (config.prefix !== undefined) {
		const normalized = normalize(config.prefix);
		if (Result.isFailure(normalized)) {
			return Result.fail(unreadable(config.prefix, normalized.failure.message));
		}
		prefix = normalized.success;
	}

	const merged = [...table.bindings];
	for (const binding of config.bindings ?? []) {
		const key = sequenceKey(binding.sequence);
		if (Result.isFailure(key)) return Result.fail(key.failure);
		const at = merged.findIndex(
			(existing) => Result.getOrNull(sequenceKey(existing.sequence)) === key.success,
		);
		if (at === -1) merged.push(binding);
		else merged[at] = binding;
	}

	return Result.succeed({
		prefix,
		armTimeout: config.armTimeout ?? table.armTimeout,
		repeatTimeout: config.repeatTimeout ?? table.repeatTimeout,
		bindings: merged,
	});
};
