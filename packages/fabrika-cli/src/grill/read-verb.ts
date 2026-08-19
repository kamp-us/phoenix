/**
 * `grill read` — the parser: per-question state, ACL-resolved, digest-checked, plus the frontier
 * token and every disregarded marker.
 *
 * <!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on marker content.** A
 * malformed marker, an unauthorized author, or a digest binding no round are all **data** —
 * reported in `disregarded` at exit `0`, with the affected question left `open`. Refusing would
 * suppress the entire frontier answer over one bad comment, and would let any account with write
 * access disable the verb by posting one malformed marker. Its only refusals are a session that
 * does not exist and a read that could not complete.
 *
 * **All four frontier tokens exit `0`.** A frontier holding open questions is this skill working,
 * not a failure; seating it on a non-zero code would make a caller's `[ $? -ne 0 ]` read "the
 * founder has not answered yet" as "the verb never ran".
 *
 * **Zero comments is a fact** — `empty`, the ordinary state of a session opened and not yet
 * grilled. A comment read that could not complete leaves every question's state UNKNOWN, never
 * `open`: an unpaginated read would silently drop the newest rounds and report a ruled question as
 * open, which is the fail-open direction (ADR 0092).
 *
 * **Where a later marker meets an earlier one on the same question, the later comment wins.** The
 * markers are a log, and the newest record of a question is what the session currently says about
 * it; nothing edits or deletes an old one, so the log is also the audit trail.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCameFrom, ticketOf} from "../wire/came-from.ts";
import type {MarkerTime, QuestionId, RoundDigest} from "../wire/grill-marker.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";
import {digestRound, type Kind} from "./round.ts";
import {
	type Disregarded,
	ISO_DATE,
	type PostedRound,
	resolveSession,
	retirements,
	scanMarkers,
	scanRounds,
} from "./session.ts";

/** The closed set of question states. `superseded` occurs on either kind and always wins. */
export type QuestionState = "open" | "answered" | "ruled" | "unattested" | "stale" | "superseded";

/** The closed set of frontier tokens. All four are answers at exit `0`. */
export type Frontier = "awaiting-founder" | "facts-pending" | "clear" | "empty";

/** One question row. The five always-present keys, then the conditional ones per state. */
export interface QuestionRow {
	readonly id: QuestionId;
	readonly kind: Kind;
	readonly round: number;
	readonly text: string;
	readonly state: QuestionState;
	readonly proof?: "acl+authorization";
	readonly author?: string;
	readonly ruledAt?: MarkerTime;
	readonly boundDigest?: RoundDigest;
	readonly currentDigest?: RoundDigest;
	readonly supersededBy?: number;
}

