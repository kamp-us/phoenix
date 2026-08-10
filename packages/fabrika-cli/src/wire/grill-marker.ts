/**
 * The field vocabulary the three `grill` markers are built from, and the total reader they share.
 *
 * `grill-ruled`, `grill-answered` and `grill-superseded` are three formats rather than one
 * discriminated by a field, because they carry different authority and a reader must never have to
 * parse a field to learn which. What they *do* share is the vocabulary — a question id, a round
 * digest, a timestamp — and the reading discipline: the marker is the artifact's first non-blank
 * line, a body carrying no such key is `Absent`, and a body reaching for the key and missing is
 * `Malformed`. Both live here so the three schema modules state them once between them.
 *
 * **A malformed marker is never silently `Absent`.** A real ruling written in the wrong shape must
 * be a *visible* state — `grill read` reports it as a `disregarded` row — and the discrimination
 * that makes that possible is the prefix gate below, which fires before any field is parsed.
 *
 * The brands are the other half. A `Found` cannot carry an empty digest or an id that is not
 * `R<round>.<n>`, because those types have no such inhabitant — the same device
 * `./verdict-marker.ts` uses to keep an unbound verdict unrepresentable rather than merely unlikely.
 */

import type {NonEmptyReadonlyArray, WireRead} from "./format.ts";

declare const QUESTION_ID: unique symbol;
declare const ROUND_DIGEST: unique symbol;
declare const MARKER_TIME: unique symbol;

/** A question's address: `R`, its round number, a dot, its 1-based position within that round. */
export type QuestionId = string & {readonly [QUESTION_ID]: true};
/** The round digest a marker binds: exactly 12 lowercase hex characters. */
export type RoundDigest = string & {readonly [ROUND_DIGEST]: true};
/** When the marker was stamped: ISO-8601 UTC, `Z`-suffixed. */
export type MarkerTime = string & {readonly [MARKER_TIME]: true};

const QUESTION_ID_RE = /^R([1-9][0-9]*)\.([1-9][0-9]*)$/;
const ROUND_DIGEST_RE = /^[0-9a-f]{12}$/;
const MARKER_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const questionId = (raw: string): QuestionId | null => {
	const value = raw.trim();
	return QUESTION_ID_RE.test(value) ? (value as QuestionId) : null;
};

export const roundDigest = (raw: string): RoundDigest | null => {
	const value = raw.trim();
	return ROUND_DIGEST_RE.test(value) ? (value as RoundDigest) : null;
};

export const markerTime = (raw: string): MarkerTime | null => {
	const value = raw.trim();
	return MARKER_TIME_RE.test(value) ? (value as MarkerTime) : null;
};

/**
 * The stamp for an instant, to the second.
 *
 * The sub-second field is dropped rather than carried: it is never read back for anything, and two
 * markers written in the same second are ordered by the comment ids the API assigns, not by this.
 */
export const stampOf = (now: Date): MarkerTime | null =>
	markerTime(now.toISOString().replace(/\.\d{3}Z$/, "Z"));

/** The round a question id addresses, so a caller never re-derives it from the string. */
export const roundOf = (id: QuestionId): number => Number(QUESTION_ID_RE.exec(id)?.[1] ?? "0");

/** The composed id for a question at `position` in `round`. Refuses a non-positive coordinate. */
export const composeQuestionId = (round: number, position: number): QuestionId | null =>
	questionId(`R${round}.${position}`);

/** The separator between a marker's fields, matching the shipped skill's own examples. */
export const FIELD_SEPARATOR = "·";

/**
 * Every line of `artifact` that opens with `<key>:`, in order, with a skill's bold emphasis
 * stripped — the same tolerance {@link reachesFor} applies, so the gate and the scan agree on what
 * a marker line is.
 */
export const markerLines = (artifact: string, key: string): ReadonlyArray<string> =>
	artifact
		.split("\n")
		.map((line) => line.trim().replace(/^\*{0,2}\s*/, ""))
		.filter((line) => line.startsWith(`${key}:`));

/** The first non-blank line, which is the only line a marker of these formats may occupy. */
export const firstNonBlankLine = (artifact: string): string | null =>
	artifact
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim() ?? null;

export const malformed = <A>(reason: string, evidence: string): WireRead<A> => ({
	_tag: "Malformed",
	reason,
	evidence,
});

export const absent = <A>(reason: string): WireRead<A> => ({_tag: "Absent", reason});

/**
 * Whether the artifact reaches for `key` at all.
 *
 * The gate runs before any field is read, so a body about something else is `Absent` and a body
 * whose first line opens with the key is judged — the split `./verdict-marker.ts` names as the
 * discrimination that carries the weight.
 */
export const reachesFor = (artifact: string, key: string): boolean => {
	const line = firstNonBlankLine(artifact) ?? "";
	return line.replace(/^\*{0,2}\s*/, "").startsWith(`${key}:`);
};

