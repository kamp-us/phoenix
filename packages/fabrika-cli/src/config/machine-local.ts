/**
 * Which keys a machine may declare in `.fabrika.local.jsonc`, and the refusal when it declares one
 * it may not.
 *
 * The allow-list is not a list here: it is the `machineLocal` field each key group declares beside
 * its own default and decoder, read back off the registry. A convention would let a new key become
 * machine-settable by nobody's decision; a field makes it one registry-visible change with a test.
 *
 * **An ineligible key refuses the whole load rather than being ignored.** An operator who writes
 * `codeValidators` into their local file must be told the file is refused, not left believing a
 * value is in force that is not — the same reason `laneConcurrencyCap` refuses a fraction rather
 * than rounding it. Ignoring the key would also be the quiet half of the thing being banned: the
 * local file is untracked and invisible in review, so a silently dropped key is a gate weakened or
 * not weakened with nothing anywhere to read.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {type DocumentState, LOCAL_CONFIG_PATH} from "./document.ts";
import type {Registration} from "./key-group.ts";

/**
 * The self-pointer binding the file to its schema — a property of the document, not a config key.
 *
 * Admitted by name because an editor writes it and the eligibility check would otherwise refuse
 * every local file that carries the very line giving it autocomplete.
 */
const SCHEMA_POINTER_KEY = "$schema";

/** Every key one machine may declare locally, in registry order. */
export const machineLocalKeys = (
	registrations: ReadonlyArray<Registration>,
): ReadonlyArray<string> => registrations.filter((one) => one.machineLocal).map((one) => one.key);

/**
 * Why the whole load is refused over this local document, or `null`.
 *
 * Only a parsed record can name a key. An absent local file declared nothing, and an unreadable or
 * non-object one resolves every key UNKNOWN through {@link resolveKey} instead — a refusal there
 * would claim the file names an ineligible key, which nobody has read.
 */
export const ineligibleLocalKeys = (
	local: DocumentState,
	registrations: ReadonlyArray<Registration>,
): string | null => {
	if (local._tag !== "Record") return null;
	const eligible = new Set(machineLocalKeys(registrations));
	const offending = Object.keys(local.record).filter(
		(key) => key !== SCHEMA_POINTER_KEY && !eligible.has(key),
	);
	if (offending.length === 0) return null;
	const settable =
		eligible.size === 0
			? "no key is machine-settable"
			: `the machine-settable set is ${[...eligible].join(", ")}`;
	return `${LOCAL_CONFIG_PATH} declares ${offending.length} key(s) no machine may set locally (${offending.join(", ")}) — the whole load is refused rather than the keys ignored, and ${settable}`;
};
