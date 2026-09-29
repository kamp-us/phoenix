/**
 * The routed-elsewhere record — a gate saying, at one head, that it owes this PR no verdict.
 *
 *     routed-elsewhere: review-ui @ 03135b91 — nothing under apps/site/src renders differently
 *
 * Three fields: the **namespace** the record resolves, the **head SHA** the emitter inspected, and
 * the clause saying *why* nothing was owed. It is not a verdict and deliberately carries no
 * polarity: a PASS claims a gate looked and found nothing wrong, this claims the gate's subject is
 * not in the diff at all. Folding the two would let "I judged nothing" ship as "I judged it and it
 * passed", which is the one thing the `review-ui` group's evidence-required emit path exists to
 * prevent.
 *
 * **Why the format exists.** `ship scope` raises the `ui` class off a path test that
 * cannot see whether pixels moved, so a PR whose only change under a declared `uiSurfaces` prefix is
 * a docblock requires a `review-ui` verdict — and `review-ui`'s emit path structurally cannot produce one:
 * `render` refuses zero surfaces, `post` requires a capture set. The namespace was unfillable and
 * `ship gate` blocks on absence, so such a PR was permanently unshippable. This
 * record is the sanctioned way to fill it: an attested, ACL-checked, head-bound "nothing renders
 * here".
 *
 * **Head-bound only, and never content-bound.** `review-ui` verdicts bind heads rather than diff
 * digests because they attest deployed pixels; this record follows them, which is also the strictly
 * stricter reading — every branch push voids the route and it must be re-attested against the new
 * tree. A record that survived a head move would be a claim about a diff nobody read.
 *
 * **The basis, when the record stands on something other than the diff.** A repo's
 * `reviewUi.whenNoPreview` rules can let a PR with no preview resolve the namespace without a render,
 * and a person reading the gate must be able to tell that apart from "nothing here renders". So the
 * record may carry one `basis:` token between the head and the clause: `hand-check`, where an
 * owner's screenshots at this head stood in for the render, or `skip`, where the repo's rules say no
 * rendered review is owed. Absent keeps the original meaning. A reader that predates the token reads
 * it as the first word of the clause, so the record still resolves `routed` there.
 *
 *     routed-elsewhere: review-ui @ 03135b91 basis:hand-check — the owner's screenshots at 03135b91
 *
 * The key is its own, not a `review…:` prefix, so `./verdict-marker.ts` reads these bytes as
 * `Absent` rather than as a verdict whose polarity drifted — and this reader is `Absent` on every
 * verdict marker for the same reason. Two formats, no overlap, no reading that turns one into the
 * other.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {absent, firstNonBlankLine, malformed, payloadOf, reachesFor} from "./grill-marker.ts";
import {
	CLAUSE_SEPARATOR,
	type Clause,
	clause,
	type HeadSha,
	headSha,
	isGateNamespace,
	NAMESPACE_PHRASE,
	readClause,
	SHA_MAX,
	SHA_MIN,
	takeToken,
} from "./marker-line.ts";

export type {Clause, HeadSha} from "./marker-line.ts";
export {clause, headSha} from "./marker-line.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "routed-elsewhere";

/** What a record stands on when it is not the diff alone. */
export const ROUTE_BASES = ["hand-check", "skip"] as const;
export type RouteBasis = (typeof ROUTE_BASES)[number];

const BASIS_PREFIX = "basis:";

const routeBasis = (raw: string): RouteBasis | null =>
	(ROUTE_BASES as ReadonlyArray<string>).includes(raw) ? (raw as RouteBasis) : null;

/**
 * Each routed namespace a lane's proof stood on a flagged route for, with its basis — the shape a
 * lane event line carries as `routedBasis`. Never empty: no flagged route is the field's absence.
 */
export type RoutedBasis = Readonly<Record<string, RouteBasis>>;

/**
 * Read a `routedBasis` value off a parsed event line: `null` unless it is a non-empty object whose
 * every key is one of `routed` and every value a basis — a partial read would flag the wrong row.
 */
export const readRoutedBasis = (
	value: unknown,
	routed: ReadonlyArray<string>,
): RoutedBasis | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length === 0) return null;
	const read: Record<string, RouteBasis> = {};
	for (const [namespace, raw] of entries) {
		const basis = typeof raw === "string" ? routeBasis(raw) : null;
		if (basis === null || !routed.includes(namespace)) return null;
		read[namespace] = basis;
	}
	return read;
};

export interface RoutedElsewhere {
	/** The required namespace this record resolves — `review-ui` is the only one `ship gate` admits. */
	readonly namespace: string;
	readonly sha: HeadSha;
	/** Why the gate owes no verdict at this head. Blank is not a reason. */
	readonly clause: Clause;
	/** Absent where the record rests on the diff alone; see the module docblock. */
	readonly basis?: RouteBasis;
}

export type RoutedElsewhereRead = WireRead<RoutedElsewhere>;

