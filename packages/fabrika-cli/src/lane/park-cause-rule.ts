/**
 * The repo's `parkCause` rule, resolved once for both recorders.
 *
 * `lane report` and `lane transition` both append a `BLOCKED`, so both owe the same answer to
 * "may this park name no cause?". Deciding it in each verb is how the two drift — the shape
 * `config/ci-producer.ts` exists to prevent one layer up.
 *
 * An unreadable or malformed `parkCause` refuses rather than falling back to the shipped default:
 * whether this repo allows a cause-less park is then UNKNOWN, and a fallback would silently restore
 * the permissive arm in a repo that declared the strict one.
 */

import {CONFIG_PATH} from "../config/document.ts";
import {PARK_CAUSE, type ParkCauseSurface, SHIPPED_PARK_CAUSE} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";

/**
 * What a caller passes when its event is a compile-time constant that is not `BLOCKED`.
 *
 * `recipe unpark` is the only one: it records the literal `"UNBLOCKED"`, so the rule this stands in
 * for is unreachable on that path and reading the config there would buy a file open for an answer
 * nothing consults. It is named rather than inlined so a caller whose event *can* vary cannot reach
 * for it by accident — `lane view` relays whatever event the browser sends, so it reads the key.
 */
export const PARK_RULE_UNREACHED: Read<ParkCauseSurface> = {
	_tag: "Value",
	value: SHIPPED_PARK_CAUSE,
	note: `\`${PARK_CAUSE}\` is not read: this caller's event is never a park`,
};

export type ParkCauseRule =
	/** The rule to apply: whether a `BLOCKED` carrying no cause is refused. */
	| {readonly _tag: "Resolved"; readonly requireCause: boolean}
	/** The config did not answer, so nothing may be appended. */
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

export const parkCauseRefusal = (verb: string, read: Read<ParkCauseSurface>): ParkCauseRule =>
	read._tag === "Refused"
		? {
				_tag: "Refused",
				outcome: refuse(
					LANE_UNREADABLE,
					`${verb}: cannot read \`${PARK_CAUSE}\` from ${CONFIG_PATH} (${read.reason}) — whether this repo records a park that names no cause is UNKNOWN, and the log is unappended.`,
				),
			}
		: {_tag: "Resolved", requireCause: read.value.uncaused === "refuse"};
