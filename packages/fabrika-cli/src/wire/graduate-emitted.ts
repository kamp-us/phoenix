/**
 * The `graduate-emitted` marker — the first line of the comment `graduate emit` posts on the source
 * a spec was graduated from.
 *
 *     graduate-emitted: #9412 → #9520 @ a1b2c3d4e5f6 · covers R1.2;R1.4 · 2026-08-09T18:36:48Z
 *
 * It records that a decision trail left ideation as one spec issue: which source it was read from,
 * which issue was filed, the **spec** digest that filing bound, and the refs that spec covered.
 *
 * Two fields carry the design. The digest is the *spec*'s, not the trail's, so a deliberately split
 * trail can graduate its remainder later at a different digest instead of being refused forever by
 * the repeat guard. And `covers` is what lets a reader answer a coverage question without re-deriving
 * anything: a digest alone is opaque, so a caller holding one could not tell a remainder from a
 * duplicate. Its separator is `;` rather than `,` because a map-sourced ref contains a space
 * (`#9301 R1.2`), which makes a comma-separated list of them ambiguous.
 *
 * It is a new format rather than a widening of `./verdict-marker.ts`: that reader is guarded by a
 * separate namespace-prefix gate that returns `Absent` for a non-member, so a widening missing either
 * constant would emit markers it can never read back. An emission is also not a verdict — it carries
 * no `PASS`/`FAIL` polarity and binds a spec digest rather than a head SHA.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	absent,
	firstNonBlankLine,
	type MarkerTime,
	malformed,
	markerTime,
	payloadOf,
	reachesFor,
} from "./grill-marker.ts";

declare const SPEC_DIGEST: unique symbol;

/** The spec digest a marker binds: exactly 12 lowercase hex characters. */
export type SpecDigest = string & {readonly [SPEC_DIGEST]: true};

const SPEC_DIGEST_RE = /^[0-9a-f]{12}$/;

export const specDigest = (raw: string): SpecDigest | null => {
	const value = raw.trim();
	return SPEC_DIGEST_RE.test(value) ? (value as SpecDigest) : null;
};

export interface GraduateEmitted {
	readonly source: number;
	readonly emitted: number;
	readonly digest: SpecDigest;
	/** The refs the spec rendered, in trail order. Non-empty: a spec covering nothing is not one. */
	readonly covers: NonEmptyReadonlyArray<string>;
	readonly at: MarkerTime;
}

export type GraduateEmittedRead = WireRead<GraduateEmitted>;

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "graduate-emitted";

/** The separator between refs. No ref shape the contract defines can contain it. */
export const COVERS_SEPARATOR = ";";

const MARKER = /^#(\d+)\s*→\s*#(\d+)\s*@\s*([^\s·]+)\s*·\s*covers\s+([^·]+?)\s*·\s*(\S+)\s*$/;

const parseCovers = (raw: string): NonEmptyReadonlyArray<string> | null => {
	const refs = raw
		.split(COVERS_SEPARATOR)
		.map((ref) => ref.trim())
		.filter((ref) => ref !== "");
	const [first, ...rest] = refs;
	return first === undefined ? null : [first, ...rest];
};

export const read = (artifact: string): GraduateEmittedRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const matched = MARKER.exec(payloadOf(line, KEY));
	if (matched === null) {
		return malformed(
			`the marker is not "${KEY}: #<source> → #<emitted> @ <digest> · covers <refs> · <at>" — a field is missing or a separator drifted`,
			evidence,
		);
	}
	const digest = specDigest(matched[3] ?? "");
	if (digest === null) {
		return malformed(
			`"${matched[3]}" is not a spec digest — expected 12 lowercase hex characters`,
			evidence,
		);
	}
	const covers = parseCovers(matched[4] ?? "");
	if (covers === null) {
		return malformed(
			"the marker covers no ref — an emission specifying nothing is not one",
			evidence,
		);
	}
	const at = markerTime(matched[5] ?? "");
	if (at === null) {
		return malformed(
			`"${matched[5]}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {
		_tag: "Found",
		value: {
			source: Number.parseInt(matched[1] ?? "0", 10),
			emitted: Number.parseInt(matched[2] ?? "0", 10),
			digest,
			covers,
			at,
		},
	};
};

/** Compose the marker's one line. Round-trips through {@link read}. */
export const emit = (marker: GraduateEmitted): string =>
	`${KEY}: #${marker.source} → #${marker.emitted} @ ${marker.digest} · covers ${marker.covers.join(COVERS_SEPARATOR)} · ${marker.at}\n`;

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderMarker = (marker: GraduateEmitted): NonEmptyReadonlyArray<string> => [
	`source\t${marker.source}`,
	`emitted\t${marker.emitted}`,
	`digest\t${marker.digest}`,
	`covers\t${marker.covers.join(COVERS_SEPARATOR)}`,
	`at\t${marker.at}`,
];

export type GraduateEmittedFields =
	| {readonly _tag: "Fields"; readonly marker: GraduateEmitted}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["source", "emitted", "digest", "covers", "at"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/**
 * Parse `wire emit`'s stdin into a marker: one `<key>: <value>` per line, in any order.
 *
 * Every rejection is a refusal rather than a default. A missing `covers` that silently composed an
 * empty list would emit a marker asserting an emission specified nothing, and the bytes would look
 * perfectly well-formed.
 */
export const parseFields = (fields: string): GraduateEmittedFields => {
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
	const source = (seen.get("source") ?? "").trim().replace(/^#/, "");
	if (!/^\d+$/.test(source)) {
		return {_tag: "Unusable", reason: `"${seen.get("source")}" is not an issue number`};
	}
	const emitted = (seen.get("emitted") ?? "").trim().replace(/^#/, "");
	if (!/^\d+$/.test(emitted)) {
		return {_tag: "Unusable", reason: `"${seen.get("emitted")}" is not an issue number`};
	}
	const digest = specDigest(seen.get("digest") ?? "");
	if (digest === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("digest")}" is not a spec digest — expected 12 lowercase hex characters`,
		};
	}
	const covers = parseCovers(seen.get("covers") ?? "");
	if (covers === null) {
		return {_tag: "Unusable", reason: "covers names no ref — an emission specifies at least one"};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at")}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {
		_tag: "Fields",
		marker: {
			source: Number.parseInt(source, 10),
			emitted: Number.parseInt(emitted, 10),
			digest,
			covers,
			at,
		},
	};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.marker)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderMarker(result.value)} : result;
};
