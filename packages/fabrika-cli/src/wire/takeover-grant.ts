/**
 * The takeover-grant marker — the comment `build takeover` posts on a pull request another author
 * opened, handing it to the pipeline.
 *
 *     takeover-granted: #7 · 2026-09-26T07:16:03Z
 *
 *     Take over #7, the author is on leave. — 2026-09-26
 *
 * The first line is the marker; the lines below it quote the dated authorization it rests on. The
 * pull request number is a field so a grant names what it grants: a marker read on any other thread
 * is a grant for nothing, and the reader refuses it rather than applying it where it landed.
 *
 * The marker is never proof on its own. What `../ownership/` counts as a grant is this marker
 * **plus** an author in the repo's configured grant-author set, holding `write+`, who is not the
 * pull request's own author — the same conjunctive shape `./cap-clearance.ts`'s reader applies.
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

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "takeover-granted";

declare const GRANTED_PULL: unique symbol;

/** The pull request a grant hands over: a positive integer. No other inhabitant exists. */
export type GrantedPull = number & {readonly [GRANTED_PULL]: true};

export const grantedPull = (raw: number): GrantedPull | null =>
	Number.isInteger(raw) && raw > 0 ? (raw as GrantedPull) : null;

export interface TakeoverGrant {
	readonly pr: GrantedPull;
	readonly at: MarkerTime;
}

export type TakeoverGrantRead = WireRead<TakeoverGrant>;

/**
 * Read the grant marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * A body that reaches for the key and misses is `Malformed`, never `Absent`: an operator whose
 * grant drifted must see that it drifted, and a silently absent one reads as a PR nobody handed over.
 */
export const read = (artifact: string): TakeoverGrantRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const [pullPart, ...afterSeparator] = payloadOf(line, KEY).split(FIELD_SEPARATOR);
	if (afterSeparator.length === 0) {
		return malformed(
			`the marker carries no "${FIELD_SEPARATOR}"-separated timestamp after the pull request`,
			evidence,
		);
	}
	const reference = /^#([0-9]+)$/.exec((pullPart ?? "").trim());
	const pr = reference?.[1] === undefined ? null : grantedPull(Number(reference[1]));
	if (pr === null) {
		return malformed(
			`"${(pullPart ?? "").trim()}" is not a pull request reference — expected "#<n>"`,
			evidence,
		);
	}
	const at = markerTime(afterSeparator.join(FIELD_SEPARATOR));
	if (at === null) {
		return malformed(
			`"${afterSeparator.join(FIELD_SEPARATOR).trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {_tag: "Found", value: {pr, at}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({pr, at}: TakeoverGrant): string =>
	`${KEY}: #${pr} ${FIELD_SEPARATOR} ${at}\n`;

export const renderGrant = (grant: TakeoverGrant): NonEmptyReadonlyArray<string> => [
	`pr\t${grant.pr}`,
	`at\t${grant.at}`,
];

export type TakeoverGrantFields =
	| {readonly _tag: "Fields"; readonly grant: TakeoverGrant}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["pr", "at"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/** Parse `wire emit`'s stdin into a grant. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): TakeoverGrantFields => {
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

	const raw = (seen.get("pr") ?? "").trim();
	const pr = /^[0-9]+$/.test(raw) ? grantedPull(Number(raw)) : null;
	if (pr === null) {
		return {
			_tag: "Unusable",
			reason: `"${raw}" is not a pull request — expected a positive integer`,
		};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at") ?? ""}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Fields", grant: {pr, at}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.grant)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderGrant(result.value)} : result;
};
