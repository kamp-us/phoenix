/**
 * Every named command the shell ships, in one table. This is what a key binding's name resolves
 * against, what the command line reads, and what the shell program publishes as spells — one
 * declaration, so a binding, a typed line and an agent's `spell describe` can never disagree about
 * what `window:close` is.
 *
 * The two window rows that reach outside the core — `window:open` and `window:attach` — take their
 * name, sentence and argument kind from `pickerCommands` (`../picker/intent.ts`), which is where
 * the picker declared them so the argument grammar would sit beside the handler that consumes it.
 * They are lifted here rather than re-typed, so the picker's list stays the one declaration.
 *
 * The split names carry Studio's and tmux's naming, where the word describes the divider the key
 * draws rather than the arrangement it produces: `|` is `window:split-vertical` and puts the two
 * windows *side by side*, which in this repo's layout vocabulary is `"horizontal"`
 * (`.glossary/LANGUAGE.md`, "Tuval: stack, orientation, size, zoom"). The inversion is real and
 * lives on these two rows so nothing downstream has to know about it.
 */

import {Schema} from "effect";
import type {ShellMsg} from "../core/machine.ts";
import {FOCUS_LIST_KEY} from "../keys/syntax.ts";
import type {CommandName} from "../keys/table.ts";
import type {Direction} from "../layout/index.ts";
import {type PickerCommand, pickerCommands} from "../picker/intent.ts";
import {WindowId} from "../window/index.ts";
import {
	type AnyShellCommand,
	commandName,
	commandPath,
	defineCommand,
	type ShellCommand,
} from "./row.ts";

const noParams = Schema.Struct({});

/** A window row that takes no argument and names the direction focus walks. */
const focusRow = (direction: Direction): ShellCommand<typeof noParams> =>
	defineCommand({
		path: ["window", `focus-${direction}`],
		describe: `Move focus to the window on the ${direction}.`,
		params: noParams,
		toMsg: () => ({type: "window.focusDirection", direction}),
	});

/**
 * A picker row, lifted from the picker's own declaration. The argument kind picks the parameter's
 * name and the Msg it fills, so adding a third kind to `PickerCommand` is a compile error here
 * rather than a row that quietly loses its argument.
 */
const pickerRow = (command: PickerCommand): AnyShellCommand => {
	const path = commandPath(command.name);
	if (command.argument === "program-id") {
		return defineCommand({
			path,
			describe: command.summary,
			// `session` and `cwd` are one argument in two halves, and both or neither: an open naming
			// a session is the first send on a row picked out of the session list, and a session id
			// with no folder is not something a backend can find (epic #8070, ruling 2). A typed
			// command line never fills them — the caller is the session window.
			params: Schema.Struct({
				program: Schema.NonEmptyString,
				session: Schema.optionalKey(Schema.NonEmptyString),
				cwd: Schema.optionalKey(Schema.NonEmptyString),
			}),
			toMsg: ({program, session, cwd}) => ({
				type: "window.open",
				programId: program,
				...(session === undefined || cwd === undefined ? {} : {session: {cwd, resume: session}}),
			}),
		});
	}
	if (command.argument === "process-id") {
		return defineCommand({
			path,
			describe: command.summary,
			params: Schema.Struct({process: Schema.NonEmptyString}),
			toMsg: ({process}) => ({type: "window.attach", processId: process}),
		});
	}
	// The gate the docblock promises: a third `PickerCommand.argument` kind reaches here with a type
	// the checker can no longer narrow to `never`, so it stops compiling instead of silently
	// becoming a `window.attach` parameter.
	return command.argument satisfies never;
};

/**
 * The rows every desk holds. Every name the default prefix table binds is here —
 * `bindings.unit.test.ts` fails on a binding that names a row this list does not hold — and the
 * rows a feature flag adds are declared below it rather than in a second table.
 */
