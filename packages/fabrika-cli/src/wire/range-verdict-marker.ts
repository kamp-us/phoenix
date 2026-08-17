/**
 * The range-scoped verdict marker — a verdict over a commit range, on the board.
 *
 *     review-child: PASS range:9f2c1ab..03135b9 content:2f1a9c4e0b7d — every criterion met
 *
 * A child's local review judges what its branch adds over the epic branch point, and its verdict
 * lands on the child issue (verdicts live on GitHub, ADR 0283). The two SHAs it names stop being
 * the epic branch's history the moment the range is merged in, so the durable claim is the
 * **content digest**, not the range — and the range is what tells a later reader which paths that
 * digest was taken over (`../review/content-binding.ts`, ADR 0276 + #5825).
 *
 * **The content field is mandatory here, and optional in `./verdict-marker.ts`.** That is not an
 * inconsistency: a PR-scoped marker whose digest is absent falls back to head equality, which is the
 * stricter rule; a range-scoped one has no such fallback, because the head it would fall back to is
 * exactly the thing a merge takes away. A range marker with no digest binds nothing at all, so it
 * is `Malformed` rather than a weaker verdict.
 *
 * **The two formats read each other's bytes as drift, loudly.** A range marker fed to
 * `./verdict-marker.ts` is `Malformed` ("bound to no head SHA"), and a head-bound marker fed to
 * this reader is `Malformed` ("carries no range"). Neither reads as `Absent`, so a verdict posted
 * on the wrong surface surfaces as a broken marker instead of as a surface nobody reviewed. Both
 * walk the same line grammar (`./marker-line.ts`), which is what keeps that symmetry true.
 */

import type {CommitRange} from "../io/git.ts";
import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	CLAUSE_SEPARATOR,
	type Clause,
	CONTENT_PREFIX,
	type ContentDigest,
	clause,
	contentDigest,
	type HeadSha,
	headSha,
	isGateNamespace,
	malformed,
	NAMESPACE_PHRASE,
	openMarkerLine,
	type Polarity,
	polarityOf,
	readClause,
	SHA_MAX,
	SHA_MIN,
	takeToken,
} from "./marker-line.ts";

/** The range field's token, and the two dots inside it. */
export const RANGE_PREFIX = "range:";
const RANGE_SEPARATOR = "..";

export interface RangeVerdictMarker {
	/** The gate that formed the verdict — the same family as the PR-scoped marker's. */
	readonly namespace: string;
	readonly polarity: Polarity;
	/** What the reviewer judged: everything `tip` adds since it diverged from `base`. */
	readonly range: CommitRange<HeadSha>;
	/** Never `null` — see the module docblock. */
	readonly content: ContentDigest;
	readonly clause: Clause;
}

export type RangeVerdictMarkerRead = WireRead<RangeVerdictMarker>;

/**
 * Split `<base>..<tip>` into two validated revisions.
 *
 * `indexOf` rather than `split`, so a three-dot spelling refuses instead of yielding a tip that
 * opens with a stray dot: the digest is taken over a three-dot range, but the marker writes the
 * two-dot form, and a reader that accepted both would let two spellings of the same claim exist.
 */
export const parseRange = (raw: string): CommitRange<HeadSha> | null => {
	const at = raw.indexOf(RANGE_SEPARATOR);
	if (at <= 0) return null;
	const base = headSha(raw.slice(0, at));
	const tip = headSha(raw.slice(at + RANGE_SEPARATOR.length));
	return base === null || tip === null ? null : {base, tip};
};

export const renderRange = (range: CommitRange<HeadSha>): string =>
	`${range.base}${RANGE_SEPARATOR}${range.tip}`;

