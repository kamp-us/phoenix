/**
 * The parts every verdict marker is built from — the brands, the namespace grammar, and the walk
 * from a comment body to `<namespace>: <polarity> …`.
 *
 * Two formats meet here: the PR-scoped marker (`./verdict-marker.ts`) and the range-scoped one
 * (`./range-verdict-marker.ts`). What differs between them is the *binding* — a head SHA against a
 * commit range — and nothing else, so everything up to and including the polarity, and everything
 * from the clause separator on, is written once. A second copy of this walk would drift silently:
 * both readers would still round-trip their own bytes while disagreeing about what a human wrote.
 */

import type {WireAbsent, WireMalformed} from "./format.ts";

declare const HEAD_SHA: unique symbol;
declare const CLAUSE: unique symbol;
declare const CONTENT_DIGEST: unique symbol;

/**
 * A git object name a marker is bound to: 7–40 hex characters, lowercased.
 *
 * Branded so a `Found` cannot carry `""`. The abbreviation floor is 7 because that is what git
 * itself abbreviates to and what v1's scanner accepted; shorter is ambiguous across a real
 * repository, and an ambiguous binding is not a binding.
 */
export type HeadSha = string & {readonly [HEAD_SHA]: true};

/** The trailing human clause. Branded for the same reason: a blank clause is not a clause. */
export type Clause = string & {readonly [CLAUSE]: true};

/**
 * The digest of the content a verdict was formed over: exactly 12 lowercase hex.
 *
 * Fixed-width rather than a prefix match, unlike {@link HeadSha}: a SHA is abbreviated by the tools
 * that print it, whereas this value only ever comes from `../review/content-binding.ts`, so a
 * shorter-or-longer one is a drift and reads as `Malformed`, never as a value to compare loosely.
 */
export type ContentDigest = string & {readonly [CONTENT_DIGEST]: true};

/** The reviewer's go/no-go. A third token is not a polarity — it is a drift. */
export type Polarity = "PASS" | "FAIL";

export const SHA_MIN = 7;
export const SHA_MAX = 40;

const HEX = /^[0-9a-f]+$/;
const CONTENT_HEX = /^[0-9a-f]{12}$/;

/** The content field's token, wherever it is read: on a marker line or off `wire emit`. */
export const CONTENT_PREFIX = "content:";

/** The conforming separator between the binding and the clause; the ASCII dashes are read tolerantly. */
export const CLAUSE_SEPARATOR = "—";
const SEPARATOR = /^(?:—|–|--|-)\s*/;

/**
 * The gates these formats serve: the `review` family, `check-epic-plan`, and `governance`.
 *
 * Each widening is additive — no existing marker's reading changes — and each namespace is its own
 * family rather than a `review-<gate>` member, because a verdict wearing another gate's namespace is
 * the family confusion the partition ruling removed (#4891). `governance` is admitted here (#5199)
 * ahead of the verb that will emit it: `ship scope` already derives it as a required namespace, so a
 * format that cannot carry it makes every governance-root PR permanently `blocked` at `ship gate`.
 * Nothing here grants emission authority — `review post` still refuses any namespace this PR's diff
 * did not derive, and `governance` is not in that image.
 */
const NAMESPACE = /^(review|check-epic-plan|governance)(-[a-z0-9]+)*$/;

/** The one sentence both formats name the admitted namespaces by, so their refusals cannot drift. */
export const NAMESPACE_PHRASE =
	'"review", "review-<gate>", "check-epic-plan" or "governance"' as const;

/**
 * The prefixes {@link openMarkerLine}'s first gate admits, which must widen with {@link NAMESPACE}
 * or a format can emit a marker it can never read back — the gate runs *before* the regex is tested.
 */
const NAMESPACE_PREFIXES = ["review", "check-epic-plan", "governance"];

export const isGateNamespace = (namespace: string): boolean => NAMESPACE.test(namespace);

