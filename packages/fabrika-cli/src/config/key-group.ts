/**
 * One key group: a key, its shipped default, whether one machine may declare it, and how it decodes
 * a declared value.
 *
 * A key group knows nothing about files. It is handed the already-parsed documents, which is what
 * lets a load open the bytes once and what keeps a new key to one module plus one registry line.
 *
 * The four resolution arms stay distinguishable in the type on purpose. `Default` and `Unknown` are
 * the pair the whole surface turns on: an absent file is a repo that declared nothing, an unreadable
 * one is a repo whose declaration nobody has read, and collapsing them is how a settings file
 * silently disables a gate.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {CONFIG_PATH, type ConfigLayer, type DocumentState, type Documents} from "./document.ts";
import type {JsonSchema} from "./json-schema.ts";

export type Resolution<A> =
	/** A file declared this key and the value decoded, in the layer named. */
	| {readonly _tag: "Declared"; readonly value: A; readonly layer: ConfigLayer}
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
	/**
	 * What an absent file and an absent key both resolve to. Never a value that lets a gate pass on
	 * less than it should — for a gate's scope that rules out an empty list; for a list of commands a
	 * verb must run, empty is the strict arm, because nothing to run refuses rather than greens.
	 */
	readonly shippedDefault: A;
	/**
	 * `true` when one machine may declare this key in `.fabrika.local.jsonc`, absent otherwise.
	 *
	 * Absent is the answer for every key but one. Eligibility is opt-in in code beside the default
	 * and the decoder, so admitting a key is one registry-visible change with a test rather than a
	 * convention, and `laneConcurrencyCap` is the whole allow-list — a seat count is a property of
	 * the laptop holding the seats. A key naming who may act, a key naming a gate's scope or its
	 * exemptions, and a key naming a command fabrika spawns are permanently barred: a local layer
	 * over one of those is an untracked, invisible way to weaken a gate.
	 */
	readonly machineLocal?: true;
	/** Decode a present value. Refuse the whole value rather than skipping a bad entry. */
	readonly decode: (raw: unknown) => Decoded<A>;
	/**
	 * A refusal this key alone can raise over the whole load, or `null`. It exists for the one rule
	 * a convention cannot hold: a config that edits its own governed-path list can un-govern itself,
	 * so the check has to run before any key's value is used.
	 *
	 * Declaring this also makes the key's *own* malformity a load refusal: a value that did not
	 * decode leaves the key with nothing to check, which un-governs the config exactly like a value
	 * this function rejects. {@link register} raises that arm; this function only ever sees a value.
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
	/**
	 * The JSON Schema fragment describing a declared value's shape, single-sourced beside this
	 * key's {@link KeyGroup.decode}. `config schema` assembles the registry's fragments into the one
	 * document an editor validates `.fabrika.jsonc` against, and the machine-local subset into the
	 * one that validates `.fabrika.local.jsonc`.
	 *
	 * Optional on the type, required in practice: the assembler refuses a registry with any key
	 * missing a fragment, so the emitted schema can never silently green a typo under a key it
	 * forgot. A fragment describes the *declared* shape only — that a key is absent-optional is the
	 * document's rule, not each fragment's.
	 */
	readonly jsonSchema?: JsonSchema;
}

/**
 * This key's value in the machine-local layer, or `null` when that layer has nothing to say.
 *
 * `null` is the fall-through to the tracked layer, and exactly two states reach it: no local file at
 * all, and a local file declaring some other key. **A local file that exists and could not be read,
 * or that did not parse as a JSON object, is UNKNOWN rather than a fall-through** — falling through
 * there is how a typo silently restores the repo default on a machine that declared something else.
 */
const resolveLocal = <A>(local: DocumentState, group: KeyGroup<A>): Resolution<A> | null => {
	switch (local._tag) {
		case "Unreadable":
		case "NotAnObject":
			return {_tag: "Unknown", reason: local.reason};
		case "Absent":
			return null;
		case "Record": {
			const raw = local.record[group.key];
			if (raw === undefined) return null;
			const decoded = group.decode(raw);
			return decoded._tag === "Malformed"
				? decoded
				: {_tag: "Declared", value: decoded.value, layer: "local"};
		}
	}
};

