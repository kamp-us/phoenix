/**
 * `wire formats` — the registered formats, derived from `./registry.ts`.
 *
 * The listing is a projection of the array, never a second copy of it, which is what makes "is this
 * format registered?" answerable from the binary that dispatches rather than from a document that
 * can drift. An empty registry refuses (ADR 0092): printing an empty list would be a proven
 * negative from a verb that resolved nothing.
 */
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {ZERO_SCOPE} from "./codes.ts";
import {registeredFormats} from "./registry.ts";

const VERB = "wire formats";

export interface FormatsInput {
	readonly json: boolean;
}

export const runFormats = ({json}: FormatsInput): VerbOutcome => {
	if (registeredFormats.length === 0) {
		return refuse(ZERO_SCOPE, `${VERB}: no wire format is registered — the registry holds no rows`);
	}
	const rows = registeredFormats.map(({key, purpose, producers, consumers}) => ({
		key,
		purpose,
		producers,
		consumers,
	}));
	const stdout = json
		? `${JSON.stringify({formats: rows})}\n`
		: `formats\t${rows.length}\n${rows
				.map(
					(row) =>
						`${row.key}\t${row.purpose}\t${row.producers.join(",")}\t${row.consumers.join(",")}`,
				)
				.join("\n")}\n`;
	return answer(stdout, [`${VERB}: derived from the registry — ${rows.length} registered.`]);
};
