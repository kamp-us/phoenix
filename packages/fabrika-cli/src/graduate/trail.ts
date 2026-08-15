/**
 * The decision trail: what a resolved source normalizes into, and the digest taken over it.
 *
 * Both sibling artifacts — a `grilling` session and a `wayfinding` map — reduce to one shape here:
 * a decision carries a `ref`, a `provenance` word from a closed two-member set, and its `text`. The
 * mapping functions below take the **sibling resolver's own output** as their input; nothing in this
 * module parses a session comment or a map body, because whether a question is `ruled` is already
 * answered by a verb whose whole design is answering it fail-closed against the ACL. A second parser
 * here would be a second answer to that question, and the two could disagree — which on this question
 * means one of them licenses synthesizing over an unproven ruling.
 *
 * <!-- anchor: DIGEST-NEUTRALITY --> **Both digests are neutral to every write this group makes.**
 * The digested bytes are decision triples exactly as the resolver returned them — never a comment, a
 * marker, a label or any rendered issue text. It must be so: `graduate emit` binds its marker to a
 * digest the *next* run recomputes, so a digest covering the source's comments would be changed by
 * the marker comment that emission itself posts, and every re-run would read the trail as fresh and
 * file a second spec.
 */

import {createHash} from "node:crypto";
import type {DecisionEntry, OutOfScopeEntry} from "../map/body.ts";
import type {Ticket} from "../map/frontier.ts";

/** The two words a decision's authority may carry. There is deliberately no word for *inferred*. */
export type Provenance = "ruled" | "established";

/** One resolved decision, in trail order. These three fields are exactly what the digest covers. */
export interface DecisionRow {
	readonly ref: string;
	readonly provenance: Provenance;
	readonly text: string;
}

/** One decision still open, carrying the resolver's own state word verbatim. */
export interface UnresolvedRow {
	readonly ref: string;
	readonly state: string;
}

/** The three readiness answers. All three are answers, and all three exit `0`. */
export type Readiness = "ready" | "blocked" | "empty";

/** Which sibling the trail was resolved through. */
export type SourceKind = "grilling" | "map";

export interface Trail {
	readonly source: number;
	readonly kind: SourceKind;
	readonly readiness: Readiness;
	readonly trailDigest: string;
	readonly decisions: ReadonlyArray<DecisionRow>;
	readonly unresolved: ReadonlyArray<UnresolvedRow>;
	readonly outOfScope: ReadonlyArray<OutOfScopeEntry>;
	readonly counts: {
		readonly ruled: number;
		readonly established: number;
		readonly unresolved: number;
	};
}

/**
 * The digest of a set of decision entries: the first 12 hex characters of the SHA-256 of each
 * entry's `ref`, `provenance` and `text` in trail order, joined by `\n`, LF-normalized, with
 * trailing whitespace stripped per line.
 *
 * One algorithm, two scopes: over every decision on the trail it is the **trail digest**, and over
 * only the decisions rendered into a filed spec it is the **spec digest**. When a spec carries the
 * whole trail the two are equal by construction.
 */
export const digestOfDecisions = (rows: ReadonlyArray<DecisionRow>): string =>
	createHash("sha256")
		.update(
			rows
				.flatMap((row) => [row.ref, row.provenance, row.text])
				.join("\n")
				.replace(/\r\n/g, "\n")
				.split("\n")
				.map((line) => line.replace(/[ \t]+$/, ""))
				.join("\n"),
		)
		.digest("hex")
		.slice(0, 12);

/**
 * <!-- anchor: READINESS-IS-NOT-THE-FRONTIER-TOKEN --> Readiness, computed in this order.
 *
 * It is **not** a relay of the sibling's `frontier` token. A map whose every ticket was *retired*
 * reads `clear` there and carries nothing to synthesize, which is `empty` here; and a session's
 * `facts-pending` and a map's `lanes-pending` both collapse to `blocked`, because this verb does not
 * care who owes the answer, only whether one is outstanding.
 */
export const readinessOf = (
	decisions: ReadonlyArray<DecisionRow>,
	unresolved: ReadonlyArray<UnresolvedRow>,
): Readiness => {
	if (unresolved.length > 0) return "blocked";
	return decisions.length === 0 ? "empty" : "ready";
};

export const trailOf = (input: {
	readonly source: number;
	readonly kind: SourceKind;
	readonly decisions: ReadonlyArray<DecisionRow>;
	readonly unresolved: ReadonlyArray<UnresolvedRow>;
	readonly outOfScope: ReadonlyArray<OutOfScopeEntry>;
}): Trail => ({
	source: input.source,
	kind: input.kind,
	readiness: readinessOf(input.decisions, input.unresolved),
	trailDigest: digestOfDecisions(input.decisions),
	decisions: input.decisions,
	unresolved: input.unresolved,
	outOfScope: input.outOfScope,
	counts: {
		ruled: input.decisions.filter((row) => row.provenance === "ruled").length,
		established: input.decisions.filter((row) => row.provenance === "established").length,
		unresolved: input.unresolved.length,
	},
});

/** One question row as the `grill read` resolver reports it — the only shape read here. */
export interface ResolvedQuestion {
	readonly id: string;
	readonly text: string;
	readonly state: string;
}

export interface Normalized {
	readonly decisions: ReadonlyArray<DecisionRow>;
	readonly unresolved: ReadonlyArray<UnresolvedRow>;
}

/**
 * A session's resolved questions, normalized.
 *
 * `superseded` is omitted entirely rather than counted either way — a retired question is neither a
 * decision nor an open one.
 */
