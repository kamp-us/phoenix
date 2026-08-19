/**
 * Why no value of one load may be used, or `null` — the question a gate asks before it writes.
 *
 * A load that is not `Refused` is not thereby a load that decoded. `Refused` is the narrow arm a
 * key's `refuseLoad` raises over a config it *could* read; a file nobody could open, a file that is
 * not a JSON object, and a key whose value the decoder rejected all answer `Config`, because the
 * arms live per key in {@link Resolution} rather than on the load. Reading `_tag === "Config"` as
 * "it loaded" is what let `triage apply` reach the label write with the containment check never run
 * (#6292): a gate keyed on the refusal alone is fail-open on exactly the input class this surface
 * exists to keep apart.
 *
 * The two document-level arms are worded here rather than relayed from the state, because at that
 * level every key carries the same reason and a per-key attribution would be false — the file is
 * unreadable, not `triageFacets`. A key's own `Malformed` reason is relayed verbatim: it already
 * names its key, and the decoder's words are the ones that repair the file.
 */

import type {DocumentState} from "./document.ts";
import type {Load} from "./load.ts";
import {KEY_GROUPS} from "./registry.ts";

const documentReason = (state: DocumentState): string | null => {
	switch (state._tag) {
		case "Unreadable":
			return `it could not be read — ${state.reason}`;
		case "NotAnObject":
			return "it is not a JSON object, so no key of it was ever parsed";
		case "Absent":
		case "Record":
			return null;
	}
};

export const unusableReason = (load: Load): string | null => {
	if (load._tag === "Refused") return load.reason;
	const document = documentReason(load.state);
	if (document !== null) return document;
	for (const group of KEY_GROUPS) {
		const resolved = group.resolve(load.state);
		if (resolved._tag === "Malformed" || resolved._tag === "Unknown") return resolved.reason;
	}
	return null;
};
