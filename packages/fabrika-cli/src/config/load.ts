/**
 * One typed load of `.fabrika.jsonc`: open once, parse once, resolve every key off the same record.
 *
 * A load either produces a document every key resolves against, or is **refused** — the load-time
 * check a convention cannot hold, since a config can edit its own governed-path list and un-govern
 * itself. A refusal names the key that raised it and no key's value is used.
 *
 * An unreadable file is not a refusal: it is carried into the document state so every key resolves
 * UNKNOWN and each caller refuses in its own vocabulary. Collapsing "nobody wrote a config" into
 * "nobody could read the config" is the failure this whole surface exists to keep apart.
 */

import {type ConfigSource, type DocumentState, readDocument} from "./document.ts";
import {type KeyGroup, type Resolution, resolveKey} from "./key-group.ts";
import {KEY_GROUPS} from "./registry.ts";

export type Load =
	| {readonly _tag: "Config"; readonly state: DocumentState}
	| {readonly _tag: "Refused"; readonly reason: string};

export const loadConfig = (source: ConfigSource): Load => {
	const state = readDocument(source);
	for (const group of KEY_GROUPS) {
		const refusal = group.loadRefusal(state);
		if (refusal !== null) return {_tag: "Refused", reason: refusal};
	}
	return {_tag: "Config", state};
};

/**
 * One key's value off a completed load.
 *
 * A refused load resolves **every** key as malformed carrying the refusal's reason — refused is a
 * document-level malformity, like a file that is not a JSON object, and no caller may read a value
 * out of a config that was refused.
 */
export const resolve = <A>(load: Load, group: KeyGroup<A>): Resolution<A> =>
	load._tag === "Refused"
		? {_tag: "Malformed", reason: load.reason}
		: resolveKey(load.state, group);

/** One key's resolution, carried with its key so a reader over the whole registry can name it. */
export interface Resolved {
	readonly key: string;
	readonly resolution: Resolution<unknown>;
}

/**
 * Every registered key off one load, in registry order.
 *
 * The readout verb reads the surface, not a key: it has no static type to resolve against, so it
 * goes through the registry's erased `readout` and gets the same four arms {@link resolve} does —
 * including a refused load's "every key is malformed", which stays stated once, here.
 */
export const resolveAll = (load: Load): ReadonlyArray<Resolved> =>
	KEY_GROUPS.map((group) => ({
		key: group.key,
		resolution:
			load._tag === "Refused"
				? ({_tag: "Malformed", reason: load.reason} as const)
				: group.readout(load.state),
	}));