const resolveTracked = <A>(tracked: DocumentState, group: KeyGroup<A>): Resolution<A> => {
	switch (tracked._tag) {
		case "Unreadable":
			return {_tag: "Unknown", reason: tracked.reason};
		case "NotAnObject":
			return {_tag: "Malformed", reason: tracked.reason};
		case "Absent":
			return {
				_tag: "Default",
				value: group.shippedDefault,
				reason: `this repo has no ${CONFIG_PATH}`,
			};
		case "Record": {
			const raw = tracked.record[group.key];
			if (raw === undefined) {
				return {
					_tag: "Default",
					value: group.shippedDefault,
					reason: `${CONFIG_PATH} declares no \`${group.key}\``,
				};
			}
			const decoded = group.decode(raw);
			return decoded._tag === "Malformed"
				? decoded
				: {_tag: "Declared", value: decoded.value, layer: "tracked"};
		}
	}
};

/**
 * One key across both layers: local, then tracked, then the shipped default.
 *
 * Precedence is decided key by key and the winning value **replaces** the losing one whole — there
 * is no merge step here and there must never be one. Every key's decoder refuses a whole value
 * rather than skipping a bad entry, so a merged value would be one no author ever wrote and no
 * decoder ever saw as written; and an array concatenation is exactly how a local file would widen a
 * validator list or an exemption list without replacing anything.
 */
export const resolveKey = <A>(documents: Documents, group: KeyGroup<A>): Resolution<A> =>
	resolveLocal(documents.local, group) ?? resolveTracked(documents.tracked, group);

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
	/** Whether one machine may declare this key locally — the allow-list, carried erased. */
	readonly machineLocal: boolean;
	readonly resolve: (documents: Documents) => Resolution<unknown>;
	/**
	 * The same resolution with its value in the shape a repo writes — what a readout prints.
	 *
	 * Kept apart from {@link Registration.resolve} rather than folded into it: a caller computing
	 * with a value needs the decoded shape, and a renderer that silently replaced it would hand
	 * logic the display form.
	 */
	readonly readout: (documents: Documents) => Resolution<unknown>;
	readonly loadRefusal: (documents: Documents) => string | null;
	/** This key's JSON Schema fragment, carried erased so `config schema` can assemble the document. */
	readonly jsonSchema?: JsonSchema;
}

/**
 * Whether the layer that produced this key's resolution was a parsed record.
 *
 * `register` needs it to tell a declared value its decoder rejected from a document-level malformity
 * nobody declared, and the declaring layer is whichever one {@link resolveKey} read the value off.
 */
const declaringState = (documents: Documents, key: string): DocumentState["_tag"] =>
	documents.local._tag === "Record" && documents.local.record[key] !== undefined
		? "Record"
		: documents.tracked._tag;

export const register = <A>(group: KeyGroup<A>): Registration => ({
	key: group.key,
	machineLocal: group.machineLocal === true,
	// Spread rather than assign: under `exactOptionalPropertyTypes` an optional field may not carry
	// an explicit `undefined`, so a key with no fragment simply omits it.
	...(group.jsonSchema !== undefined ? {jsonSchema: group.jsonSchema} : {}),
	resolve: (documents) => resolveKey(documents, group),
	readout: (documents) => {
		const resolved = resolveKey(documents, group);
		const render = group.render;
		if (render === undefined) return resolved;
		if (resolved._tag === "Declared") {
			return {_tag: "Declared", value: render(resolved.value), layer: resolved.layer};
		}
		if (resolved._tag === "Default") {
			return {_tag: "Default", value: render(resolved.value), reason: resolved.reason};
		}
		return resolved;
	},
	loadRefusal: (documents) => {
		const refuse = group.refuseLoad;
		if (refuse === undefined) return null;
		const resolved = resolveKey(documents, group);
		if (resolved._tag === "Declared" || resolved._tag === "Default") return refuse(resolved.value);
		// A declared value this key's decoder rejected refuses the load in the decoder's own words: it
		// leaves the key with nothing to check, which un-governs the config exactly like a value
		// `refuseLoad` rejects. The two document-level arms are not this key's to raise — `Unknown`
		// proves nothing about what the repo declared, and a document that is not a JSON object
		// resolves *every* key `Malformed`, so no weakened value is readable off it either way.
		return resolved._tag === "Malformed" && declaringState(documents, group.key) === "Record"
			? resolved.reason
			: null;
	},
});
