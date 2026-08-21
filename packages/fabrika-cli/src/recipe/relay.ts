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
	READBACK_MISMATCH as BUILD_READBACK_MISMATCH,
	WRITE_UNKNOWN as BUILD_WRITE_UNKNOWN,
} from "../build/codes.ts";
import {
	LANE_ABSENT,
	APPEND_UNKNOWN as LANE_APPEND_UNKNOWN,
	EVENT_REFUSED as LANE_EVENT_REFUSED,
	MALFORMED_RECORD as LANE_MALFORMED_RECORD,
	RESUME_UNBUDGETED as LANE_RESUME_UNBUDGETED,
	TASK_UNKNOWN as LANE_TASK_UNKNOWN,
	LANE_UNREADABLE,
} from "../lane/codes.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	MALFORMED_RECORD,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
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
		// Both are the machine refusing the UNBLOCKED with the log unappended, and a recipe does the
		// same thing on either: stop and route to a human. They stay two codes on the lane's own table
		// because only one of them is fixed by recording a clearance (ADR 0312).
		case LANE_EVENT_REFUSED:
		case LANE_RESUME_UNBUDGETED:
			return UNPARK_REFUSED;
		case LANE_TASK_UNKNOWN:
			return TASK_UNRESOLVED;
		default:
			return PRECONDITION_UNKNOWN;
	}
};

/**
 * This group's seat for a `build` verb's refusal — today, `build retire`'s.
 *
 * Only the two write-side facts carry across, and they carry because both tables import the same
 * base constant for them: a removal whose outcome is unproven and a removal contradicted by its
 * read-back mean here exactly what they mean there. Everything else is
 * {@link PRECONDITION_UNKNOWN}, including `build`'s own proven refusals: `7` says a *number* is
 * absent, which is not this group's "no lane at this ref", and re-seating it as one would report a
 * missing issue as a missing lane.
 */
export const buildExit = (code: number): number => {
	switch (code) {
		case BUILD_WRITE_UNKNOWN:
			return WRITE_UNKNOWN;
		case BUILD_READBACK_MISMATCH:
			return READBACK_MISMATCH;
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