/**
 * The emphasis a skill's bolding adds, and the `<namespace>:` prefix.
 *
 * The namespace class is deliberately wider than {@link NAMESPACE}: a token this admits and
 * {@link NAMESPACE} rejects becomes a `Malformed` naming the drift, one this turns away becomes an
 * `Absent`. Erring wide is what keeps `review_code:` from being reported as "no verdict here".
 */
const MARKER_LINE = /^\s*(\*{0,2})\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

export const headSha = (raw: string): HeadSha | null => {
	const value = raw.trim().toLowerCase();
	if (value.length < SHA_MIN || value.length > SHA_MAX || !HEX.test(value)) return null;
	return value as HeadSha;
};

export const contentDigest = (raw: string): ContentDigest | null => {
	const value = raw.trim().toLowerCase();
	return CONTENT_HEX.test(value) ? (value as ContentDigest) : null;
};

export const clause = (raw: string): Clause | null => {
	const value = raw.trim();
	return value === "" ? null : (value as Clause);
};

export const polarityOf = (token: string): Polarity | null => {
	const value = token.toUpperCase();
	return value === "PASS" || value === "FAIL" ? value : null;
};

export const malformed = (reason: string, evidence: string): WireMalformed => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** The marker is the artifact's first non-blank line — a marker merely quoted further down is not one. */
const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

export const takeToken = (rest: string): {readonly token: string; readonly after: string} => {
	const trimmed = rest.trimStart();
	const end = trimmed.search(/\s/);
	return end === -1
		? {token: trimmed, after: ""}
		: {token: trimmed.slice(0, end), after: trimmed.slice(end)};
};

/** A line that opens a marker of this family: its emphasis, its namespace, and what follows. */
export interface OpenedMarkerLine {
	readonly _tag: "Open";
	/** Quoted back in every later refusal, so a caller names the bytes it judged. */
	readonly evidence: string;
	readonly emphasis: string;
	readonly namespace: string;
	/** Everything after `<namespace>:`, starting at the polarity. */
	readonly rest: string;
}

export type MarkerLineRead = OpenedMarkerLine | WireAbsent | WireMalformed;

/** Walk a comment body to the marker line's namespace, or say it carries no marker of this family. */
export const openMarkerLine = (artifact: string): MarkerLineRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null) {
		return {_tag: "Absent", reason: "the artifact holds no non-blank line to carry a marker"};
	}
	const matched = MARKER_LINE.exec(line);
	const namespace = matched?.[2]?.toLowerCase() ?? "";
	const reaches = NAMESPACE_PREFIXES.some((prefix) => namespace.startsWith(prefix));
	if (matched === null || !reaches) {
		return {
			_tag: "Absent",
			reason:
				'the first line does not open with a "review…:", "check-epic-plan…:" or "governance…:" namespace — no marker of this format',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	return isGateNamespace(namespace)
		? {_tag: "Open", evidence, emphasis: matched[1] ?? "", namespace, rest: matched[3] ?? ""}
		: malformed(
				`the gate namespace "${namespace}" is not kebab-case ${NAMESPACE_PHRASE}`,
				evidence,
			);
};

/**
 * The trailing clause, once the binding has been taken off the line.
 *
 * A skill that bolds the whole marker closes it after the clause, so that closer belongs to the
 * emphasis rather than to the human's sentence. Stripped only when the line opened with one.
 */
export const readClause = (remainder: string, emphasis: string): Clause | null => {
	const tail = remainder.trim();
	const unemphasized =
		emphasis !== "" && tail.endsWith(emphasis) ? tail.slice(0, -emphasis.length) : tail;
	return clause(unemphasized.replace(SEPARATOR, ""));
};

/** Whether two head SHAs name the same commit — a prefix match in whichever direction is shorter. */
export const sameHead = (a: HeadSha, b: HeadSha): boolean => a.startsWith(b) || b.startsWith(a);
