/**
 * How another group's verb outcome is re-seated on this group's table.
 *
 * A recipe verb relays: it reads a lane through `lane status`, records the clear through
 * `lane transition`, and asks `ship cp-approval` whether a §CP park's cause is gone (ADR 0228 — the
 * verb answers, the caller relays, neither derives a decision it does not own). Those verbs answer
 * on **their** tables, and two of `lane`'s private codes sit on numbers this group spells
 * differently, so passing an exit through unchanged would report a refused event as a novel park.
 *
 * The mapping therefore imports both tables and is a pure function, so a re-seat on either side is a
 * type-level fact rather than a number two files agree about by luck.
 */
import {
	LANE_ABSENT,
	APPEND_UNKNOWN as LANE_APPEND_UNKNOWN,
	EVENT_REFUSED as LANE_EVENT_REFUSED,
	MALFORMED_RECORD as LANE_MALFORMED_RECORD,
	TASK_UNKNOWN as LANE_TASK_UNKNOWN,
	LANE_UNREADABLE,
} from "../lane/codes.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	MALFORMED_RECORD,
	PRECONDITION_UNKNOWN,
	TARGET_ABSENT,
	TASK_UNRESOLVED,
	UNPARK_REFUSED,
	WRITE_UNKNOWN,
} from "./codes.ts";

/**
 * This group's seat for a `lane` verb's refusal. An unrecognised lane code is
 * {@link PRECONDITION_UNKNOWN} rather than a guess: a code this module has no reading for has
 * proven nothing here.
 */
export const laneExit = (code: number): number => {
	switch (code) {
		case LANE_MALFORMED_RECORD:
			return MALFORMED_RECORD;
		case LANE_ABSENT:
			return TARGET_ABSENT;
		case LANE_APPEND_UNKNOWN:
			return WRITE_UNKNOWN;
		case LANE_UNREADABLE:
			return PRECONDITION_UNKNOWN;
		case LANE_EVENT_REFUSED:
			return UNPARK_REFUSED;
		case LANE_TASK_UNKNOWN:
			return TASK_UNRESOLVED;
		default:
			return PRECONDITION_UNKNOWN;
	}
};

/**
 * Re-seat a relayed refusal, keeping the relayed verb's own diagnostics verbatim beneath a line
 * naming which verb refused and on what code — a relay that rewrote the reason would be deriving.
 */
export const relayRefusal = (
	verb: string,
	relayed: string,
	outcome: VerbOutcome,
	code: number,
): VerbOutcome =>
	refuse(code, `${verb}: ${relayed} refused at exit ${outcome.code} — relayed as ${code}.`, [
		...outcome.stderr,
	]);
