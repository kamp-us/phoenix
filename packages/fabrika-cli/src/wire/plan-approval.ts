/**
 * The plan-approval marker — the comment a human on the control plane posts to approve one epic's
 * plan (ADR 0289).
 *
 *     plan-approved: #5843 @ 4d90e1bb27ac · 2026-08-16T07:16:03Z
 *
 * Three fields, and the digest is the load-bearing one: the approval binds the **ledger scope** the
 * plan gate judges, so a plan rewritten after the founder read it no longer matches and does not
 * inherit the approval. The epic is carried too, because a marker is bytes and bytes travel — a
 * comment quoting another epic's approval must never read as this epic's.
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
	FIELD_SEPARATOR,
	firstNonBlankLine,
	type MarkerTime,
	malformed,
	markerTime,
	payloadOf,
	reachesFor,
} from "./grill-marker.ts";

export type {MarkerTime} from "./grill-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "plan-approved";

/** The token between the epic and the digest, matching the `grill` markers' own binding word. */
const BINDS = "@";

declare const APPROVED_EPIC: unique symbol;
declare const SCOPE_DIGEST: unique symbol;

/** The epic an approval names: a positive integer. No other inhabitant exists. */
export type ApprovedEpic = number & {readonly [APPROVED_EPIC]: true};

/**
 * The scope digest an approval binds: exactly 12 lowercase hex.
 *
 * Fixed-width rather than a prefix match. The value only ever comes from `../plan/digest.ts`, which
 * emits exactly this width, so a shorter-or-longer one is a drift and reads `Malformed` — never a
 * value to compare loosely, because a loose compare is an approval that survives a re-plan.
 */
export type ScopeDigest = string & {readonly [SCOPE_DIGEST]: true};

const SCOPE_DIGEST_RE = /^[0-9a-f]{12}$/;

export const approvedEpic = (raw: number): ApprovedEpic | null =>
	Number.isInteger(raw) && raw > 0 ? (raw as ApprovedEpic) : null;

export const scopeDigest = (raw: string): ScopeDigest | null => {
	const value = raw.trim().toLowerCase();
	return SCOPE_DIGEST_RE.test(value) ? (value as ScopeDigest) : null;
};

export interface PlanApproval {
	readonly epic: ApprovedEpic;
	readonly digest: ScopeDigest;
	readonly at: MarkerTime;
}

export type PlanApprovalRead = WireRead<PlanApproval>;

/**
 * Read the approval marker out of a comment body. Total: `Found` | `Absent` | `Malformed`.
 *
 * The walk is stepwise so a refusal names which field drifted. A body that reaches for the key and
 * misses must never read as an epic nobody approved *nor* as one somebody did: the gate's whole
 * question is which of those two it is, and a drift is neither.
 */
export const read = (artifact: string): PlanApprovalRead => {
	if (!reachesFor(artifact, KEY)) {
		return absent(`the first line does not open with "${KEY}:" — no marker of this format`);
	}
	const line = firstNonBlankLine(artifact) ?? "";
	const evidence = `first line: "${line}"`;
	const payload = payloadOf(line, KEY);
	const [bindingPart, ...afterSeparator] = payload.split(FIELD_SEPARATOR);
	if (afterSeparator.length === 0) {
		return malformed(
			`the marker carries no "${FIELD_SEPARATOR}"-separated timestamp after the digest`,
			evidence,
		);
	}
	const binding = (bindingPart ?? "").trim();
	const [epicPart, ...afterBinds] = binding.split(BINDS);
	if (afterBinds.length !== 1) {
		return malformed(`"${binding}" is not an "#<epic> ${BINDS} <digest>" binding`, evidence);
	}
	const epicToken = (epicPart ?? "").trim();
	const epic = /^#[0-9]+$/.test(epicToken) ? approvedEpic(Number(epicToken.slice(1))) : null;
	if (epic === null) {
		return malformed(`"${epicToken}" is not an epic reference — expected "#<n>"`, evidence);
	}
	const digestToken = (afterBinds[0] ?? "").trim();
	const digest = scopeDigest(digestToken);
	if (digest === null) {
		return malformed(
			`"${digestToken}" is not a scope digest — expected 12 lowercase hex`,
			evidence,
		);
	}
	const at = markerTime(afterSeparator.join(FIELD_SEPARATOR));
	if (at === null) {
		return malformed(
			`"${afterSeparator.join(FIELD_SEPARATOR).trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`,
			evidence,
		);
	}
	return {_tag: "Found", value: {epic, digest, at}};
};

/** Compose the marker's first line. Round-trips through {@link read}. */
export const emit = ({epic, digest, at}: PlanApproval): string =>
	`${KEY}: #${epic} ${BINDS} ${digest} ${FIELD_SEPARATOR} ${at}\n`;

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

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;
const KEYS = ["epic", "digest", "at"] as const;
type FieldKey = (typeof KEYS)[number];

const isFieldKey = (key: string): key is FieldKey => (KEYS as ReadonlyArray<string>).includes(key);

/** Parse `wire emit`'s stdin into an approval. Every rejection is a refusal, never a default. */
export const parseFields = (fields: string): PlanApprovalFields => {
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

	const epicRaw = (seen.get("epic") ?? "").replace(/^#/, "").trim();
	const epic = /^[0-9]+$/.test(epicRaw) ? approvedEpic(Number(epicRaw)) : null;
	if (epic === null) {
		return {_tag: "Unusable", reason: `"${epicRaw}" is not an epic — expected a positive integer`};
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
