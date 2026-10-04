/**
 * One typed load of the config surface: open once, parse once, resolve every key off the same
 * documents.
 *
 * A load either produces documents every key resolves against, or is **refused** — the load-time
 * check a convention cannot hold, since a config can edit its own governed-path list and un-govern
 * itself, and since a machine-local file naming a key it may not set has to be told so rather than
 * quietly dropped. A refusal names the key that raised it and no key's value is used.
 *
 * An unreadable file is not a refusal: it is carried into the document state so every key resolves
 * UNKNOWN and each caller refuses in its own vocabulary. Collapsing "nobody wrote a config" into
 * "nobody could read the config" is the failure this whole surface exists to keep apart.
 *
 * **Two doors, and which one a caller takes is what decides whether the local layer exists.**
 * {@link loadConfig} takes one source and is the tracked-only door every ref-based read uses: a
 * local file does not exist at a ref, cannot be fetched at one, and must never reach a gate's
 * verdict. {@link loadLayeredConfig} takes both and is the working-tree door.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {
	CONFIG_PATH,
	type ConfigSource,
	type Documents,
	LOCAL_CONFIG_PATH,
	readDocument,
	trackedOnly,
} from "./document.ts";
import {type KeyGroup, type Resolution, resolveKey} from "./key-group.ts";
import {ineligibleLocalKeys} from "./machine-local.ts";
import {KEY_GROUPS} from "./registry.ts";

export type Load =
	| {readonly _tag: "Config"; readonly documents: Documents}
	| {readonly _tag: "Refused"; readonly reason: string};

/** The bytes of both files as their opener found them — the working tree's whole config surface. */
export interface ConfigLayers {
	readonly tracked: ConfigSource;
	readonly local: ConfigSource;
}

const loadDocuments = (documents: Documents): Load => {
	const ineligible = ineligibleLocalKeys(documents.local, KEY_GROUPS);
	if (ineligible !== null) return {_tag: "Refused", reason: ineligible};
	for (const group of KEY_GROUPS) {
		const refusal = group.loadRefusal(documents);
		if (refusal !== null) return {_tag: "Refused", reason: refusal};
	}
	return {_tag: "Config", documents};
};

/**
 * The tracked file alone, with no machine-local layer over it.
 *
 * Every ref-based read lands here, and the `local: Absent` it resolves under is a fact rather than a
 * default: there is no local file at a ref to read.
 */
export const loadConfig = (source: ConfigSource): Load =>
	loadDocuments(trackedOnly(readDocument(source, CONFIG_PATH)));

/** Both layers of the working tree, local winning per key. */
export const loadLayeredConfig = (layers: ConfigLayers): Load =>
	loadDocuments({
		tracked: readDocument(layers.tracked, CONFIG_PATH),
		local: readDocument(layers.local, LOCAL_CONFIG_PATH),
	});

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
		: resolveKey(load.documents, group);

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
				: group.readout(load.documents),
	}));
