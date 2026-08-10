/**
 * The supersede marker — the comment `grill round --supersedes` posts after the round it wrote.
 *
 *     grill-superseded: R1.4 @ 7c1d4a9b2e60 · round 2 · 2026-08-09T18:36:48Z
 *
 * One line per retired question, in a comment of its own. It asserts **no answer at all** — only
 * that a question was retired — which is why it is a third format rather than a flag on the other
 * two. `grill read` resolves `state: "superseded"` and `supersededBy` from these bytes and from
 * nothing else, never from a round comment's prose.
 *
 * **The digest is the RETIRED question's round, captured at retirement — not the retiring round's.**
 * The marker's job is to record *which text was retired*, so binding the round being written would
 * record nothing about the thing removed.
 *
 * **Why the record is a new comment and never an edit.** The round digest is neutral to every write
 * this group makes, and that neutrality rests on nothing being edited: marking retirement by editing
 * round *x*'s comment would change text its digest covers, breaking every ruling bound to round *x*
 * and flipping its surviving questions to `stale`.
 *
 * **Why the fields arrive as payload lines rather than `<key>: <value>` pairs.** This is the one
 * format of the three that is repeatable, and paired key lines cannot say which digest belongs to
 * which id without an index nobody would get right twice. So `emit` takes one entry per line in the
 * marker's own payload shape and `read` renders it back the same way — which also means this
 * format's read output pipes straight back into its emit.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import {
	FIELD_SEPARATOR,
	type MarkerTime,
	malformed,
	markerLines,
	markerTime,
	parseStampHead,
	payloadOf,
	type QuestionId,
	type RoundDigest,
	reachesFor,
} from "./grill-marker.ts";

/** The key that names these bytes. Never widened — a second meaning would need a second format. */
export const KEY = "grill-superseded";

export interface SupersedeEntry {
	readonly question: QuestionId;
	readonly digest: RoundDigest;
	/** The round that retired the question — the field the other two markers do not carry. */
	readonly round: number;
	readonly at: MarkerTime;
}

export type GrillSupersede = NonEmptyReadonlyArray<SupersedeEntry>;
export type GrillSupersedeRead = WireRead<GrillSupersede>;

const ROUND_FIELD = /^round[ \t]+([1-9][0-9]*)$/;

/** The payload of one line: `<id> @ <digest> · round <n> · <timestamp>`. */
export const parseEntry = (payload: string): SupersedeEntry | string => {
	const head = parseStampHead(payload);
	if (typeof head === "string") return head;
	const [roundPart, ...afterRound] = head.rest.split(FIELD_SEPARATOR);
	const round = ROUND_FIELD.exec((roundPart ?? "").trim())?.[1];
	if (round === undefined) {
		return `"${(roundPart ?? "").trim()}" is not a "round <n>" field — the retiring round is what this marker records`;
	}
	if (afterRound.length === 0) {
		return "the marker carries no timestamp after the round field";
	}
	const at = markerTime(afterRound.join(FIELD_SEPARATOR));
	if (at === null) {
		return `"${afterRound.join(FIELD_SEPARATOR).trim()}" is not an ISO-8601 UTC timestamp — expected a Z-suffixed instant`;
	}
	return {question: head.question, digest: head.digest, round: Number(round), at};
};

export const read = (artifact: string): GrillSupersedeRead => {
	if (!reachesFor(artifact, KEY)) {
		return {
			_tag: "Absent",
			reason: `the first line does not open with "${KEY}:" — no marker of this format`,
		};
	}
	const lines = markerLines(artifact, KEY);
	const entries: SupersedeEntry[] = [];
	for (const line of lines) {
		const parsed = parseEntry(payloadOf(line, KEY));
		if (typeof parsed === "string") return malformed(parsed, `line: "${line}"`);
		entries.push(parsed);
	}
	const [first, ...rest] = entries;
	if (first === undefined) {
		return malformed(
			`the artifact opens with "${KEY}:" but no line parsed as an entry`,
			artifact.slice(0, 120),
		);
	}
	return {_tag: "Found", value: [first, ...rest]};
};

export const emitEntry = (entry: SupersedeEntry): string =>
	`${KEY}: ${entry.question} @ ${entry.digest} ${FIELD_SEPARATOR} round ${entry.round} ${FIELD_SEPARATOR} ${entry.at}`;

export const emit = (entries: GrillSupersede): string => `${entries.map(emitEntry).join("\n")}\n`;

/** One payload line per entry — read output that pipes straight back into {@link emitFromFields}. */
export const renderEntries = (entries: GrillSupersede): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = entries.map(
		(entry) =>
			`${entry.question} @ ${entry.digest} ${FIELD_SEPARATOR} round ${entry.round} ${FIELD_SEPARATOR} ${entry.at}`,
	);
	if (first === undefined) throw new Error("a non-empty entry list rendered no lines");
	return [first, ...rest];
};

/** The registry row's byte-level `emit`: one payload line in, the marker comment's bytes out. */
export const emitFromFields = (fields: string): WireEmit => {
	const payloads = fields
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (payloads.length === 0) {
		return {
			_tag: "Unusable",
			reason: "no entry lines were given — a supersede marker retires at least one question",
		};
	}
	const entries: SupersedeEntry[] = [];
	for (const [index, payload] of payloads.entries()) {
		const parsed = parseEntry(payload.startsWith(`${KEY}:`) ? payloadOf(payload, KEY) : payload);
		if (typeof parsed === "string")
			return {_tag: "Unusable", reason: `line ${index + 1}: ${parsed}`};
		entries.push(parsed);
	}
	const [first, ...rest] = entries;
	if (first === undefined) {
		return {
			_tag: "Unusable",
			reason: "no entry lines were given — a supersede marker retires at least one question",
		};
	}
	return {_tag: "Composed", bytes: emit([first, ...rest])};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderEntries(result.value)} : result;
};
