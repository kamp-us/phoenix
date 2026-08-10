/**
 * `fabrika hook spawn` — the `PreToolUse` guard on a subagent spawn.
 *
 * The thin shell around `spawn.ts`: read the envelope, read the pin, hand both to `decideSpawn`,
 * print what it returned. No branch of the outcome is re-derived here, which is what keeps the
 * decision's tests worth anything.
 *
 * The pin arrives as an option rather than being read from `process.env` inside the verb, so a test
 * drives the absent-pin and misconfigured-pin paths without mutating the process.
 */
import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {EMPTY_STDIN, ENVELOPE_UNKNOWN, MALFORMED_ENVELOPE, WRONG_EVENT} from "./codes.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";
import {decideSpawn, permissionOutput, requestedModelOf} from "./spawn.ts";

const VERB = "fabrika hook spawn";
const JUDGED_EVENT = "PreToolUse";

export interface SpawnOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	/** The `WORKFLOW_MODEL` pin, or null when the environment sets none. */
	readonly pin: string | null;
}

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

const scopeLine = (piped: StdinRead, pin: string | null): string =>
	`${VERB}: judged ${
		piped._tag === "Text" ? `${piped.text.length} bytes on fd 0` : "nothing — fd 0 was not read"
	}, WORKFLOW_MODEL=${pin ?? "<unset>"}`;

export const runSpawn = ({stdin, pin}: SpawnOptions): Effect.Effect<VerbOutcome> =>
	Effect.map(stdin, (piped) => {
		const scope = scopeLine(piped, pin);
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
		if (read.envelope.event !== JUDGED_EVENT) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: judges ${JUDGED_EVENT} only — this envelope is ${read.envelope.event}`,
				[scope],
			);
		}

		const decision = decideSpawn(requestedModelOf(read.envelope.payload), pin);
		const output = permissionOutput(decision);
		return answer(`${JSON.stringify(output)}\n`, [scope, output.systemMessage]);
	});