/** The bytes after `<key>:` on a marker line, with any bold emphasis stripped. */
export const payloadOf = (line: string, key: string): string =>
	line
		.replace(/^\*{0,2}\s*/, "")
		.slice(key.length + 1)
		.replace(/\*{0,2}$/, "")
		.trim();

/**
 * The three fields every stamp marker carries: `R2.3 @ a1b2c3d4e5f6 · 2026-08-09T18:36:48Z`.
 *
 * Shared by `grill-ruling` and `grill-answer`, whose bytes differ only in their key. The
 * supersede marker extends the same payload with a fourth field and parses it in its own module.
 */
export interface Stamp {
	readonly question: QuestionId;
	readonly digest: RoundDigest;
	readonly at: MarkerTime;
}

export type StampParse =
	| {readonly _tag: "Stamp"; readonly stamp: Stamp; readonly rest: string}
	| {readonly _tag: "Drift"; readonly reason: string};

/**
 * Parse `<id> @ <digest> · <rest>` out of a marker payload.
 *
 * The walk is stepwise rather than one alternation so each refusal names *which* field drifted;
 * telling a reader which half of a marker is wrong is the whole value of reporting it disregarded
 * rather than dropping it.
 */
export const parseStampHead = (
	payload: string,
):
	| {readonly question: QuestionId; readonly digest: RoundDigest; readonly rest: string}
	| string => {
	const [idPart, ...afterAt] = payload.split("@");
	if (afterAt.length === 0) {
		return 'the payload carries no "@ <digest>" — a marker bound to no round text attests nothing';
	}
	const id = questionId(idPart ?? "");
	if (id === null) {
		return `"${(idPart ?? "").trim()}" is not a question id — expected R<round>.<n>`;
	}
	const [digestPart, ...afterSeparator] = afterAt.join("@").split(FIELD_SEPARATOR);
	const digest = roundDigest(digestPart ?? "");
	if (digest === null) {
		return `"${(digestPart ?? "").trim()}" is not a round digest — expected 12 lowercase hex characters`;
	}
	if (afterSeparator.length === 0) {
		return `the marker carries no "${FIELD_SEPARATOR}"-separated field after the digest`;
	}
	return {question: id, digest, rest: afterSeparator.join(FIELD_SEPARATOR)};
};

/** The full three-field payload — `parseStampHead` plus the trailing timestamp. */
export const parseStamp = (payload: string): StampParse => {
	const head = parseStampHead(payload);
	if (typeof head === "string") return {_tag: "Drift", reason: head};
	const at = markerTime(head.rest);
	if (at === null) {
		return {
			_tag: "Drift",
			reason: `"${head.rest.trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Stamp", stamp: {question: head.question, digest: head.digest, at}, rest: ""};
};

/** The marker line for a stamp, under `key`. Round-trips through the format's own `read`. */
export const emitStamp = (key: string, stamp: Stamp): string =>
	`${key}: ${stamp.question} @ ${stamp.digest} ${FIELD_SEPARATOR} ${stamp.at}\n`;

/** One `<field>\t<value>` line per field — the `wire read` answer for a stamp format. */
export const renderStamp = (stamp: Stamp): NonEmptyReadonlyArray<string> => [
	`question\t${stamp.question}`,
	`digest\t${stamp.digest}`,
	`at\t${stamp.at}`,
];

export type StampFields =
	| {readonly _tag: "Fields"; readonly stamp: Stamp}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["question", "digest", "at"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/**
 * Parse `wire emit`'s stdin into a stamp: one `<key>: <value>` per line, in any order.
 *
 * Every rejection is a refusal rather than a default. A missing digest that silently composed an
 * unbound marker is how a caller emits a record weaker than the one it meant to — and the emitted
 * bytes would look perfectly well-formed.
 */
export const parseStampFields = (fields: string): StampFields => {
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

	const question = questionId(seen.get("question") ?? "");
	if (question === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("question") ?? ""}" is not a question id — expected R<round>.<n>`,
		};
	}
	const digest = roundDigest(seen.get("digest") ?? "");
	if (digest === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("digest") ?? ""}" is not a round digest — expected 12 lowercase hex characters`,
		};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at") ?? ""}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Fields", stamp: {question, digest, at}};
};

/** The total read shared by the two stamp formats, parameterised by the key that names each. */
export const readStamp = (artifact: string, key: string): WireRead<Stamp> => {
	if (!reachesFor(artifact, key)) {
		return absent(`the first line does not open with "${key}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const parsed = parseStamp(payloadOf(line, key));
	return parsed._tag === "Stamp"
		? {_tag: "Found", value: parsed.stamp}
		: malformed(parsed.reason, `first line: "${line}"`);
};
