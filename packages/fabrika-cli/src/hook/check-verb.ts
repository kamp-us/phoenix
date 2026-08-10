/**
 * `hook check` — the verb the fabrika hook surface's one declared hook runs.
 *
 * It answers a single question: did a fabrika hook fire, and did the harness hand it an envelope
 * fabrika can read? That is a small answer on purpose. It is the surface's own proof, so it must not
 * depend on anything a later hook might change, and it must be able to run on any event.
 *
 * The answer is a **positive token**, never silence: a verb whose success is empty stdout is
 * byte-identical to a verb that never ran (cli-interface-convention rule 2). The scope it judged goes
 * to stderr on every path, so a verdict is never reported over unstated scope (ADR 0092).
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {EMPTY_STDIN, ENVELOPE_UNKNOWN, MALFORMED_ENVELOPE} from "./codes.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";

const VERB = "fabrika hook check";

export interface CheckOptions {
	readonly json: boolean;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** An unread fd 0 stays UNKNOWN: a TTY and a failed read prove nothing about the envelope. */
const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

const scopeLine = (piped: StdinRead): string =>
	piped._tag === "Text"
		? `${VERB}: judged ${piped.text.length} bytes on fd 0`
		: `${VERB}: judged nothing — fd 0 was not read`;

export const runCheck = ({json, stdin}: CheckOptions): Effect.Effect<VerbOutcome> =>
	Effect.map(stdin, (piped) => {
		const scope = scopeLine(piped);
		const read = readEnvelope(piped);

		if (read._tag === "Empty") {
			return refuse(EMPTY_STDIN, `${VERB}: stdin was read and held nothing`, [scope]);
		}
		if (read._tag === "Unknown") {
			return refuse(ENVELOPE_UNKNOWN, `${VERB}: envelope UNKNOWN — ${read.reason}`, [scope]);
		}
		if (read._tag === "Malformed") {
			return refuse(MALFORMED_ENVELOPE, `${VERB}: not a hook envelope — ${read.reason}`, [
				scope,
				`${VERB}: ${read.evidence}`,
			]);
		}

		const {event, fields} = read.envelope;
		const stdout = json
			? `${JSON.stringify({outcome: "conforms", event, fields: fields.length})}\n`
			: `conforms\t${event}\t${fields.length}\n`;
		return answer(stdout, [scope]);
	});
