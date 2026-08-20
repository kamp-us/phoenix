/**
 * The plan-approval marker — the comment a human on the control plane posts to approve one epic's
 * plan (ADR 0289).
 *
 *     plan-approved: #5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z
 *
 * Three fields, and the digest is the load-bearing one: the approval binds the **ledger scope** the
 * plan gate judges, so a plan rewritten after the founder read it no longer matches and does not
 * inherit the approval.
 *
 * The binding half — `#<epic> @ <digest>`, and the discipline of carrying the number in the bytes —
 * lives in `./issue-marker.ts`, which `./decision-ruling.ts` reads through too. What is written here
 * is only what is this format's own: the key, and a tail that is one timestamp.
 *
 * **The digest binds the ledger scope, not the plan's prose.** ADR 0289 states that limit itself and
 * it is repeated here so no reader over-reads the marker: what `../plan/digest.ts` serializes is the
 * epic's stories, the topology, and each child's labels, criteria count, stories and containment.
 * The plan summary is outside it.
 *
 * The marker is never proof on its own. What the gate honours is this marker **plus** an author the
 * `@<org>/<team>` roster resolved at write time carried — the same discipline `./cap-clearance.ts`
 * holds for a cleared round, and the reason an agent-authored marker approves nothing.
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
export {type ScopeDigest, scopeDigest} from "./issue-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "plan-approved";

/** The epic an approval names. An alias of the shared brand, not a second one — one marker family. */
export type ApprovedEpic = MarkedIssue;
export const approvedEpic = markedIssue;

export interface PlanApproval {
	readonly epic: ApprovedEpic;
	readonly digest: ScopeDigest;
	readonly at: MarkerTime;
}

export type PlanApprovalRead = WireRead<PlanApproval>;

/**
 * Read the approval marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * A body that reaches for the key and misses must never read as an epic nobody approved *nor* as one
 * somebody did: the gate's whole question is which of those two it is, and a drift is neither.
 */
export const read = (artifact: string): PlanApprovalRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const bound = parseIssueBinding(payloadOf(line, KEY), "timestamp");
	if (typeof bound === "string") return malformed(bound, evidence);
	const at = markerTime(bound.rest);
	if (at === null) {
		return malformed(
			`"${bound.rest.trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {_tag: "Found", value: {epic: bound.issue, digest: bound.digest, at}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({epic, digest, at}: PlanApproval): string =>
	emitIssueMarker(KEY, epic, digest, [at]);

/**
 * Whether this marker approves `epic`'s plan **as `derived` now stands**.
 *
 * Both halves are equality, and neither is a courtesy. A marker naming another epic approves nothing
 * here however fresh its digest — bytes travel, and a quoted approval is a comment on this issue like
 * any other. A digest that no longer matches is the re-plan case ADR 0289 names: not approved.
 */
export const approves = (approval: PlanApproval, epic: number, derived: string): boolean =>
	approval.epic === epic && approval.digest === derived.trim().toLowerCase();

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderApproval = (approval: PlanApproval): NonEmptyReadonlyArray<string> => [
	`epic\t${approval.epic}`,
	`digest\t${approval.digest}`,
	`at\t${approval.at}`,
];

export type PlanApprovalFields =
	| {readonly _tag: "Fields"; readonly approval: PlanApproval}
	| {readonly _tag: "Unusable"; readonly reason: string};

const KEYS = ["epic", "digest", "at"] as const;

/** Parse `wire emit`'s stdin into an approval. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): PlanApprovalFields => {
	const lines = parseFieldLines(fields, KEYS);
	if (lines._tag === "Unusable") return lines;
	const {seen} = lines;

	const epic = issueField(seen.get("epic") ?? "");
	if (epic === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("epic") ?? ""}" is not an epic — expected a positive integer`,
		};
	}
	const digest = scopeDigest(seen.get("digest") ?? "");
	if (digest === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("digest") ?? ""}" is not a scope digest — expected 12 lowercase hex`,
		};
	}
	const at = markerTime(seen.get("at") ?? "");
	if (at === null) {
		return {
			_tag: "Unusable",
			reason: `"${seen.get("at") ?? ""}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
		};
	}
	return {_tag: "Fields", approval: {epic, digest, at}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.approval)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderApproval(result.value)} : result;
};
