/**
 * The five one-line markers this group writes on a frontier ticket, and their readers.
 *
 * Ticket state lives in markers, issue state and native edges — never in a body row (see
 * `./body.ts`). Each marker is composed here and nowhere else, so the grammar has one home and a
 * reader cannot drift from a writer.
 *
 * **These are the group's own grammar, not `../build/claim.ts`'s.** That module's `composeMarker`
 * hardcodes the `build-claim:` prefix, its `MARKER_RE` matches only that, and its `resolveOwnership`
 * compares a **session** token. This group's lanes are keyed on a **run nonce**, so calling it would
 * find zero markers on a frontier ticket and answer *unclaimed* on every call — a lane that can never
 * see a sibling lane's claim, which is precisely the collision the nonce exists to prevent.
 *
 * <!-- anchor: LANE-KEY-IS-THE-RUN-NONCE --> The lane key is the caller's run nonce, never a session
 * id and never a pid: `$CLAUDE_CODE_SESSION_ID` is pane-constant rather than per-run (#5028) and
 * sibling subagents of one parent share it (#4516), so two lanes of one charting run would key onto
 * one namespace and each would classify the other's claim as its own. Nothing here reads the
 * environment — the nonce arrives as an argument.
 */

import {
	nonce as brandNonce,
	emit as emitTicketMarker,
	read as readTicketFormat,
} from "../wire/map-ticket.ts";
import type {Kind} from "./body.ts";

/**
 * The ticket marker is the one marker here that is a **registered wire format**, so its grammar lives
 * in `../wire/map-ticket.ts` and this module only re-exports it. The other four are internal to this
 * group: nothing outside it reads them, and a format nobody meets through is not a wire format.
 */
export {reaches as reachesForTicketMarker} from "../wire/map-ticket.ts";

/** The lane key's grammar. A human-readable label two runs would collide on is not a nonce. */
export const NONCE = /^[0-9a-f]{8}$/;
export const isNonce = (value: string): boolean => NONCE.test(value);

/** What a research lane established. There is no fourth value and no default. */
export const OUTCOMES = ["answered", "no-evidence", "unreachable"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (value: string): value is Outcome =>
	(OUTCOMES as readonly string[]).includes(value);

/** The ticket's identity marker: which map it belongs to, what clears it, and who filed it. */
export interface TicketMarker {
	readonly map: number;
	readonly kind: Kind;
	readonly nonce: string;
}

/** A lane claim on one ticket. */
export interface LaneMarker {
	readonly map: number;
	readonly ticket: number;
	readonly nonce: string;
}

/** A lane closing with what it established. */
export interface FindingMarker {
	readonly map: number;
	readonly ticket: number;
	readonly outcome: Outcome;
	readonly nonce: string;
}

/** Where a question is being answered instead — a `grilling` session or a `prototyping` spike. */
export interface ForkMarker {
	readonly map: number;
	readonly ticket: number;
	readonly route: "session" | "spike";
	readonly issue: number;
}

/** The ticket left the frontier into the out-of-scope section, and the direction it retired into. */
export interface RetiredMarker {
	readonly map: number;
	readonly ticket: number;
	readonly direction: string;
}

const first = (body: string): string => body.split("\n").find((line) => line.trim() !== "") ?? "";

export const composeTicketMarker = (marker: TicketMarker): string => {
	const key = brandNonce(marker.nonce);
	// Unreachable through the callers, which all check `isNonce` first; composing an unbranded nonce
	// would emit a marker this module's own reader refuses, so it throws rather than shipping bytes.
	if (key === null) throw new Error(`"${marker.nonce}" is not a run nonce`);
	return emitTicketMarker({map: marker.map, kind: marker.kind, nonce: key});
};

export const composeLaneMarker = (marker: LaneMarker): string =>
	`map-lane: #${marker.map} · #${marker.ticket} · ${marker.nonce}`;

export const composeFindingMarker = (marker: FindingMarker): string =>
	`map-finding: #${marker.map} · #${marker.ticket} · ${marker.outcome} · ${marker.nonce}`;

export const composeForkMarker = (marker: ForkMarker): string =>
	`map-fork: #${marker.map} · #${marker.ticket} · ${marker.route} #${marker.issue}`;

export const composeRetiredMarker = (marker: RetiredMarker): string =>
	`map-retired: #${marker.map} · #${marker.ticket} · ${marker.direction}`;

/** The ticket marker on a comment's first non-blank line, or `null` when it does not conform. */
export const readTicketMarker = (body: string): TicketMarker | null => {
	const result = readTicketFormat(body);
	return result._tag === "Found" ? result.value : null;
};

export const readLaneMarker = (body: string): LaneMarker | null => {
	const matched = /^map-lane:\s*#(\d+)\s*·\s*#(\d+)\s*·\s*([0-9a-f]+)\s*$/.exec(first(body).trim());
	const nonce = matched?.[3] ?? "";
	if (matched === null || !isNonce(nonce)) return null;
	return {
		map: Number.parseInt(matched[1] ?? "0", 10),
		ticket: Number.parseInt(matched[2] ?? "0", 10),
		nonce,
	};
};

export const readFindingMarker = (body: string): FindingMarker | null => {
	const matched = /^map-finding:\s*#(\d+)\s*·\s*#(\d+)\s*·\s*([a-z-]+)\s*·\s*([0-9a-f]+)\s*$/.exec(
		first(body).trim(),
	);
	const outcome = matched?.[3] ?? "";
	const nonce = matched?.[4] ?? "";
	if (matched === null || !isOutcome(outcome) || !isNonce(nonce)) return null;
	return {
		map: Number.parseInt(matched[1] ?? "0", 10),
		ticket: Number.parseInt(matched[2] ?? "0", 10),
		outcome,
		nonce,
	};
};

export const readForkMarker = (body: string): ForkMarker | null => {
	const matched = /^map-fork:\s*#(\d+)\s*·\s*#(\d+)\s*·\s*(session|spike)\s+#(\d+)\s*$/.exec(
		first(body).trim(),
	);
	if (matched === null) return null;
	return {
		map: Number.parseInt(matched[1] ?? "0", 10),
		ticket: Number.parseInt(matched[2] ?? "0", 10),
		route: matched[3] === "spike" ? "spike" : "session",
		issue: Number.parseInt(matched[4] ?? "0", 10),
	};
};

export const readRetiredMarker = (body: string): RetiredMarker | null => {
	const matched = /^map-retired:\s*#(\d+)\s*·\s*#(\d+)\s*·\s*(.+?)\s*$/.exec(first(body).trim());
	if (matched === null) return null;
	return {
		map: Number.parseInt(matched[1] ?? "0", 10),
		ticket: Number.parseInt(matched[2] ?? "0", 10),
		direction: matched[3] ?? "",
	};
};
