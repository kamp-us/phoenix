/**
 * The cap-clearance marker — the comment `build clear` posts on a PR after its authorization.
 *
 *     cap-cleared: round 3 · 2026-08-18T07:16:03Z
 *
 * Two fields, and the round is the load-bearing one: a clearance is spent by the round it names, so
 * it survives the push it exists to permit and expires the moment another FAIL round lands (see
 * `../cap-clearance.ts`). It carries no head SHA on purpose — a verdict attests a tree, but a
 * clearance authorizes the *next* tree, so binding one to a head would void it on first use.
 *
 * The marker is never proof on its own. What `build verdicts` folds as budget is this marker
 * **plus** an author in the repo's configured grant-author set plus the dated authorization comment
 * beside it, exactly as `grill-ruled` means the four clauses `grill read` applies and not the bytes.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	absent,
	FIELD_SEPARATOR,
	firstNonBlankLine,
	type MarkerTime,
	malformed,
	markerTime,
	payloadOf,
	reachesFor,
} from "./grill-marker.ts";

export type {MarkerTime} from "./grill-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "cap-cleared";

/** The word before the round, so the number is never a bare token a reader has to guess at. */
const ROUND_PREFIX = "round";

declare const CLEARED_ROUND: unique symbol;

/** The round a clearance clears: a positive integer. No other inhabitant exists. */
export type ClearedRound = number & {readonly [CLEARED_ROUND]: true};

export const clearedRound = (raw: number): ClearedRound | null =>
	Number.isInteger(raw) && raw > 0 ? (raw as ClearedRound) : null;

export interface CapClearance {
	readonly round: ClearedRound;
	readonly at: MarkerTime;
}

export type CapClearanceRead = WireRead<CapClearance>;

/**
 * Read the clearance marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * The walk is stepwise so a refusal names which field drifted. A body that reaches for the key and
 * misses must never read as a PR nobody cleared — the operator would re-grant a round already
 * granted, and the audit trail would carry two markers for one act.
 */
export const read = (artifact: string): CapClearanceRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const payload = payloadOf(line, KEY);
	const [roundPart, ...afterSeparator] = payload.split(FIELD_SEPARATOR);
	if (afterSeparator.length === 0) {
		return malformed(
			`the marker carries no "${FIELD_SEPARATOR}"-separated timestamp after the round`,
			evidence,
		);
	}
	const words = (roundPart ?? "").trim().split(/\s+/);
	if (words[0]?.toLowerCase() !== ROUND_PREFIX || words.length !== 2) {
		return malformed(
			`"${(roundPart ?? "").trim()}" is not a cleared round — expected "${ROUND_PREFIX} <n>"`,
			evidence,
		);
	}
	const round = clearedRound(Number(words[1]));
	if (round === null) {
		return malformed(`"${words[1]}" is not a round number — expected a positive integer`, evidence);
	}
	const at = markerTime(afterSeparator.join(FIELD_SEPARATOR));
	if (at === null) {
		return malformed(
			`"${afterSeparator.join(FIELD_SEPARATOR).trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {_tag: "Found", value: {round, at}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({round, at}: CapClearance): string =>
	`${KEY}: ${ROUND_PREFIX} ${round} ${FIELD_SEPARATOR} ${at}\n`;

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderClearance = (clearance: CapClearance): NonEmptyReadonlyArray<string> => [
	`round\t${clearance.round}`,
	`at\t${clearance.at}`,
];

export type CapClearanceFields =
	| {readonly _tag: "Fields"; readonly clearance: CapClearance}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["round", "at"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/** Parse `wire emit`'s stdin into a clearance. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): CapClearanceFields => {
	const seen = new Map<FieldKey, string>();
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const matched = FIELD_LINE.exec(line);
		const key = matched?.[1]?.toLowerCase() ?? "";
		if (matched === null || !isFieldKey(key)) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} is not a "<field>: <value>" line over ${KEYS.join(", ")}: "${line}"`,
			};
		}
		if (seen.has(key)) {
			return {
				_tag: "Unusable",
				reason: `"${key}" is given twice — which one is the field is undecidable`,
			};
		}
		seen.set(key, matched[2] ?? "");
	}

	const raw = (seen.get("round") ?? "").trim();
	const round = /^[0-9]+$/.test(raw) ? clearedRound(Number(raw)) : null;
	if (round === null) {
		return {_tag: "Unusable", reason: `"${raw}" is not a round — expected a positive integer`};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at") ?? ""}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Fields", clearance: {round, at}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.clearance)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderClearance(result.value)} : result;
};
