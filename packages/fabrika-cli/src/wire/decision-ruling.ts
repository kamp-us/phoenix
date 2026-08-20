/**
 * The decision-ruling marker — the comment a human on the control plane posts to record that a
 * `type:decision` issue has been ruled, so the normal build lane picks it up instead of a driver
 * hand-driving it (ADR 0289's mechanism, over the surface the founder's 2026-08-16 scope addition on
 * epic #5843 added; #5842 is consolidated there).
 *
 *     decision-ruled: #6569 @ a1b2c3d4e5f6 · ruling:https://github.com/o/r/issues/6569#issuecomment-9 · 2026-08-20T05:11:02Z
 *
 * **One mechanism, two surfaces.** The binding half is `./issue-marker.ts`, the same walk
 * `./plan-approval.ts` reads through — `#<n> @ <digest>`, the number carried in the bytes so a quoted
 * marker cannot travel onto another issue. What is this format's own is the subject and the tail: the
 * number is a decision issue rather than an epic, the digest binds the **issue body that was ruled
 * on** rather than a ledger scope, and one extra field names the comment the ruling is written in.
 *
 * **The ruling field is why this marker is worth more than a label.** A builder that picks the issue
 * up reads the founder's own words at the URL the marker names, rather than inferring the choice from
 * a thread; it is the value `build claim --cites` takes, and the reason ADR 0300 calls a cited ruling
 * the thing that makes a decision buildable. The URL is checked against the issue the marker binds
 * here, in the read: a ruling recorded on some other issue rules nothing on this one, and admitting
 * one would let a single comment unlock every decision on the board.
 *
 * **The digest binds the issue body, and that is its honest limit.** It says the body has not been
 * rewritten under the ruling. It does not say the founder read any particular comment, and no marker
 * can. As with the plan approval, the marker is never proof on its own: what is honoured is these
 * bytes **plus** an author the control-plane roster resolved.
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
import {
	emitIssueMarker,
	issueField,
	type MarkedIssue,
	markedIssue,
	parseFieldLines,
	parseIssueBinding,
	type ScopeDigest,
	scopeDigest,
} from "./issue-marker.ts";

export type {MarkerTime} from "./grill-marker.ts";
export {type MarkedIssue, type ScopeDigest, scopeDigest} from "./issue-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "decision-ruled";

/** The token that opens the ruling field, so the tail's two fields are told apart by name. */
export const RULING_PREFIX = "ruling:";

declare const RULING_URL: unique symbol;

/** The comment a ruling is written in, as a GitHub issue-comment URL. */
export type RulingUrl = string & {readonly [RULING_URL]: true};

/**
 * The one grammar a ruling URL is written in — the same one `build claim --cites` takes, quoted in
 * every refusal that asks for one, so a founder never has to guess which of two shapes is meant.
 */
export const RULING_GRAMMAR =
	"https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<comment-id>";

const RULING_URL_RE =
	/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/([0-9]+)#issuecomment-([0-9]+)$/;

export const rulingUrl = (raw: string): RulingUrl | null =>
	RULING_URL_RE.test(raw.trim()) ? (raw.trim() as RulingUrl) : null;

/** The issue a ruling URL is recorded on. Total on the brand — the grammar guarantees the capture. */
export const rulingIssue = (url: RulingUrl): number => Number(RULING_URL_RE.exec(url)?.[1] ?? "0");

/** The comment id a ruling URL names, for a caller that re-reads the comment through the API. */
export const rulingComment = (url: RulingUrl): number =>
	Number(RULING_URL_RE.exec(url)?.[2] ?? "0");

export interface DecisionRuling {
	readonly issue: MarkedIssue;
	readonly digest: ScopeDigest;
	/** Always recorded on {@link DecisionRuling.issue} — the read refuses any other. */
	readonly ruling: RulingUrl;
	readonly at: MarkerTime;
}

export type DecisionRulingRead = WireRead<DecisionRuling>;

/**
 * Read the ruling marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * A body that reaches for the key and misses is `Malformed`, never `Absent`. The audience flip's
 * whole question is whether this issue was ruled, and a drifted marker is neither a ruling nor the
 * absence of one — folding it into "nobody ruled" would tell a founder who did rule that he never
 * did.
 */
export const read = (artifact: string): DecisionRulingRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const bound = parseIssueBinding(payloadOf(line, KEY), `"${RULING_PREFIX}<url>" field`);
	if (typeof bound === "string") return malformed(bound, evidence);

	const [rulingPart, ...afterRuling] = bound.rest.split(FIELD_SEPARATOR);
	if (afterRuling.length === 0) {
		return malformed(
			`the marker carries no "${FIELD_SEPARATOR}"-separated timestamp after the ruling`,
			evidence,
		);
	}
	const rulingToken = (rulingPart ?? "").trim();
	if (!rulingToken.startsWith(RULING_PREFIX)) {
		return malformed(
			`"${rulingToken}" does not open with "${RULING_PREFIX}" — a ruling nothing points at is a ruling a builder cannot read`,
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
	if (rulingIssue(ruling) !== bound.issue) {
		return malformed(
			`the ruling is recorded on #${rulingIssue(ruling)} but the marker binds #${bound.issue} — a ruling on another issue rules nothing here`,
			evidence,
		);
	}
	const at = markerTime(afterRuling.join(FIELD_SEPARATOR));
	if (at === null) {
		return malformed(
			`"${afterRuling.join(FIELD_SEPARATOR).trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {_tag: "Found", value: {issue: bound.issue, digest: bound.digest, ruling, at}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({issue, digest, ruling, at}: DecisionRuling): string =>
	emitIssueMarker(KEY, issue, digest, [`${RULING_PREFIX}${ruling}`, at]);

/**
 * Whether this marker rules `issue` **as `derived` now stands**.
 *
 * Both halves are equality. A marker naming another issue rules nothing here however fresh its
 * digest, and a digest that no longer matches is the re-scoped case: the body moved under the
 * ruling, so what the founder read is not what a builder would now build.
 */
export const rules = (ruling: DecisionRuling, issue: number, derived: string): boolean =>
	ruling.issue === issue && ruling.digest === derived.trim().toLowerCase();

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderRuling = (ruling: DecisionRuling): NonEmptyReadonlyArray<string> => [
	`issue\t${ruling.issue}`,
	`digest\t${ruling.digest}`,
	`ruling\t${ruling.ruling}`,
	`at\t${ruling.at}`,
];

export type DecisionRulingFields =
	| {readonly _tag: "Fields"; readonly ruling: DecisionRuling}
	| {readonly _tag: "Unusable"; readonly reason: string};

const KEYS = ["issue", "digest", "ruling", "at"] as const;

/** Parse `wire emit`'s stdin into a ruling. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): DecisionRulingFields => {
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
	const digest = scopeDigest(seen.get("digest") ?? "");
	if (digest === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("digest") ?? ""}" is not a scope digest — expected 12 lowercase hex`,
		};
	}
	const ruling = rulingUrl(seen.get("ruling") ?? "");
	if (ruling === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("ruling") ?? ""}" is not an issue-comment URL — the grammar is ${RULING_GRAMMAR}`,
		};
	}
	if (rulingIssue(ruling) !== issue) {
		return {
			_tag: "Unusable",
			reason: `the ruling is recorded on #${rulingIssue(ruling)} but the marker would bind #${issue} — a ruling on another issue rules nothing here`,
		};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at") ?? ""}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Fields", ruling: {issue, digest, ruling, at}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.ruling)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderRuling(result.value)} : result;
};

/** Re-exported so a caller building a marker brands the number through one door. */
export {markedIssue};
