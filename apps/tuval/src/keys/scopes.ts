/**
 * Which key table answers a key, by what has focus (#9687, ruling #9668 R4.2), like vim modes and
 * tmux key tables. A key table is its focus's owner's: the board is the desk's and the global
 * config's; a window is its program's owner's, so a project program's window runs that project's
 * bindings, and a global program's window — a harness session, whichever project folder it started
 * in — runs the global config's. A project's bindings never answer on the board or in another
 * owner's window.
 *
 * Every table reads in one order: the desk's reserved keys (`./reserved.ts`), which no owner can
 * shadow, then the owner's own bindings, then the rest of the shell's chords. The shell core routes
 * a key over the table its focus selects (`../shell/core/machine.ts`), with the same `route` it
 * always ran, so a focus table is a prefix table and nothing new for the router to learn.
 *
 * Kept free of the SDK's runtime: the shell core imports this and the page imports the core.
 */

import type {Binding} from "@kampus/tuval-sdk/kernel/commands/bindings/compile";
import {scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {
	type Binding as ChordBinding,
	CommandName,
	idle,
	normalizeSequence,
	type PrefixState,
	type PrefixTable,
	parse,
	route,
} from "@kampus/tuval-ui/keys";
import {Result} from "effect";
import {type ReservedAction, ReservedDeskKeys} from "./reserved.ts";

/**
 * What has focus: the board, or a window. A window's `program` is the one bound to it; an empty
 * window, and one bound before windows recorded their program, has none and runs the global table.
 */
export type Focus =
	| {readonly _tag: "Board"}
	| {readonly _tag: "Window"; readonly program: string | null};

export const boardFocus: Focus = {_tag: "Board"};

export const windowFocus = (program: string | null): Focus => ({_tag: "Window", program});

/** Whose bindings a focus runs: the global config's, or one open project's. */
export type KeyOwner = {readonly _tag: "Global"} | {readonly _tag: "Project"; readonly key: string};

/** What a completed key sequence does under a focus. */
export type KeyAction =
	| {readonly _tag: "Reserved"; readonly action: ReservedAction}
	| {readonly _tag: "Bound"; readonly owner: KeyOwner; readonly binding: Binding}
	| {readonly _tag: "Chord"; readonly command: CommandName};

/** Every owner's compiled bindings, kept apart. */
export interface OwnerBindings {
	/** The global config's compiled bindings. */
	readonly global: ReadonlyArray<Binding>;
	/** Each open project's compiled bindings, by project key. */
	readonly projects: ReadonlyMap<string, ReadonlyArray<Binding>>;
}

/** No owner binds anything: what a desk runs before a config's bindings compile. */
export const noOwnerBindings: OwnerBindings = {global: [], projects: new Map()};

export interface KeyScopesInput extends OwnerBindings {
	/** The grammar the desk's shell routes. */
	readonly desk: PrefixTable;
}

const globalOwner: KeyOwner = {_tag: "Global"};

const keysOf = (sequence: string): ReadonlyArray<string> | undefined =>
	Result.match(normalizeSequence(sequence), {
		onFailure: () => undefined,
		onSuccess: (keys) => keys,
	});

/**
 * One focus owner's key table: the desk's prefix table with the owner's chords layered in, and the
 * owner's bare keys, which answer before a key would reach the focused window.
 *
 * An owner chord replaces a desk chord on the same sequence, never a reserved one: a binding on a
 * reserved key is left out here, which is the runtime half of the load-time refusal a project gets.
 * A binding whose key the grammar cannot route — unreadable, or several keys with no prefix in
 * front — is left out too, because no press can complete it.
 */
export class FocusTable {
	readonly owner: KeyOwner;
	/** The table `route` runs over under this focus. */
	readonly table: PrefixTable;
	/** Owner bindings on a bare key, by that key's one spelling. */
	private readonly bare: ReadonlyMap<string, Binding>;
	/** Owner bindings on a chord, by the one spelling of the sequence typed after the prefix. */
	private readonly chords: ReadonlyMap<string, Binding>;

	private constructor(
		owner: KeyOwner,
		table: PrefixTable,
		bare: ReadonlyMap<string, Binding>,
		chords: ReadonlyMap<string, Binding>,
	) {
		this.owner = owner;
		this.table = table;
		this.bare = bare;
		this.chords = chords;
	}

	static of(
		owner: KeyOwner,
		desk: PrefixTable,
		reserved: ReservedDeskKeys,
		bindings: ReadonlyArray<Binding>,
	): FocusTable {
		const prefix = keysOf(desk.prefix)?.[0];
		const bare = new Map<string, Binding>();
		// By the sequence after the prefix, so a later binding for one chord replaces the earlier.
		const chords = new Map<string, Binding>();
		for (const binding of bindings) {
			const keys = keysOf(binding.key);
			if (keys === undefined || reserved.actionOf(keys.join("")) !== undefined) continue;
			if (keys.length === 1) bare.set(keys.join(""), binding);
			else if (keys[0] === prefix) chords.set(keys.slice(1).join(""), binding);
		}
		const owned: ReadonlyArray<ChordBinding> = [...chords].map(([sequence, binding]) => ({
			sequence,
			command: CommandName.make(`binding:${binding.path.join(" ")}`),
			repeatable: binding.repeat === true,
		}));
		const shell = desk.bindings.filter(
			(chord) => !chords.has(keysOf(chord.sequence)?.join("") ?? chord.sequence),
		);
		return new FocusTable(owner, {...desk, bindings: [...owned, ...shell]}, bare, chords);
	}

	/** The owner's binding on `key` pressed with the prefix unarmed, in its one spelling. */
	bindingAt(key: string): Binding | undefined {
		return this.bare.get(key);
	}

	/**
	 * The owner's binding on the chord whose keys after the prefix are `pending`. `route` answering
	 * `Command` for a sequence this names is the owner's binding firing, because the table holds no
	 * desk chord on a sequence an owner bound.
	 */
	chordAt(pending: ReadonlyArray<string>): Binding | undefined {
		return this.chords.get(pending.join(""));
	}
}

export class KeyScopes {
	readonly reserved: ReservedDeskKeys;
	private readonly global: FocusTable;
	private readonly projects: ReadonlyMap<string, FocusTable>;
	/** A closed project's windows can outlive it while they stop; they get the desk's chords alone. */
	private readonly desk: PrefixTable;

	private constructor(input: KeyScopesInput) {
		this.reserved = ReservedDeskKeys.of(input.desk);
		this.desk = input.desk;
		this.global = FocusTable.of(globalOwner, input.desk, this.reserved, input.global);
		this.projects = new Map(
			[...input.projects].map(
				([key, bindings]) =>
					[
						key,
						FocusTable.of({_tag: "Project", key}, input.desk, this.reserved, bindings),
					] as const,
			),
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
		if (focus._tag === "Board" || focus.program === null) return globalOwner;
		const {scope} = scopedIdParts(focus.program);
		return scope === undefined ? globalOwner : {_tag: "Project", key: scope};
	}

	/** The key table `focus` routes over. */
	tableFor(focus: Focus): FocusTable {
		const owner = this.ownerOf(focus);
		if (owner._tag === "Global") return this.global;
		return this.projects.get(owner.key) ?? FocusTable.of(owner, this.desk, this.reserved, []);
	}

	/**
	 * What the whole sequence `key` does under `focus`, or `undefined` when nothing there binds it —
	 * the same `route` over the same table the shell core presses a key through, one key at a time.
	 */
	route(focus: Focus, key: string): KeyAction | undefined {
		const keys = keysOf(key);
		if (keys === undefined) return undefined;
		const table = this.tableFor(focus);
		let state: PrefixState = idle;
		let pressed: ReadonlyArray<string> = [];
		for (const [index, one] of keys.entries()) {
			const event = Result.getOrUndefined(parse(one));
			if (event === undefined) return undefined;
			pressed = state._tag === "Idle" ? [one] : [...pressed, one];
			const answer = route(table.table, state, event);
			state = answer.next;
			const last = index === keys.length - 1;
			if (answer._tag === "Arm" || answer._tag === "Pending") {
				if (last && answer._tag === "Arm") return {_tag: "Reserved", action: {_tag: "Prefix"}};
				continue;
			}
			if (answer._tag === "Unbound" || !last) return undefined;
			if (answer._tag === "ToWindow") {
				const binding = table.bindingAt(answer.key);
				return binding === undefined ? undefined : {_tag: "Bound", owner: table.owner, binding};
			}
			const binding = table.chordAt(pressed.slice(1));
			if (binding !== undefined) return {_tag: "Bound", owner: table.owner, binding};
			const reserved = this.reserved.actionOf(pressed.join(""));
			return reserved === undefined
				? {_tag: "Chord", command: answer.name}
				: {_tag: "Reserved", action: reserved};
		}
		return undefined;
	}
}
