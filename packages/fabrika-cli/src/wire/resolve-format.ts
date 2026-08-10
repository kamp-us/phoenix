/**
 * `--format` → a registered row, or a zero-scope refusal.
 *
 * Shared by the three verbs that take `--format` so an unregistered key refuses in one voice. The
 * refusal is {@link ZERO_SCOPE}, not a usage error: a verb asked to judge a format it does not have
 * judged nothing, and a check over nothing that exits 0 is the vacuous pass ADR 0092 forbids.
 */
import {refuse, type VerbOutcome} from "../verb.ts";
import {ZERO_SCOPE} from "./codes.ts";
import type {WireFormat} from "./format.ts";
import {findFormat, registeredKeys} from "./registry.ts";

export type FormatLookup =
	| {readonly _tag: "Format"; readonly format: WireFormat}
	| {readonly _tag: "Refusal"; readonly outcome: VerbOutcome};

export const resolveFormat = (verb: string, key: string): FormatLookup => {
	const keys = registeredKeys();
	if (keys.length === 0) {
		return {
			_tag: "Refusal",
			outcome: refuse(
				ZERO_SCOPE,
				`${verb}: no wire format is registered — there is nothing to judge`,
			),
		};
	}
	const format = findFormat(key);
	if (format === undefined) {
		return {
			_tag: "Refusal",
			outcome: refuse(
				ZERO_SCOPE,
				`${verb}: no format is registered under "${key}" — registered: ${keys.join(", ")}`,
			),
		};
	}
	return {_tag: "Format", format};
};
