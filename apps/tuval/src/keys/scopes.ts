/**
 * Which key table answers a key, by what has focus (#9687, ruling #9668 R4.2), like vim modes and
 * tmux key tables. A key table is its focus's owner's: the board is the desk's and the global
 * config's; a window is its program's owner's, so a project program's window runs that project's
 * bindings, and a global program's window — a harness session, whichever project folder it started
 * in — runs the global config's. A project's bindings never answer on the board or in another
 * owner's window.
 *
 * Every table reads in one order: the desk's reserved keys (`./reserved.ts`), which no owner can
 * shadow, then the owner's own bindings, then the rest of the shell's chords.
 */

import {
	type Binding,
	type BindingError,
	type BindingSource,
	compileBindings,
} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import type {RegistryTable} from "@kampus/tuval-sdk/kernel/commands/registry";
import {scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import type {CommandName, PrefixTable} from "@kampus/tuval-ui/keys";
import {Effect} from "effect";
import {keyOf, type ReservedAction, ReservedDeskKeys} from "./reserved.ts";

/** What has focus: the board, or a window over a process of `program`. */
export type Focus = {readonly _tag: "Board"} | {readonly _tag: "Window"; readonly program: string};

export const boardFocus: Focus = {_tag: "Board"};

export const windowFocus = (program: string): Focus => ({_tag: "Window", program});

/** Whose bindings a focus runs: the global config's, or one open project's. */
export type KeyOwner = {readonly _tag: "Global"} | {readonly _tag: "Project"; readonly key: string};

/** What a key does under a focus. */
export type KeyAction =
	| {readonly _tag: "Reserved"; readonly action: ReservedAction}
	| {readonly _tag: "Bound"; readonly owner: KeyOwner; readonly binding: Binding}
	| {readonly _tag: "Chord"; readonly command: CommandName};

export interface KeyScopesInput {
	/** The grammar the desk's shell routes. */
	readonly desk: PrefixTable;
	/** The global config's compiled bindings. */
	readonly global: ReadonlyArray<Binding>;
	/** Each open project's compiled bindings, by project key. */
	readonly projects: ReadonlyMap<string, ReadonlyArray<Binding>>;
}

const globalOwner: KeyOwner = {_tag: "Global"};

/** One owner's bindings by key; the later binding for a key wins, as the config layers read. */
const byKey = (bindings: ReadonlyArray<Binding>): ReadonlyMap<string, Binding> =>
	new Map(bindings.map((binding) => [keyOf(binding.key) ?? binding.key, binding]));

export class KeyScopes {
	readonly reserved: ReservedDeskKeys;
	private readonly chords: ReadonlyMap<string, CommandName>;
	private readonly global: ReadonlyMap<string, Binding>;
	private readonly projects: ReadonlyMap<string, ReadonlyMap<string, Binding>>;

	private constructor(input: KeyScopesInput) {
		this.reserved = ReservedDeskKeys.of(input.desk);
		const chords = new Map<string, CommandName>();
		for (const binding of input.desk.bindings) {
			const key = keyOf(`${input.desk.prefix}${binding.sequence}`);
			if (key !== undefined) chords.set(key, binding.command);
		}
		this.chords = chords;
		this.global = byKey(input.global);
		this.projects = new Map(
			[...input.projects].map(([key, bindings]) => [key, byKey(bindings)] as const),
		);
	}

	static of(input: KeyScopesInput): KeyScopes {
		return new KeyScopes(input);
	}

	/**
	 * Whose bindings `focus` runs. A window's owner is its program's scope, so a global program's
	 * window is the global config's wherever its process runs.
	 */
	ownerOf(focus: Focus): KeyOwner {
		if (focus._tag === "Board") return globalOwner;
		const {scope} = scopedIdParts(focus.program);
		return scope === undefined ? globalOwner : {_tag: "Project", key: scope};
	}

	private bindingsOf(owner: KeyOwner): ReadonlyMap<string, Binding> {
		// A project that closed while one of its windows is still stopping owns no bindings any more.
		return owner._tag === "Global" ? this.global : (this.projects.get(owner.key) ?? new Map());
	}

	/** What `key` does under `focus`, or `undefined` when nothing there binds it. */
	route(focus: Focus, key: string): KeyAction | undefined {
		const reserved = this.reserved.actionOf(key);
		if (reserved !== undefined) return {_tag: "Reserved", action: reserved};
		const normalized = keyOf(key) ?? key;
		const owner = this.ownerOf(focus);
		const binding = this.bindingsOf(owner).get(normalized);
		if (binding !== undefined) return {_tag: "Bound", owner, binding};
		const command = this.chords.get(normalized);
		return command === undefined ? undefined : {_tag: "Chord", command};
	}
}

/** One owner's key sources, as the config generation keeps them apart. */
export interface OwnerKeys {
	readonly global: ReadonlyArray<BindingSource>;
	readonly projects: ReadonlyArray<{
		readonly key: string;
		readonly sources: ReadonlyArray<BindingSource>;
	}>;
}

/** In layer order, so the errors read in the order the sources do. */
const compileAll = (sources: ReadonlyArray<BindingSource>, table: RegistryTable) =>
	Effect.map(
		Effect.forEach(sources, (source) => compileBindings(source, table), {concurrency: 1}),
		(compiled) => ({
			bindings: compiled.flatMap((one) => one.bindings),
			errors: compiled.flatMap((one) => one.errors),
		}),
	);

/**
 * Every owner's bindings compiled against `table`, as the key scopes they route through. A binding
 * that does not compile costs its own key, as `compileBindings` rules, and is answered beside them.
 */
export const compileKeyScopes = Effect.fn("Tuval.compileKeyScopes")(function* (
	desk: PrefixTable,
	owners: OwnerKeys,
	table: RegistryTable,
) {
	const global = yield* compileAll(owners.global, table);
	const projects = yield* Effect.forEach(
		owners.projects,
		(project) =>
			Effect.map(compileAll(project.sources, table), (compiled) => ({key: project.key, compiled})),
		{concurrency: 1},
	);
	const errors: ReadonlyArray<BindingError> = [
		...global.errors,
		...projects.flatMap((project) => project.compiled.errors),
	];
	return {
		scopes: KeyScopes.of({
			desk,
			global: global.bindings,
			projects: new Map(projects.map((project) => [project.key, project.compiled.bindings])),
		}),
		errors,
	};
});
