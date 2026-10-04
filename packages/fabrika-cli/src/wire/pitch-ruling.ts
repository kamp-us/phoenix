/**
 * The pitch-ruling pointer — the comment triage posts on a parentless feature whose pitch a founder
 * ruling already covers, so `guard pitch-guard check` can find that ruling.
 *
 *     pitch-ruled: #8 · ruling:<ruling-comment-url>
 *
 * Two fields: the **feature** the pointer is posted on, and the **comment the ruling is written in**,
 * as the issue-comment URL `./decision-ruling.ts` spells out.
 * The number rides in the bytes for the reason every marker here carries one: a pointer quoted onto
 * another issue must not read as that issue's.
 *
 * **A pointer, never an approval.** Anyone who can comment can post these bytes, so the format
 * carries no authority and its author is not read. What passes a feature is the ruling at the URL,
 * which `../guard/pitch.ts` verifies; this module only says where to look.
 *
 * The ruling field is `./decision-ruling.ts`'s own URL brand. A second grammar for "the comment a
 * ruling is written in" would let the two markers disagree about one URL.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10294#issuecomment-5974132205
 */

import {RULING_GRAMMAR, type RulingUrl, rulingUrl} from "./decision-ruling.ts";
import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	absent,
	FIELD_SEPARATOR,
	firstNonBlankLine,
	malformed,
	payloadOf,
	reachesFor,
} from "./grill-marker.ts";
import {issueField, type MarkedIssue, markedIssue, parseFieldLines} from "./issue-marker.ts";

export type {RulingUrl} from "./decision-ruling.ts";
export {rulingUrl} from "./decision-ruling.ts";
export {type MarkedIssue, markedIssue} from "./issue-marker.ts";

/** The key that names these bytes. */
export const KEY = "pitch-ruled";

/** The token that opens the ruling field, shared in spelling with the `decision-ruled` marker. */
export const RULING_PREFIX = "ruling:";

/**
 * The pointer as it is written, quoted in every message that asks for one. The URL is left as a
 * placeholder because its own grammar reuses `<n>` for an issue that need not be the feature.
 */
export const POINTER_GRAMMAR = `${KEY}: #<n> ${FIELD_SEPARATOR} ${RULING_PREFIX}<ruling-comment-url>`;

export interface PitchRuling {
	/** The feature the pointer is posted on. */
	readonly issue: MarkedIssue;
	/** The comment the founder's ruling is written in, on this issue or another. */
	readonly ruling: RulingUrl;
}

export type PitchRulingRead = WireRead<PitchRuling>;

/**
 * Read the pointer out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * A body that reaches for the key and misses is `Malformed`, never `Absent`: triage meant to cover
 * the pitch, and a drifted pointer read as "no pointer here" would report the pitch as plainly
 * missing to the triager who just linked the ruling.
 */
export const read = (artifact: string): PitchRulingRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const fields = payloadOf(line, KEY).split(FIELD_SEPARATOR);
	if (fields.length !== 2) {
		return malformed(
			`the marker is not two "${FIELD_SEPARATOR}"-separated fields — expected ${POINTER_GRAMMAR}`,
			evidence,
		);
	}
	const issueToken = (fields[0] ?? "").trim();
	const issue = /^#[0-9]+$/.test(issueToken) ? markedIssue(Number(issueToken.slice(1))) : null;
	if (issue === null) {
		return malformed(`"${issueToken}" is not an issue reference — expected "#<n>"`, evidence);
	}
	const rulingToken = (fields[1] ?? "").trim();
	if (!rulingToken.startsWith(RULING_PREFIX)) {
		return malformed(
			`"${rulingToken}" does not open with "${RULING_PREFIX}" — a pointer that links no ruling points at nothing`,
			evidence,
		);
	}
	const ruling = rulingUrl(rulingToken.slice(RULING_PREFIX.length));
	if (ruling === null) {
		return malformed(
			`"${rulingToken.slice(RULING_PREFIX.length).trim()}" is not an issue-comment URL — the grammar is ${RULING_GRAMMAR}`,
			evidence,
		);
	}
	return {_tag: "Found", value: {issue, ruling}};
};

/** Compose the pointer's first line. Round-trips through {@link read}. */
export const emit = ({issue, ruling}: PitchRuling): string =>
	`${KEY}: #${issue} ${FIELD_SEPARATOR} ${RULING_PREFIX}${ruling}\n`;

export const renderPointer = (pointer: PitchRuling): NonEmptyReadonlyArray<string> => [
	`issue\t${pointer.issue}`,
	`ruling\t${pointer.ruling}`,
];

export type PitchRulingFields =
	| {readonly _tag: "Fields"; readonly pointer: PitchRuling}
	| {readonly _tag: "Unusable"; readonly reason: string};

const KEYS = ["issue", "ruling"] as const;

/** Parse `wire emit`'s stdin into a pointer. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): PitchRulingFields => {
	const lines = parseFieldLines(fields, KEYS);
	if (lines._tag === "Unusable") return lines;
	const {seen} = lines;

	const issue = issueField(seen.get("issue") ?? "");
	if (issue === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("issue") ?? ""}" is not an issue — expected a positive integer`,
		};
	}
	const ruling = rulingUrl(seen.get("ruling") ?? "");
	if (ruling === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("ruling") ?? ""}" is not an issue-comment URL — the grammar is ${RULING_GRAMMAR}`,
		};
	}
	return {_tag: "Fields", pointer: {issue, ruling}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.pointer)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderPointer(result.value)} : result;
};