/** Read the range-scoped marker out of a comment body. Total: `Found` | `Absent` | `Malformed`. */
export const read = (artifact: string): RangeVerdictMarkerRead => {
	const opened = openMarkerLine(artifact);
	if (opened._tag !== "Open") return opened;
	const {evidence, emphasis, namespace, rest} = opened;

	const {token: polarityToken, after: afterPolarity} = takeToken(rest);
	if (polarityToken === "") {
		return malformed(`"${namespace}:" carries no polarity — expected PASS or FAIL`, evidence);
	}
	const polarity = polarityOf(polarityToken);
	if (polarity === null) {
		return malformed(`"${polarityToken}" is not a polarity — expected PASS or FAIL`, evidence);
	}

	const {token: rangeToken, after: afterRange} = takeToken(afterPolarity);
	if (!rangeToken.toLowerCase().startsWith(RANGE_PREFIX)) {
		return malformed(
			`the ${polarity} marker carries no range — expected ${RANGE_PREFIX}<base>${RANGE_SEPARATOR}<tip>`,
			evidence,
		);
	}
	const range = parseRange(rangeToken.slice(RANGE_PREFIX.length));
	if (range === null) {
		return malformed(
			`"${rangeToken}" is not a range — expected two ${SHA_MIN}–${SHA_MAX} hex revisions around "${RANGE_SEPARATOR}"`,
			evidence,
		);
	}

	const {token: contentToken, after: afterContent} = takeToken(afterRange);
	if (!contentToken.toLowerCase().startsWith(CONTENT_PREFIX)) {
		return malformed(
			`the ${polarity} range marker carries no content binding — the SHAs alone do not survive the merge`,
			evidence,
		);
	}
	const content = contentDigest(contentToken.slice(CONTENT_PREFIX.length));
	if (content === null) {
		return malformed(
			`"${contentToken}" is not a content binding — expected ${CONTENT_PREFIX}<12 hex characters>`,
			evidence,
		);
	}

	const text = readClause(afterContent, emphasis);
	if (text === null) {
		return malformed(
			"the marker carries no trailing clause — the one field that says what the verdict means to a human",
			evidence,
		);
	}

	return {_tag: "Found", value: {namespace, polarity, range, content, clause: text}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({
	namespace,
	polarity,
	range,
	content,
	clause: text,
}: RangeVerdictMarker): string =>
	`${namespace}: ${polarity} ${RANGE_PREFIX}${renderRange(range)} ${CONTENT_PREFIX}${content} ${CLAUSE_SEPARATOR} ${text}\n`;

export type RangeVerdictMarkerFields =
	| {readonly _tag: "Fields"; readonly marker: RangeVerdictMarker}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
/** Every field is required — the range form has no optional half, which is the whole point of it. */
const KEYS = ["namespace", "polarity", "base", "tip", "content", "clause"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/** Parse `emit`'s stdin into a marker: one `<key>: <value>` per line, in any order. */
export const parseFields = (fields: string): RangeVerdictMarkerFields => {
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

	const namespace = (seen.get("namespace") ?? "").trim().toLowerCase();
	if (!isGateNamespace(namespace)) {
		return {_tag: "Unusable", reason: `"${namespace}" is not a ${NAMESPACE_PHRASE} namespace`};
	}
	const polarity = polarityOf((seen.get("polarity") ?? "").trim());
	if (polarity === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("polarity")}" is not a polarity — expected PASS or FAIL`,
		};
	}
	const base = headSha(seen.get("base") ?? "");
	const tip = headSha(seen.get("tip") ?? "");
	if (base === null || tip === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get(base === null ? "base" : "tip")}" is not a revision — expected ${SHA_MIN}–${SHA_MAX} hex characters`,
		};
	}
	const content = contentDigest(seen.get("content") ?? "");
	if (content === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("content")}" is not a content digest — expected 12 hex characters; a range verdict may not omit it`,
		};
	}
	const text = clause(seen.get("clause") ?? "");
	if (text === null) return {_tag: "Unusable", reason: "the trailing clause is blank"};

	return {_tag: "Fields", marker: {namespace, polarity, range: {base, tip}, content, clause: text}};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderMarker = (marker: RangeVerdictMarker): NonEmptyReadonlyArray<string> => [
	`namespace\t${marker.namespace}`,
	`polarity\t${marker.polarity}`,
	`base\t${marker.range.base}`,
	`tip\t${marker.range.tip}`,
	`content\t${marker.content}`,
	`clause\t${marker.clause}`,
];

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