/**
 * Read the record out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * Stepwise so a refusal names which field drifted, and — as everywhere in this family — a body
 * reaching for the key and missing is `Malformed`, never `Absent`: a drifted record read as "no
 * record here" leaves the operator staring at a namespace the gate calls absent while a comment on
 * the PR says otherwise.
 */
export const read = (artifact: string): RoutedElsewhereRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const payload = payloadOf(line, KEY);

	const {token: namespaceToken, after: afterNamespace} = takeToken(payload);
	if (namespaceToken === "") {
		return malformed(`"${KEY}:" names no namespace — a record resolves one gate`, evidence);
	}
	const namespace = namespaceToken.toLowerCase();
	if (!isGateNamespace(namespace)) {
		return malformed(`"${namespace}" is not a ${NAMESPACE_PHRASE} namespace`, evidence);
	}

	const bound = afterNamespace.trimStart();
	if (!bound.startsWith("@")) {
		return malformed(
			`the ${namespace} record is bound to no head SHA — a record with no "@ <sha>" attests no tree`,
			evidence,
		);
	}
	const {token: shaToken, after: afterSha} = takeToken(bound.slice(1));
	const sha = shaToken === "" ? null : headSha(shaToken);
	if (sha === null) {
		return malformed(
			`"${shaToken}" is not a head SHA — expected ${SHA_MIN}–${SHA_MAX} hex characters`,
			evidence,
		);
	}

	const {token: basisToken, after: afterBasis} = takeToken(afterSha);
	let basis: RouteBasis | undefined;
	let rest = afterSha;
	if (basisToken.toLowerCase().startsWith(BASIS_PREFIX)) {
		const named = routeBasis(basisToken.slice(BASIS_PREFIX.length).toLowerCase());
		if (named === null) {
			return malformed(
				`"${basisToken}" names no basis — expected ${ROUTE_BASES.map((name) => `${BASIS_PREFIX}${name}`).join(" or ")}`,
				evidence,
			);
		}
		basis = named;
		rest = afterBasis;
	}

	// `payloadOf` already stripped a skill's bold emphasis, so the clause read needs none.
	const text = readClause(rest, "");
	if (text === null) {
		return malformed(
			"the record carries no trailing clause — the one field that says why no verdict is owed",
			evidence,
		);
	}
	return {
		_tag: "Found",
		value:
			basis === undefined ? {namespace, sha, clause: text} : {namespace, sha, clause: text, basis},
	};
};

/**
 * The record on `artifact` when it resolves `namespace`, else `null`.
 *
 * The membership question a caller asking "does this comment route *this* namespace elsewhere?"
 * actually has — one nullable answer rather than three, because `Absent` and `Malformed` both mean
 * *not this namespace's record* to it. A body reaching for the format and failing it is `null` too:
 * reading a drifted record as a route is the permissive direction, and a permissive read here
 * resolves a namespace nobody attested.
 */
export const readNamespaced = (artifact: string, namespace: string): RoutedElsewhere | null => {
	const parsed = read(artifact);
	return parsed._tag === "Found" && parsed.value.namespace === namespace ? parsed.value : null;
};

/** Compose the record's first line. Round-trips through {@link read}. */
export const emit = ({namespace, sha, clause: text, basis}: RoutedElsewhere): string =>
	`${KEY}: ${namespace} @ ${sha}${basis === undefined ? "" : ` ${BASIS_PREFIX}${basis}`} ${CLAUSE_SEPARATOR} ${text}\n`;

export const renderRecord = (record: RoutedElsewhere): NonEmptyReadonlyArray<string> => [
	`namespace\t${record.namespace}`,
	`sha\t${record.sha}`,
	`clause\t${record.clause}`,
	...(record.basis === undefined ? [] : [`basis\t${record.basis}`]),
];

export type RoutedElsewhereFields =
	| {readonly _tag: "Fields"; readonly record: RoutedElsewhere}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["namespace", "sha", "clause", "basis"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/** Parse `wire emit`'s stdin into a record. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): RoutedElsewhereFields => {
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

	const namespace = (seen.get("namespace") ?? "").trim().toLowerCase();
	if (!isGateNamespace(namespace)) {
		return {_tag: "Unusable", reason: `"${namespace}" is not a ${NAMESPACE_PHRASE} namespace`};
	}
	const sha = headSha(seen.get("sha") ?? "");
	if (sha === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("sha") ?? ""}" is not a head SHA — expected ${SHA_MIN}–${SHA_MAX} hex characters`,
		};
	}
	const text = clause(seen.get("clause") ?? "");
	if (text === null) {
		return {_tag: "Unusable", reason: "the trailing clause is blank"};
	}
	const declared = seen.get("basis");
	if (declared === undefined) return {_tag: "Fields", record: {namespace, sha, clause: text}};
	const basis = routeBasis(declared.trim().toLowerCase());
	if (basis === null) {
		return {
			_tag: "Unusable",
			reason: `"${declared}" is not a basis — expected ${ROUTE_BASES.join(" or ")}`,
		};
	}
	return {_tag: "Fields", record: {namespace, sha, clause: text, basis}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.record)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderRecord(result.value)} : result;
};
