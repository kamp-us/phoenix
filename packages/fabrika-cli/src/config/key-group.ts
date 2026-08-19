/**
 * One key group: a key, its shipped default, and how it decodes a declared value.
 *
 * A key group knows nothing about files. It is handed the already-parsed record, which is what lets
 * a load open the bytes once and what keeps a new key to one module plus one registry line.
 *
 * The four resolution arms stay distinguishable in the type on purpose. `Default` and `Unknown` are
 * the pair the whole surface turns on: an absent file is a repo that declared nothing, an unreadable
 * one is a repo whose declaration nobody has read, and collapsing them is how a settings file
 * silently disables a gate.
 */

import {CONFIG_PATH, type DocumentState} from "./document.ts";

export type Resolution<A> =
	/** The repo declared this key and the value decoded. */
	| {readonly _tag: "Declared"; readonly value: A}
	/** No file, or no key: the shipped default, with the arm named. */
	| {readonly _tag: "Default"; readonly value: A; readonly reason: string}
	/** The key is present and its value is refused whole, naming what was rejected. */
	| {readonly _tag: "Malformed"; readonly reason: string}
	/** The file exists and could not be read. Never a default, never an empty set. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/** A key module's answer for a value that is present. */
export type Decoded<A> =
	| {readonly _tag: "Value"; readonly value: A}
	| {readonly _tag: "Malformed"; readonly reason: string};

export interface KeyGroup<A> {
	readonly key: string;
	/** What an absent file and an absent key both resolve to. Never an empty gate list. */
	readonly shippedDefault: A;
	/** Decode a present value. Refuse the whole value rather than skipping a bad entry. */
	readonly decode: (raw: unknown) => Decoded<A>;
	/**
	 * A refusal this key alone can raise over the whole load, or `null`. It exists for the one rule
	 * a convention cannot hold: a config that edits its own governed-path list can un-govern itself,
	 * so the check has to run before any key's value is used.
	 */
	readonly refuseLoad?: (value: A) => string | null;
	/**
	 * How a resolved value prints in a readout, when the decoded shape is not the shape a repo
	 * writes. Absent means the two are the same.
	 *
	 * `status settings` exists so a skill can ask what a key resolves to; answering
	 * `{"_tag":"User","login":"…"}` where the file says `"@…"` would hand back this package's
	 * internal shape and leave the reader to reverse it.
	 */
	readonly render?: (value: A) => unknown;
}

export const resolveKey = <A>(state: DocumentState, group: KeyGroup<A>): Resolution<A> => {
	switch (state._tag) {
		case "Unreadable":
			return {_tag: "Unknown", reason: state.reason};
		case "NotAnObject":
			return {_tag: "Malformed", reason: state.reason};
		case "Absent":
			return {
				_tag: "Default",
				value: group.shippedDefault,
				reason: `this repo has no ${CONFIG_PATH}`,
			};
		case "Record": {
			const raw = state.record[group.key];
			if (raw === undefined) {
				return {
					_tag: "Default",
					value: group.shippedDefault,
					reason: `${CONFIG_PATH} declares no \`${group.key}\``,
				};
			}
			const decoded = group.decode(raw);
			return decoded._tag === "Malformed" ? decoded : {_tag: "Declared", value: decoded.value};
		}
	}
};

/**
 * A key group with its value type erased, which is the shape the registry holds.
 *
 * The erasure is not decoration: `refuseLoad` takes the group's own value type, so a
 * `KeyGroup<ReadonlyArray<string>>` is not assignable to a `KeyGroup<unknown>` and a heterogeneous
 * array of groups cannot be typed any other way. {@link register} closes over the typed group and
 * hands the loader two functions it can call without knowing the type.
 */
export interface Registration {
	readonly key: string;
	readonly resolve: (state: DocumentState) => Resolution<unknown>;
	/**
	 * The same resolution with its value in the shape a repo writes — what a readout prints.
	 *
	 * Kept apart from {@link Registration.resolve} rather than folded into it: a caller computing
	 * with a value needs the decoded shape, and a renderer that silently replaced it would hand
	 * logic the display form.
	 */
	readonly readout: (state: DocumentState) => Resolution<unknown>;
	readonly loadRefusal: (state: DocumentState) => string | null;
}

export const register = <A>(group: KeyGroup<A>): Registration => ({
	key: group.key,
	resolve: (state) => resolveKey(state, group),
	readout: (state) => {
		const resolved = resolveKey(state, group);
		const render = group.render;
		if (render === undefined) return resolved;
		if (resolved._tag === "Declared") return {_tag: "Declared", value: render(resolved.value)};
		if (resolved._tag === "Default") {
			return {_tag: "Default", value: render(resolved.value), reason: resolved.reason};
		}
		return resolved;
	},
	loadRefusal: (state) => {
		const refuse = group.refuseLoad;
		if (refuse === undefined) return null;
		const resolved = resolveKey(state, group);
		return resolved._tag === "Declared" || resolved._tag === "Default"
			? refuse(resolved.value)
			: null;
	},
});