export interface ReadOptions {
	readonly session: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Clause 4: a comment immediately before the marker carrying an ISO-8601 date.
 *
 * It admits no exception, and that is deliberate. An earlier design treated a bare marker as
 * "authored directly" and therefore stronger, but *authored directly* is not a checkable property —
 * every agent writes to GitHub as the founder's account — and a bare stamp is void. So a bare
 * marker resolves to `unattested`, surfaced and never counted, whoever appears to have posted it.
 */
const adjacentAuthorization = (
	comments: ReadonlyArray<CommentRecord>,
	index: number,
): CommentRecord | null => {
	const previous = comments[index - 1];
	if (previous === undefined) return null;
	const first =
		previous.body
			.split("\n")
			.find((line) => line.trim() !== "")
			?.trim() ?? "";
	if (first.replace(/^\*{0,2}\s*/, "").startsWith("grill-")) return null;
	return ISO_DATE.test(previous.body) ? previous : null;
};

const orderedQuestions = (rounds: ReadonlyArray<PostedRound>): ReadonlyArray<QuestionRow> =>
	[...rounds]
		.sort((left, right) => left.round - right.round)
		.flatMap((round) =>
			[...round.questions]
				.sort((left, right) => left.position - right.position)
				.map(
					(question): QuestionRow => ({
						id: question.id,
						kind: question.kind,
						round: question.round,
						text: question.text,
						state: "open",
					}),
				),
		);

const frontierOf = (rows: ReadonlyArray<QuestionRow>): Frontier => {
	if (rows.length === 0) return "empty";
	const awaiting = rows.some(
		(row) =>
			row.kind === "decision" &&
			(row.state === "open" || row.state === "unattested" || row.state === "stale"),
	);
	if (awaiting) return "awaiting-founder";
	return rows.some((row) => row.kind === "fact" && row.state === "open")
		? "facts-pending"
		: "clear";
};

export const runRead = (
	options: ReadOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {session} = options;
		if (!Number.isInteger(session) || session <= 0) {
			return refuse(FAILED, `grill read: ${session} is not a session issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"grill read: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const found = yield* resolveSession(repo, session);
		if (found._tag === "Absent") {
			return refuse(
				NO_TARGET,
				`grill read: session #${session} does not exist, or is not a grilling session.`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill read: cannot read the comments on #${session}: ${found.reason} — every question's state is UNKNOWN, never "open".`,
			);
		}

		// A drifted section is reported, not refused: the READ-NEVER-REFUSES-ON-CONTENT invariant above
		// holds, and refusing here would let anyone with write access disable the verb by editing one
		// heading. So the drift lands on stderr beside the unparsable rounds, and `ticket` is null with
		// the reason visible — never null in silence, which is what `grill open` cannot afford (#5661).
		const binding = readCameFrom(found.body);
		const ticket = binding._tag === "Found" ? ticketOf(binding.value.binding) : null;
		const bindingLine =
			binding._tag === "Malformed"
				? `grill read: #${session}'s "## Came from" section does not parse: ${binding.reason} (${binding.evidence}) — reporting ticket null; which ticket this session came from is unread until the section is fixed.`
				: null;

		const comments = yield* listComments(repo, session);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill read: cannot read the comments on #${session}: ${comments.reason} — every question's state is UNKNOWN, never "open".`,
			);
		}

		const markers = yield* scanMarkers(repo, comments.value);
		if (markers._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill read: cannot resolve ${markers.login}'s permission on ${repo}: ${markers.reason} — the marker on ${markers.subject} is UNKNOWN, never disregarded and never counted. Re-run.`,
			);
		}

		const rounds = scanRounds(comments.value);
		const rows = new Map<string, QuestionRow>(
			orderedQuestions(rounds.rounds).map((row) => [row.id, row]),
		);
		const disregarded: Disregarded[] = [...markers.scan.disregarded];

		const digests = new Map<number, RoundDigest | null>();
		for (const round of rounds.rounds) {
			const digested = digestRound(round.questions);
			digests.set(round.round, digested._tag === "Digest" ? digested.digest : null);
		}

		for (const marker of markers.scan.answers) {
			const row = rows.get(marker.stamp.question);
			if (row === undefined || row.kind !== "fact") {
				disregarded.push({
					comment: marker.comment,
					reason: "unbindable",
					detail:
						row === undefined
							? `${marker.stamp.question} names no question in this session`
							: `${marker.stamp.question} is a decision question — an answer marker never resolves one`,
				});
				continue;
			}
			rows.set(row.id, {...row, state: "answered"});
		}

		for (const marker of markers.scan.rulings) {
			const row = rows.get(marker.stamp.question);
			if (row === undefined || row.kind !== "decision") {
				disregarded.push({
					comment: marker.comment,
					reason: "unbindable",
					detail:
						row === undefined
							? `${marker.stamp.question} names no question in this session`
							: `${marker.stamp.question} is a fact question — a ruling marker never resolves one`,
				});
				continue;
			}
			const current = digests.get(row.round);
			if (current === undefined || current === null) {
				disregarded.push({
					comment: marker.comment,
					reason: "unbindable",
					detail: `round ${row.round} could not be digested, so the marker on ${row.id} binds nothing checkable`,
				});
				continue;
			}
			if (current !== marker.stamp.digest) {
				rows.set(row.id, {
					...row,
					state: "stale",
					boundDigest: marker.stamp.digest,
					currentDigest: current,
				});
				continue;
			}
			if (adjacentAuthorization(comments.value, marker.index) === null) {
				disregarded.push({
					comment: marker.comment,
					reason: "unattested",
					detail: `the marker on ${row.id} carries no adjacent dated authorization — a bare stamp is void (#4938)`,
				});
				rows.set(row.id, {...row, state: "unattested"});
				continue;
			}
			rows.set(row.id, {
				...row,
				state: "ruled",
				proof: "acl+authorization",
				author: marker.author,
				ruledAt: marker.stamp.at,
			});
		}

		for (const [id, round] of retirements(markers.scan)) {
			const row = rows.get(id);
			if (row === undefined) continue;
			rows.set(id, {...row, state: "superseded", supersededBy: round});
		}

		const questions = [...rows.values()];
		const counts = {
			open: questions.filter((row) => row.state === "open").length,
			stale: questions.filter((row) => row.state === "stale").length,
			answered: questions.filter((row) => row.state === "answered").length,
			ruled: questions.filter((row) => row.state === "ruled").length,
			unattested: questions.filter((row) => row.state === "unattested").length,
			superseded: questions.filter((row) => row.state === "superseded").length,
		};

		const scanned = {
			comments: comments.value.length,
			rounds: rounds.rounds.length,
			authorsResolved: markers.scan.authorsResolved,
		};
		const scopeLine = `grill read: ${repo}#${session}, ${scanned.comments} comment(s), ${scanned.rounds} round(s), ${scanned.authorsResolved} author(s) resolved at the ACL.`;
		const brokenLines = rounds.broken.map(
			(broken) =>
				`grill read: comment ${broken.comment} opens as round ${broken.round} and does not parse: ${broken.reason}`,
		);

		return answer(
			JSON.stringify({
				session,
				ticket,
				frontier: frontierOf(questions),
				questions,
				disregarded,
				counts,
				scanned,
			}),
			[scopeLine, ...(bindingLine === null ? [] : [bindingLine]), ...brokenLines],
		);
	});
