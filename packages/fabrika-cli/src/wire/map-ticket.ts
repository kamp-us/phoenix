/**
 * The `map-ticket` marker — the first line of a wayfinding frontier ticket's opening comment.
 *
 *     map-ticket: #9140 · research · 7f3a9c21
 *
 * Three fields: the **map** the ticket belongs to, the **kind** from a closed set, and the **run
 * nonce** of the run that filed it. The map number is the load-bearing one: a ticket whose marker
 * names a different map is not that map's ticket, whatever the sub-issue edge says — the edge can be
 * added by anyone, and a reader that trusted the edge alone would count a stranger's issue as part of
 * the frontier it reports.
 *
 * `read` is total and its three answers are the design (see `./format.ts`). The discrimination that
 * carries the weight is **Absent vs Malformed**: bytes carrying no `map-ticket:` line at all are
 * `Absent`; bytes carrying something recognisably *reaching* for one — an off-vocabulary kind, a
 * nonce that is not eight hex characters, a missing field — are `Malformed`. `map read` reports a
 * malformed marker in `disregarded` rather than dropping the child, so a ticket that *looks* like the
 * map's is visible instead of silently absent.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const NONCE: unique symbol;

/** A run's lane key: exactly eight lowercase hex characters. Branded so `Found` cannot carry `""`. */
export type Nonce = string & {readonly [NONCE]: true};

/** What clears a frontier ticket. A fourth token is not a kind — it is a drift. */
export type TicketKind = "research" | "prototype" | "decision";

export interface MapTicketMarker {
	readonly map: number;
	readonly kind: TicketKind;
	readonly nonce: Nonce;
}

export type MapTicketRead = WireRead<MapTicketMarker>;

export const KEY_PREFIX = "map-ticket:";
const NONCE_RE = /^[0-9a-f]{8}$/;
const KINDS: ReadonlyArray<TicketKind> = ["research", "prototype", "decision"];
const MARKER = /^map-ticket:\s*#(\d+)\s*·\s*([^\s·]+)\s*·\s*([^\s·]+)\s*$/;

export const nonce = (raw: string): Nonce | null => {
	const value = raw.trim();
	return NONCE_RE.test(value) ? (value as Nonce) : null;
};

export const isTicketKind = (value: string): value is TicketKind =>
	(KINDS as ReadonlyArray<string>).includes(value);

const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

const malformed = (reason: string, evidence: string): MapTicketRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** Whether the bytes reach for this format at all — the gate that keeps `Absent` off a real drift. */
export const reaches = (artifact: string): boolean =>
	(firstNonBlankLine(artifact) ?? "").trimStart().toLowerCase().startsWith(KEY_PREFIX);

export const read = (artifact: string): MapTicketRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null || !reaches(artifact)) {
		return {
			_tag: "Absent",
			reason:
				'the first non-blank line does not open with "map-ticket:" — no marker of this format',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	const matched = MARKER.exec(line.trim());
	if (matched === null) {
		return malformed(
			'the marker is not "map-ticket: #<map> · <kind> · <nonce>" — a field is missing or the separator drifted',
			evidence,
		);
	}
	const kind = matched[2] ?? "";
	if (!isTicketKind(kind)) {
		return malformed(`"${kind}" is not a kind — expected ${KINDS.join(", ")}`, evidence);
	}
	const key = nonce(matched[3] ?? "");
	if (key === null) {
		return malformed(
			`"${matched[3]}" is not a run nonce — expected exactly eight lowercase hex characters`,
			evidence,
		);
	}
	return {
		_tag: "Found",
		value: {map: Number.parseInt(matched[1] ?? "0", 10), kind, nonce: key},
	};
};

/** Compose the marker's one line. Round-trips through {@link read}. */
export const emit = (marker: MapTicketMarker): string =>
	`map-ticket: #${marker.map} · ${marker.kind} · ${marker.nonce}`;

export type MapTicketFields =
	| {readonly _tag: "Fields"; readonly marker: MapTicketMarker}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["map", "kind", "nonce"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/**
 * Parse `emit`'s stdin into a marker: one `<key>: <value>` per line, in any order.
 *
 * Every rejection is a refusal rather than a default. A missing `map` that silently composed an
 * unbound marker would attach the ticket to no map at all, and the emitted bytes would look perfectly
 * well-formed.
 */
export const parseFields = (fields: string): MapTicketFields => {
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

	const missing = KEYS.filter((key) => (seen.get(key) ?? "").trim() === "");
	if (missing.length > 0) {
		return {
			_tag: "Unusable",
			reason: `no value for ${missing.join(", ")} — every field is required`,
		};
	}
	const map = (seen.get("map") ?? "").trim().replace(/^#/, "");
	if (!/^\d+$/.test(map)) {
		return {_tag: "Unusable", reason: `"${seen.get("map")}" is not an issue number`};
	}
	const kind = (seen.get("kind") ?? "").trim();
	if (!isTicketKind(kind)) {
		return {_tag: "Unusable", reason: `"${kind}" is not a kind — expected ${KINDS.join(", ")}`};
	}
	const key = nonce(seen.get("nonce") ?? "");
	if (key === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("nonce")}" is not a run nonce — expected exactly eight lowercase hex characters`,
		};
	}
	return {_tag: "Fields", marker: {map: Number.parseInt(map, 10), kind, nonce: key}};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderMarker = (marker: MapTicketMarker): NonEmptyReadonlyArray<string> => [
	`map\t${marker.map}`,
	`kind\t${marker.kind}`,
	`nonce\t${marker.nonce}`,
];

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: `${emit(parsed.marker)}\n`}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderMarker(result.value)} : result;
};
