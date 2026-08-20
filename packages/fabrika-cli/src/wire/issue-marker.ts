/**
 * The vocabulary and the walk the **issue-bound** markers share: `<key>: #<n> @ <digest> · …`.
 *
 * Two formats meet here — `./plan-approval.ts`, where the number is an epic and the digest binds its
 * ledger scope, and `./decision-ruling.ts`, where the number is a decision issue and the digest binds
 * the body that was ruled on. What differs between them is the *tail*: an approval carries a stamp
 * and nothing else, a ruling carries the comment its authority is written in as well. Everything up
 * to and including the digest is written once, for the reason `./marker-line.ts` states about its own
 * pair — a second copy of this walk would drift silently, each reader still round-tripping its own
 * bytes while disagreeing about what a human wrote.
 *
 * **The `#<n>` half is never a courtesy field.** A marker is bytes and bytes travel: a comment
 * quoting another issue's marker must not read as this issue's, so the number is carried in the
 * bytes and compared, never inferred from where the comment was found.
 *
 * The brands are the other half of that discipline. A `Found` cannot carry an empty digest or a
 * zero issue, because those types have no such inhabitant.
 */

import type {NonEmptyReadonlyArray} from "./format.ts";
import {FIELD_SEPARATOR} from "./grill-marker.ts";

declare const MARKED_ISSUE: unique symbol;
declare const SCOPE_DIGEST: unique symbol;

/** The issue a marker names: a positive integer. No other inhabitant exists. */
export type MarkedIssue = number & {readonly [MARKED_ISSUE]: true};

/**
 * The digest a marker binds: exactly 12 lowercase hex.
 *
 * Fixed-width rather than a prefix match. Every value comes from a derivation that emits exactly this
 * width, so a shorter-or-longer one is a drift and reads `Malformed` — never a value to compare
 * loosely, because a loose compare is a marker that survives the thing it bound being rewritten.
 */
export type ScopeDigest = string & {readonly [SCOPE_DIGEST]: true};

/** The token between the issue and the digest, matching the `grill` markers' own binding word. */
export const BINDS = "@";

const SCOPE_DIGEST_RE = /^[0-9a-f]{12}$/;

export const markedIssue = (raw: number): MarkedIssue | null =>
	Number.isInteger(raw) && raw > 0 ? (raw as MarkedIssue) : null;

export const scopeDigest = (raw: string): ScopeDigest | null => {
	const value = raw.trim().toLowerCase();
	return SCOPE_DIGEST_RE.test(value) ? (value as ScopeDigest) : null;
};

export interface IssueBinding {
	readonly issue: MarkedIssue;
	readonly digest: ScopeDigest;
	/** Everything past the first field separator, for the format's own tail to parse. */
	readonly rest: string;
}

/**
 * Parse `#<n> @ <digest> · <rest>` out of a marker payload, or say which field drifted.
 *
 * The walk is stepwise rather than one alternation so each refusal names *which* field is wrong;
 * telling a reader which half of a marker drifted is the whole value of reporting it disregarded
 * rather than dropping it. `noun` names what the format expects after the digest, so a refusal
 * points at the field the reader was actually looking for.
 */
export const parseIssueBinding = (payload: string, noun: string): IssueBinding | string => {
	const [bindingPart, ...afterSeparator] = payload.split(FIELD_SEPARATOR);
	if (afterSeparator.length === 0) {
		return `the marker carries no "${FIELD_SEPARATOR}"-separated ${noun} after the digest`;
	}
	const binding = (bindingPart ?? "").trim();
	const [issuePart, ...afterBinds] = binding.split(BINDS);
	if (afterBinds.length !== 1) {
		return `"${binding}" is not an "#<n> ${BINDS} <digest>" binding`;
	}
	const issueToken = (issuePart ?? "").trim();
	const issue = /^#[0-9]+$/.test(issueToken) ? markedIssue(Number(issueToken.slice(1))) : null;
	if (issue === null) {
		return `"${issueToken}" is not an issue reference — expected "#<n>"`;
	}
	const digestToken = (afterBinds[0] ?? "").trim();
	const digest = scopeDigest(digestToken);
	if (digest === null) {
		return `"${digestToken}" is not a scope digest — expected 12 lowercase hex`;
	}
	return {issue, digest, rest: afterSeparator.join(FIELD_SEPARATOR)};
};

/** Compose a marker's first line: the binding, then this format's tail fields, separator-joined. */
export const emitIssueMarker = (
	key: string,
	issue: MarkedIssue,
	digest: ScopeDigest,
	tail: NonEmptyReadonlyArray<string>,
): string =>
	`${key}: #${issue} ${BINDS} ${digest} ${tail.map((field) => `${FIELD_SEPARATOR} ${field}`).join(" ")}\n`;

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;

export type FieldLines<K extends string> =
	| {readonly _tag: "Lines"; readonly seen: ReadonlyMap<K, string>}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Parse `wire emit`'s stdin into a field map over `keys`, in any order.
 *
 * Every rejection is a refusal rather than a default: a field silently defaulted composes bytes that
 * look perfectly well-formed and attest less than the caller meant. A key given twice is refused for
 * the same reason — which one is the field is undecidable, and picking one is a guess.
 */
export const parseFieldLines = <K extends string>(
	fields: string,
	keys: ReadonlyArray<K>,
): FieldLines<K> => {
	const seen = new Map<K, string>();
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const matched = FIELD_LINE.exec(line);
		const key = matched?.[1]?.toLowerCase() ?? "";
		if (matched === null || !(keys as ReadonlyArray<string>).includes(key)) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} is not a "<field>: <value>" line over ${keys.join(", ")}: "${line}"`,
			};
		}
		if (seen.has(key as K)) {
			return {
				_tag: "Unusable",
				reason: `"${key}" is given twice — which one is the field is undecidable`,
			};
		}
		seen.set(key as K, matched[2] ?? "");
	}
	return {_tag: "Lines", seen};
};

/** An issue number off a field line, with or without its `#`. */
export const issueField = (raw: string): MarkedIssue | null => {
	const value = raw.replace(/^#/, "").trim();
	return /^[0-9]+$/.test(value) ? markedIssue(Number(value)) : null;
};
