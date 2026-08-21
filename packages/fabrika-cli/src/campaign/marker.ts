/**
 * The `campaign-approve:` marker — the only thing `--cites` proves about a comment's text.
 *
 *     campaign-approve: #47 active · 2026-08-20T04:11:09Z
 *
 * Anchored to the comment's **first line**, split off rather than matched whole. v1 required the
 * whole body to *be* the marker, so a founder who wrote their approval and then explained it read as
 * malformed (#3831); splitting closes the inverse at the same time, since a marker quoted mid-body
 * inside somebody else's comment is a quotation, never a grant.
 *
 * **The timestamp is compared to nothing** — no staleness window, no ordering, no binding against
 * the comment's own `created_at`. It is evidence a human reader dates the ruling by, and its only
 * mechanical job is to make the marker a deliberate line rather than a phrase typed in passing.
 * Stated because a validated input with no stated effect is where one implementer adds a freshness
 * rule and another does not (ADR 0247).
 */

import type {CampaignState} from "../build/scope-admission.ts";

const MARKER =
	/^\s*\*{0,2}\s*campaign-approve:\s*#(?<milestone>\d+)\s+(?<state>active|paused|done)\s*·\s*(?<ts>\S+?)\s*\*{0,2}\s*$/i;

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * Whether `ts` is both regex-shaped and a real instant.
 *
 * `Date.parse` alone does not answer this: the ECMAScript Date Time String Format admits any `DD` in
 * `01`-`31`, and `MakeDay` then rolls the overflow forward — so `2026-02-30T00:00:00Z` parses to a
 * finite number naming March 2 (ECMA-262 §21.4.1.12 / §21.4.3.2). Reading the fields back off the
 * parsed instant is what catches the roll.
 */
const isInstant = (ts: string): boolean => {
	const shaped = ISO_UTC.exec(ts);
	if (shaped === null) return false;
	const at = Date.parse(ts);
	if (!Number.isFinite(at)) return false;
	const parsed = new Date(at);
	const fields = [
		parsed.getUTCFullYear(),
		parsed.getUTCMonth() + 1,
		parsed.getUTCDate(),
		parsed.getUTCHours(),
		parsed.getUTCMinutes(),
		parsed.getUTCSeconds(),
	];
	return fields.every((field, index) => field === Number(shaped[index + 1]));
};

/** The canonical spelling, quoted in the refusals that ask for one. */
export const MARKER_GRAMMAR = "campaign-approve: #<milestone> <state> · <ISO-8601 UTC timestamp>";

export interface Marker {
	readonly milestone: number;
	readonly state: CampaignState;
	readonly at: string;
}

export type MarkerRead =
	/** The first line reaches for no marker at all — the caller's `14`. */
	| {readonly _tag: "Absent"}
	/** A marker was reached for and does not hold up — the caller's `15`. */
	| {readonly _tag: "Malformed"; readonly reason: string}
	| {readonly _tag: "Marker"; readonly marker: Marker};

const REACHES = /^\s*\*{0,2}\s*campaign-approve:/i;

/**
 * Read the marker off a comment body's first line.
 *
 * `Absent` and `Malformed` are two answers because their remedies are opposite: a comment that never
 * reached for a marker needs one written, and a comment that reached and missed needs the line it
 * already has fixed.
 */
export const readMarker = (body: string): MarkerRead => {
	const first = body.split(/\r?\n/)[0] ?? "";
	const match = MARKER.exec(first);
	if (match?.groups === undefined) {
		return REACHES.test(first)
			? {_tag: "Malformed", reason: `"${first.trim()}" is not \`${MARKER_GRAMMAR}\``}
			: {_tag: "Absent"};
	}
	const {milestone, state, ts} = match.groups;
	if (ts === undefined || !isInstant(ts)) {
		return {
			_tag: "Malformed",
			reason: `"${ts ?? ""}" is not an ISO-8601 UTC timestamp — the grammar is YYYY-MM-DDTHH:MM:SSZ`,
		};
	}
	return {
		_tag: "Marker",
		marker: {
			milestone: Number.parseInt(milestone ?? "", 10),
			state: (state ?? "").toLowerCase() as CampaignState,
			at: ts,
		},
	};
};

/**
 * Whether the marker authorizes **this** write: the row's milestone, and the state the write
 * produces.
 *
 * An approval of one campaign never authorizes another, and an approval to pause never authorizes a
 * start. Returns the refusal reason, or `null` when the marker binds.
 */
export const bindingMiss = (
	marker: Marker,
	milestone: number,
	state: CampaignState,
): string | null =>
	marker.milestone === milestone && marker.state === state
		? null
		: `approves #${marker.milestone} ${marker.state}, not #${milestone} ${state}`;
