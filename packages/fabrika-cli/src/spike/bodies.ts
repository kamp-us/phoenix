/**
 * The three composed bodies and the marker grammar three behaviours turn on — pure, so recognising a
 * capture is mechanical rather than a prose instruction.
 *
 * **The issue body carries no marker.** A spike is found by its `prototyping:spike` label and its own
 * number, so a marker there would be a second identity to keep in step with them. Only the two
 * comments carry one, on their first line and nothing else.
 *
 * **The run table is transcribed, not summarised.** A reader sees each recorded run's command and
 * status beside the claim rather than a hash standing in for them; the `evidenceDigest` is what
 * proves the table matches the log.
 *
 * The body never carries the workspace path — that is the answer to #3086: the path is not scanned
 * out of the body, it is never placed in it.
 */

import type {CommentRecord} from "../io/issues.ts";
import type {EvidenceRecord, Kind} from "./workspace.ts";

/** The label that makes a spike findable, countable and disposable as a class. */
export const SPIKE_LABEL = "prototyping:spike";

/** The longest a composed title may be, truncation mark included. */
export const TITLE_LIMIT = 200;

/** `spike: <question>`, truncated on a character boundary with a trailing `…` when longer. */
export const spikeTitle = (question: string): string => {
	const full = `spike: ${question.trim()}`;
	const characters = [...full];
	return characters.length <= TITLE_LIMIT
		? full
		: `${characters.slice(0, TITLE_LIMIT - 1).join("")}…`;
};

export interface IssueBodyFields {
	readonly question: string;
	readonly kind: Kind;
	readonly nonce: string;
	readonly ticket: number | null;
}

export const issueBody = (fields: IssueBodyFields): string =>
	[
		"## Question",
		"",
		fields.question.trim(),
		"",
		"## Shape",
		"",
		fields.kind,
		"",
		"## Run",
		"",
		fields.nonce,
		"",
		"## Came from",
		"",
		fields.ticket === null ? "standalone" : `#${fields.ticket}`,
		"",
	].join("\n");

/** The capture marker's first line — the one string `spike dispose` and `spike capture` recognise. */
export const captureMarker = (nonce: string, evidenceDigest: string): string =>
	`<!-- fabrika:spike capture nonce=${nonce} evidenceDigest=${evidenceDigest} -->`;

/** The forfeit marker's first line. It never satisfies the captured predicate — that is the point. */
export const forfeitMarker = (nonce: string, runs: number): string =>
	`<!-- fabrika:spike forfeit nonce=${nonce} runs=${runs} -->`;

const CAPTURE_RE =
	/^<!-- fabrika:spike capture nonce=([0-9a-f]{8}) evidenceDigest=([0-9a-f]{64}) -->$/;

/** A recognised capture marker: which run it belongs to, and the log it was written over. */
export interface CaptureMark {
	readonly commentId: number;
	readonly nonce: string;
	readonly evidenceDigest: string;
	readonly createdAt: string;
}

const markOf = (comment: CommentRecord): CaptureMark | null => {
	const first = comment.body.split("\n")[0] ?? "";
	const match = CAPTURE_RE.exec(first.trim());
	return match?.[1] === undefined || match[2] === undefined
		? null
		: {
				commentId: comment.id,
				nonce: match[1],
				evidenceDigest: match[2],
				createdAt: comment.createdAt,
			};
};

/**
 * The **newest** capture marker carrying this run's nonce, or `null`.
 *
 * Matching on the nonce is what stops another run's marker answering for this one; taking the newest
 * is what makes a staleness comparison single-valued once a supersede has happened. Ties on the
 * creation stamp fall to the higher comment id, which is monotonic where a second-resolution
 * timestamp is not.
 */
export const newestCapture = (
	comments: ReadonlyArray<CommentRecord>,
	nonce: string,
): CaptureMark | null => {
	let newest: CaptureMark | null = null;
	for (const comment of comments) {
		const mark = markOf(comment);
		if (mark === null || mark.nonce !== nonce) continue;
		if (
			newest === null ||
			mark.createdAt > newest.createdAt ||
			(mark.createdAt === newest.createdAt && mark.commentId > newest.commentId)
		) {
			newest = mark;
		}
	}
	return newest;
};

/** The run table, one row per evidence line, transcribed from the log rather than re-derived. */
export const runTable = (records: ReadonlyArray<EvidenceRecord>): string =>
	[
		"| seq | command | exit | truncated |",
		"| --- | --- | --- | --- |",
		...records.map(
			(record) =>
				`| ${record.seq} | ${record.command.join(" ")} | ${
					record.timedOut ? "timed out" : String(record.commandExit)
				} | ${record.truncated} |`,
		),
	].join("\n");

/** The capture comment: the marker line, a blank line, the decision verbatim, then the run table. */
export const captureComment = (fields: {
	readonly nonce: string;
	readonly evidenceDigest: string;
	readonly decision: string;
	readonly records: ReadonlyArray<EvidenceRecord>;
}): string =>
	[
		captureMarker(fields.nonce, fields.evidenceDigest),
		"",
		"## Decision",
		"",
		fields.decision.trim(),
		"",
		"## Runs",
		"",
		runTable(fields.records),
		"",
	].join("\n");

/**
 * The forfeit note: the question **read from the manifest** (`dispose` takes no `--question`), the
 * same run table, and a closing line stating no decision was reached.
 */
export const forfeitNote = (fields: {
	readonly nonce: string;
	readonly question: string;
	readonly records: ReadonlyArray<EvidenceRecord>;
}): string =>
	[
		forfeitMarker(fields.nonce, fields.records.length),
		"",
		"## Abandoned",
		"",
		fields.question.trim(),
		"",
		"## Runs",
		"",
		runTable(fields.records),
		"",
		"No decision was reached; this spike was abandoned and its workspace disposed.",
		"",
	].join("\n");
