/**
 * Key bindings compiled from the config's command strings once at load (#7617 R1.4).
 *
 * A binding is written the way a person types it — `"window close"` — and a key router needs
 * `{path, args}`. Compiling that once at load rather than on every keystroke is what lets a
 * mistake be reported while the author is looking at the config instead of hours later under a
 * key they pressed.
 *
 * Recovery is per binding: every command that compiles becomes a `Binding`, every one that does
 * not becomes a `BindingError` and is dropped. A bad binding therefore costs its own key and
 * nothing else — the loader's whole-config fallback (`config.ts`) stays reserved for an
 * unimportable module or a top-level schema error, and this module never triggers it.
 *
 * The reading is the parser child's `parse`, so a binding is read by exactly the rules the command
 * palette reads a typed line by; the arguments are then decoded against the spell's real `params`,
 * so a binding carries the values the executor would have produced rather than token text.
 */

import {Effect, Schema} from "effect";
import {WorkspaceId} from "../../protocol/ids.ts";
import {firstSchemaIssue} from "../../protocol/issue.ts";
import {PROTOCOL_VERSION, Snapshot} from "../../protocol/messages.ts";
import {buildSpellIndex, describeExpected, parse, tokenize} from "../parse/index.ts";
import {describeSpell, lookupRow, type RegistryTable} from "../registry.ts";
import type {SpellPath} from "../spell.ts";
import {BindingError} from "./errors.ts";

/** One `keys.bindings` entry: the command alone, or the command with the flags it needs. */
export const KeyBindingInput = Schema.Union([
	Schema.String,
	Schema.Struct({
		command: Schema.String,
		/** Hold the key to fire it again — for `workspace next` and friends. */
		repeat: Schema.optionalKey(Schema.Boolean),
	}),
]);
export type KeyBindingInput = typeof KeyBindingInput.Type;

/** The `keys` block of a config module: key string to the command it fires. */
export const KeyBindings = Schema.Record(Schema.String, KeyBindingInput);
export type KeyBindings = typeof KeyBindings.Type;

/** What one config layer contributes: the name its errors are reported under, and its bindings. */
export interface BindingSource {
	/** `describeFile`'s answer — a layer name plus a relative path, never an absolute one. */
	readonly file: string;
	readonly bindings: KeyBindings;
}

/** One compiled binding, ready for the shell's key router. */
export interface Binding {
	readonly key: string;
	readonly path: SpellPath;
	/** Decoded against the spell's `params`, so a `count` is a number and not `"3"`. */
	readonly args: Readonly<Record<string, unknown>>;
	/** Present only when the config asked for it, so a plain string binding carries no flag. */
	readonly repeat?: boolean;
}

export interface CompiledBindings {
	readonly bindings: ReadonlyArray<Binding>;
	readonly errors: ReadonlyArray<BindingError>;
}

/**
 * `parse` completes against a desk snapshot because a typed line offers window and workspace
 * names as candidates. A binding is compiled with no desk in existence, and this module reads a
 * verdict rather than candidates, so it hands the parser an empty desk instead of inventing one.
 */
const NO_DESK = new Snapshot({
	type: "snapshot",
	version: PROTOCOL_VERSION,
	rev: 0,
	desk: {workspaces: {}, activeWorkspace: WorkspaceId.make("")},
	windows: {},
	processes: [],
	registry: [],
});

const normalize = (entry: KeyBindingInput): {command: string; repeat?: boolean} =>
	typeof entry === "string" ? {command: entry} : entry;

/**
 * Where a rejected argument sits on the line. The schema names the parameter, and the parser bound
 * it to a token's text, so the token carrying that text is the one to point at; a named-argument
 * token (`name=demo`) carries it after the `=`. With no parameter named, the first argument token
 * is the closest honest answer.
 */
const argumentPosition = (command: string, path: SpellPath, value: string | undefined): number => {
	const args = tokenize(command).tokens.slice(path.length);
	const hit =
		value === undefined
			? undefined
			: args.find((token) => token.text === value || token.text.endsWith(`=${value}`));
	return hit?.start ?? args[0]?.start ?? command.length;
};

const compileOne = Effect.fn("Tuval.Commands.compileBinding")(function* (
	file: string,
	key: string,
	entry: KeyBindingInput,
	table: RegistryTable,
	index: ReturnType<typeof buildSpellIndex>,
) {
	const {command, repeat} = normalize(entry);
	const refuse = (
		position: number,
		expected: string,
		didYouMean?: string,
	): {readonly error: BindingError} => ({
		error: new BindingError({
			file,
			key,
			position,
			expected,
			...(didYouMean === undefined ? {} : {didYouMean}),
		}),
	});

	const reading = parse(command, index, NO_DESK);
	if (reading._tag === "Refused") {
		return refuse(reading.position, reading.expected, reading.didYouMean);
	}
	if (reading._tag === "Partial") {
		// A line the palette would keep taking keystrokes for is a finished binding that is missing
		// something: the parameter it still owes, or a spell it never named.
		return refuse(
			command.length,
			reading.cursorArg === undefined ? "a spell to run" : describeExpected(reading.cursorArg),
		);
	}

	const {path, args} = reading.call;
	const row = lookupRow(table, path);
	// The index is built from this table, so a completed path is registered in it.
	if (row === undefined) return refuse(0, "a registered spell");

	const decoded = yield* (
		Schema.decodeUnknownEffect(row.spell.params)(args) as Effect.Effect<
			Record<string, unknown>,
			Schema.SchemaError
		>
	).pipe(Effect.result);

	if (decoded._tag === "Failure") {
		const {expected, at} = firstSchemaIssue(decoded.failure);
		return refuse(argumentPosition(command, path, args[at]), expected);
	}

	const binding: Binding = {
		key,
		path,
		args: decoded.success,
		...(repeat === undefined ? {} : {repeat}),
	};
	return {binding};
});

/**
 * Every binding of one config layer, against the registry as it stands now. Re-run it after a
 * registry swap: a binding is only ever as valid as the table it was compiled against, so a spell
 * that went away with a reloaded config turns its binding into an error on the next compile.
 */
export const compileBindings = Effect.fn("Tuval.Commands.compileBindings")(function* (
	source: BindingSource,
	table: RegistryTable,
) {
	const index = buildSpellIndex(table.rows.map(describeSpell));
	const bindings: Array<Binding> = [];
	const errors: Array<BindingError> = [];

	for (const [key, entry] of Object.entries(source.bindings)) {
		const outcome = yield* compileOne(source.file, key, entry, table, index);
		if ("error" in outcome) errors.push(outcome.error);
		else bindings.push(outcome.binding);
	}

	return {bindings, errors} satisfies CompiledBindings;
});