export const shellCommands: ReadonlyArray<AnyShellCommand> = [
	defineCommand({
		path: ["window", "split-vertical"],
		describe: "Split the focused window with a vertical divider, side by side.",
		params: noParams,
		toMsg: () => ({type: "window.split", orientation: "horizontal"}),
	}),
	defineCommand({
		path: ["window", "split-horizontal"],
		describe: "Split the focused window with a horizontal divider, one above the other.",
		params: noParams,
		toMsg: () => ({type: "window.split", orientation: "vertical"}),
	}),
	defineCommand({
		path: ["window", "zoom"],
		describe: "Render the focused window alone, or restore the split if one is already zoomed.",
		params: noParams,
		toMsg: () => ({type: "layout.zoom"}),
	}),
	defineCommand({
		path: ["window", "close"],
		describe: "Close the focused window. The process it was showing keeps running.",
		params: noParams,
		toMsg: () => ({type: "window.close"}),
	}),
	focusRow("left"),
	focusRow("right"),
	focusRow("up"),
	focusRow("down"),
	defineCommand({
		path: ["window", "focus"],
		describe: "Move focus to the window with this id.",
		params: Schema.Struct({window: Schema.NonEmptyString}),
		toMsg: ({window}) => ({type: "window.focus", windowId: WindowId.make(window)}),
	}),
	defineCommand({
		path: ["window", "pick"],
		describe:
			"Return the focused window to the picker. The process it was showing keeps running, and the picker offers it back.",
		params: noParams,
		toMsg: () => ({type: "window.unbind"}),
	}),
	// The one row whose Msg carries a key rather than a decision. A binding names a command and a
	// command names a Msg, so nothing bound can address a window's *renderer* — where a list's focus
	// lives — and this row closes that gap by forwarding a key no keyboard can produce (#8407).
	defineCommand({
		path: ["window", "focus-list"],
		describe: "Move focus into the focused window's own list, when it draws one.",
		params: noParams,
		toMsg: () => ({type: "window.forwardKey", key: FOCUS_LIST_KEY}),
	}),
	...pickerCommands.map(pickerRow),
	defineCommand({
		path: ["workspace", "create"],
		describe: "Create a workspace and make it active.",
		params: noParams,
		toMsg: () => ({type: "workspace.create"}),
	}),
	defineCommand({
		path: ["workspace", "remove"],
		describe: "Remove the active workspace and activate the nearest one.",
		params: noParams,
		toMsg: () => ({type: "workspace.remove"}),
	}),
	defineCommand({
		path: ["workspace", "activate"],
		describe: "Make the named workspace active.",
		params: Schema.Struct({workspace: Schema.NonEmptyString}),
		toMsg: ({workspace}) => ({type: "workspace.activate", workspaceId: workspace}),
	}),
	defineCommand({
		path: ["workspace", "previous"],
		describe: "Activate the previous workspace, wrapping at the first.",
		params: noParams,
		toMsg: () => ({type: "workspace.step", direction: "previous"}),
	}),
	defineCommand({
		path: ["workspace", "next"],
		describe: "Activate the next workspace, wrapping at the last.",
		params: noParams,
		toMsg: () => ({type: "workspace.step", direction: "next"}),
	}),
	defineCommand({
		path: ["desk", "inspector-toggle"],
		describe: "Show or hide the desk inspector beside the tiling area.",
		params: noParams,
		toMsg: () => ({type: "desk.inspector.toggle"}),
	}),
	defineCommand({
		path: ["command", "open"],
		describe: "Open the command line.",
		params: noParams,
		toMsg: () => ({type: "command.open"}),
	}),
	defineCommand({
		path: ["config", "reload"],
		describe: "Re-import the config module and apply the programs and keys it declares.",
		params: noParams,
		toMsg: () => ({type: "config.reload"}),
	}),
];

/**
 * The rows a feature flag adds, one list per flag. A gated row is declared here and nowhere else,
 * so the flag decides whether the row exists at all rather than whether it does anything: with
 * `processBoard` off there is no `desk:board-toggle` to bind, to type or to publish as a spell, and
 * the desk is the one it was before the board existed (#8867).
 */
const boardCommands: ReadonlyArray<AnyShellCommand> = [
	defineCommand({
		path: ["desk", "board-toggle"],
		describe: "Show or hide the process board over the desk.",
		params: noParams,
		toMsg: () => ({type: "desk.board.toggle"}),
	}),
];

/** The flags a command row can be gated on — the shell's own read of `../../features.ts`. */
export interface ShellCommandFeatures {
	readonly processBoard: boolean;
}

/** Every flag off: the table a caller that has resolved no flags is entitled to. */
export const noShellCommandFeatures: ShellCommandFeatures = {processBoard: false};