export const fromSession = (questions: ReadonlyArray<ResolvedQuestion>): Normalized => {
	const decisions: DecisionRow[] = [];
	const unresolved: UnresolvedRow[] = [];
	for (const question of questions) {
		if (question.state === "ruled") {
			decisions.push({ref: question.id, provenance: "ruled", text: question.text});
			continue;
		}
		if (question.state === "answered") {
			decisions.push({ref: question.id, provenance: "established", text: question.text});
			continue;
		}
		if (question.state === "superseded") continue;
		unresolved.push({ref: question.id, state: question.state});
	}
	return {decisions, unresolved};
};

/**
 * A map's decisions and tickets, normalized — two different parts of the artifact.
 *
 * <!-- anchor: MAP-DECISIONS-COME-FROM-THE-BODY --> The decisions come from the body's
 * `## Decisions` section and never from the ticket states, which is why this takes the parsed body's
 * entries rather than `map read`'s stdout: that answer carries `tickets`, `outOfScope` and the
 * frontier token but **no** decisions array, so a design reading them off it could not produce a
 * `ruled` row at all and every founder ruling relayed onto a map would render as an agent's finding.
 *
 * A `graduated` ticket is omitted because its answer is already a `## Decisions` entry, and counting
 * both would double it; a `retired` one is omitted because its record is the out-of-scope section.
 */
export const fromMap = (
	entries: ReadonlyArray<DecisionEntry>,
	tickets: ReadonlyArray<Ticket>,
): Normalized => ({
	decisions: entries.map((entry) =>
		entry.authority._tag === "Ruled"
			? {
					ref: `#${entry.authority.session} ${entry.authority.questionId}`,
					provenance: "ruled" as const,
					text: entry.text,
				}
			: {
					ref: `#${entry.authority.ticket}`,
					provenance: "established" as const,
					text: entry.text,
				},
	),
	unresolved: tickets
		.filter((ticket) => ticket.state !== "graduated" && ticket.state !== "retired")
		.map((ticket) => ({ref: `#${ticket.number}`, state: ticket.state})),
});

const HEX_12 = /^[0-9a-f]{12}$/;

/** A `--trail` file read back into a trail, or the reason those bytes are not one. */
export type TrailDocument =
	| {readonly _tag: "Trail"; readonly value: Trail}
	| {readonly _tag: "Unreadable"; readonly reason: string}
	/** A field the digest is taken over is missing — the binding is unbindable, not malformed. */
	| {readonly _tag: "Unbindable"; readonly reason: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a `graduate trail` answer back off disk, totally.
 *
 * The `Unbindable` answer is separate from `Unreadable` because they seat different codes: a file
 * that will not parse is a precondition that could not be read, and a decision missing one of the
 * three digested fields is a proven fact about a trail that *did* parse.
 */
export const parseTrailDocument = (text: string): TrailDocument => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {_tag: "Unreadable", reason: `it is not JSON (${(error as Error).message})`};
	}
	if (!isRecord(parsed)) return {_tag: "Unreadable", reason: "it is not a JSON object"};

	const rows = parsed.decisions;
	if (!Array.isArray(rows)) {
		return {_tag: "Unreadable", reason: "it carries no `decisions` array"};
	}
	const decisions: DecisionRow[] = [];
	for (const row of rows) {
		if (!isRecord(row)) return {_tag: "Unreadable", reason: "a `decisions` entry is not an object"};
		for (const field of ["ref", "provenance", "text"] as const) {
			if (typeof row[field] !== "string" || (row[field] as string).trim() === "") {
				return {_tag: "Unbindable", reason: field};
			}
		}
		const provenance = row.provenance as string;
		if (provenance !== "ruled" && provenance !== "established") {
			return {_tag: "Unbindable", reason: "provenance"};
		}
		decisions.push({ref: row.ref as string, provenance, text: row.text as string});
	}

	const digest = parsed.trailDigest;
	if (typeof digest !== "string" || !HEX_12.test(digest)) {
		return {_tag: "Unbindable", reason: "trailDigest"};
	}

	const unresolvedRows = Array.isArray(parsed.unresolved) ? parsed.unresolved : [];
	const unresolved = unresolvedRows.flatMap((row): UnresolvedRow[] =>
		isRecord(row) && typeof row.ref === "string" && typeof row.state === "string"
			? [{ref: row.ref, state: row.state}]
			: [],
	);
	const outOfScopeRows = Array.isArray(parsed.outOfScope) ? parsed.outOfScope : [];
	const outOfScope = outOfScopeRows.flatMap((row): OutOfScopeEntry[] =>
		isRecord(row) &&
		typeof row.direction === "string" &&
		typeof row.reason === "string" &&
		typeof row.recordedAt === "string"
			? [{direction: row.direction, reason: row.reason, recordedAt: row.recordedAt}]
			: [],
	);

	const readiness = parsed.readiness;
	return {
		_tag: "Trail",
		value: {
			source: typeof parsed.source === "number" ? parsed.source : 0,
			kind: parsed.kind === "map" ? "map" : "grilling",
			readiness:
				readiness === "blocked" || readiness === "empty" || readiness === "ready"
					? readiness
					: readinessOf(decisions, unresolved),
			trailDigest: digest,
			decisions,
			unresolved,
			outOfScope,
			counts: {
				ruled: decisions.filter((row) => row.provenance === "ruled").length,
				established: decisions.filter((row) => row.provenance === "established").length,
				unresolved: unresolved.length,
			},
		},
	};
};