/** The rows this desk holds: the ungated table, plus whatever each flag turned on. */
export const shellCommandsFor = (features: ShellCommandFeatures): ReadonlyArray<AnyShellCommand> =>
	features.processBoard ? [...shellCommands, ...boardCommands] : shellCommands;

/**
 * One table's lookups. Built per row set rather than once per module because the set is now a
 * function of the flags: a surface reading a name against the ungated table while the kernel routes
 * over the gated one is exactly the disagreement the single declaration above exists to prevent.
 */
export interface CommandIndex {
	readonly commands: ReadonlyArray<AnyShellCommand>;
	/** Every row's name, in table order — what a completion surface and the dangling-binding test read. */
	readonly commandNames: ReadonlyArray<CommandName>;
	/** The row a name addresses, or nothing. The name is the full colon form, `window:close`. */
	readonly commandFor: (name: CommandName | string) => AnyShellCommand | undefined;
	/**
	 * A verb as typed: the full name, else the `window:` row of that name, else the last segment when
	 * exactly one row claims it. The `window:` step is #7557's own rule — a line typed at a window's
	 * prompt is about that window, so `:open counter` is `window:open` and not `command:open` — and
	 * it is what keeps the shared segment below from making `open` unreadable.
	 */
	readonly resolveVerb: (verb: string) => AnyShellCommand | undefined;
	/** Every name a verb may be typed as, which is what a refusal's suggestion is drawn from. */
	readonly verbSpellings: ReadonlyArray<string>;
	/**
	 * The Msg a bound key runs, for a row that takes no argument. A row that needs one cannot be
	 * driven by a bare key sequence — there is nowhere on a binding to put the argument — so it
	 * answers `null` and the core leaves the name as a `runCommand` Cmd for a surface to open a
	 * command line over.
	 */
	readonly msgForCommandName: (name: CommandName) => ShellMsg | null;
}

const indexOf = (commands: ReadonlyArray<AnyShellCommand>): CommandIndex => {
	const byName = new Map(
		commands.map((command) => [String(commandName(command.path)), command] as const),
	);
	const commandNames = commands.map((command) => commandName(command.path));
	const commandFor = (name: CommandName | string): AnyShellCommand | undefined =>
		byName.get(String(name));

	// The last segment of each row's name, when exactly one row claims it. A segment two rows share
	// is left out rather than resolved to whichever was declared first — `open` is claimed by both
	// `window:open` and `command:open`, and guessing between them would be a silent wrong window.
	const counts = new Map<string, number>();
	for (const command of commands) {
		const verb = command.path[command.path.length - 1] ?? "";
		counts.set(verb, (counts.get(verb) ?? 0) + 1);
	}
	const byBareVerb = new Map<string, AnyShellCommand>();
	for (const command of commands) {
		const verb = command.path[command.path.length - 1] ?? "";
		if (counts.get(verb) === 1) byBareVerb.set(verb, command);
	}

	return {
		commands,
		commandNames,
		commandFor,
		resolveVerb: (verb) => commandFor(verb) ?? commandFor(`window:${verb}`) ?? byBareVerb.get(verb),
		verbSpellings: [
			...new Set([
				...commandNames.map(String),
				...commands
					.filter((command) => command.path[0] === "window")
					.map((command) => command.path[command.path.length - 1] ?? ""),
				...byBareVerb.keys(),
			]),
		],
		msgForCommandName: (name) => {
			const command = commandFor(name);
			if (command === undefined) return null;
			return Object.keys(command.params.fields ?? {}).length === 0 ? command.toMsg({}) : null;
		},
	};
};

/** The lookups over the rows these flags leave standing. */
export const commandIndexFor = (features: ShellCommandFeatures): CommandIndex =>
	indexOf(shellCommandsFor(features));

/**
 * The ungated table's lookups — the default every caller that resolves no flags reads. A caller
 * that has flags reads `commandIndexFor` instead; nothing here is a second table, only this one
 * narrowed to the rows every desk holds.
 */
export const shellCommandIndex: CommandIndex = indexOf(shellCommands);

export const commandNames = shellCommandIndex.commandNames;
export const commandFor = shellCommandIndex.commandFor;
export const resolveVerb = shellCommandIndex.resolveVerb;
export const verbSpellings = shellCommandIndex.verbSpellings;
export const msgForCommandName = shellCommandIndex.msgForCommandName;
