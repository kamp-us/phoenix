/**
 * `grill round` — validate a round against the grammar, post it, and return its number, digest and
 * comment ids.
 *
 * The grammar is validated **before** the write, so a malformed round is a refusal with nothing
 * posted rather than a comment somebody has to delete. The round number is derived from the rounds
 * already on the session and never supplied by the caller, and the composed comment carries the
 * full `R<round>.<n>` ids so the caller learns its ids rather than guessing them.
 *
 * **Zero existing rounds is a fact — this is round 1.** A comment read that could not complete is
 * `PRECONDITION_UNKNOWN` and posts nothing: the next round number would be a guess, and a guessed
 * round number collides with the round already there (ADR 0092).
 *
 * **`--supersedes` is the retraction path, and it is what keeps a session finishable.** A question
 * whose text was re-worded goes `stale`, which is un-ruled, and holds the frontier open forever;
 * nothing else retires it. The retired question stays visibly on the record naming the round that
 * replaced it, which is retraction in the open rather than a wrong answer quietly overwritten.
 *
 * **The round is written first and the supersede marker second — the order is the conservative
 * half.** An interrupted run then leaves the replacement question posted and the old one still
 * holding the frontier: a question that should have been retired and was not is a nuisance, while a
 * question retired with no replacement posted is a silently dropped decision.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments, resolveRepo} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import type {QuestionId, RoundDigest} from "../wire/grill-marker.ts";
import {questionId, stampOf} from "../wire/grill-marker.ts";
import * as grillSupersede from "../wire/grill-supersede.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	QUESTION_RETIRED,
	QUESTION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	addressBlocks,
	checkRequiredFields,
	composeRoundComment,
	digestRound,
	parseQuestionBlocks,
} from "./round.ts";
import {
	nextRoundNumber,
	questionIndex,
	resolveSession,
	retirements,
	scanMarkers,
	scanRounds,
} from "./session.ts";

export interface RoundOptions {
	readonly session: number;
	readonly supersedes: ReadonlyArray<string>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
	readonly now: () => Date;
}

const leakRefusal = (body: string): VerbOutcome | null => {
	if (isBareAtReference(body)) {
		return refuse(
			BARE_AT_PATH,
			"grill round: the body is a bare @ path reference — not redactable, refusing to post it.",
		);
	}
	const scan = scanBody(body);
	const first = scan.leaks[0];
	return first === undefined
		? null
		: refuse(
				LEAKED_PATH,
				`grill round: the body carries a machine-local path: ${first.text} — refusing to post it.`,
				renderLeaks(scan.leaks),
			);
};

export const runRound = (
	options: RoundOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {session} = options;
		if (!Number.isInteger(session) || session <= 0) {
			return refuse(FAILED, `grill round: ${session} is not a session issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"grill round: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`grill round: could not read stdin: ${read.reason} — the round is UNKNOWN, never empty.`,
			);
		}
		const body = read._tag === "NoStdin" ? "" : read.text;
		if (body.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				"grill round: stdin was read and held nothing — refusing to post an empty round.",
			);
		}

		// The leak guard runs BEFORE the grammar, not after. A body that is a bare `@` path is also
		// not a round, so grammar-first would make `BARE_AT_PATH` unreachable for this verb — the
		// caller would be told its round is malformed and re-send the same path.
		const leaked = leakRefusal(body);
		if (leaked !== null) return leaked;

		const parsed = parseQuestionBlocks(body);
		if (parsed._tag === "Invalid") {
			return refuse(BAD_SECTIONS, `grill round: ${parsed.reason}`);
		}
		const missing = checkRequiredFields(parsed.blocks);
		if (missing !== null) return refuse(BAD_SECTIONS, `grill round: ${missing}`);

		const found = yield* resolveSession(repo, session);
		if (found._tag === "Absent") {
			return refuse(
				NO_TARGET,
				`grill round: session #${session} does not exist, or is not a grilling session.`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill round: cannot read the existing rounds on #${session}: ${found.reason} — the next round number is UNKNOWN. Nothing was posted.`,
			);
		}

		const comments = yield* listComments(repo, session);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill round: cannot read the existing rounds on #${session}: ${comments.reason} — the next round number is UNKNOWN. Nothing was posted.`,
			);
		}

		const rounds = scanRounds(comments.value);
		const round = nextRoundNumber(rounds);
		const index = questionIndex(rounds.rounds);
		const scopeLine = `grill round: ${repo}#${session}, ${comments.value.length} comment(s), ${rounds.rounds.length} round(s) read; this is round ${round}.`;
		const brokenLines = rounds.broken.map(
			(broken) =>
				`grill round: comment ${broken.comment} opens as round ${broken.round} and does not parse: ${broken.reason}`,
		);
		const diagnostics = [scopeLine, ...brokenLines];

		const questions = addressBlocks(round, parsed.blocks);
		if (questions === null) {
			return refuse(
				DIGEST_UNBINDABLE,
				`grill round: the round holding this question could not be digested: a position does not form an R${round}.<n> id — the binding is UNKNOWN. Nothing was posted.`,
				diagnostics,
			);
		}
		const digested = digestRound(questions);
		if (digested._tag === "Unbindable") {
			return refuse(
				DIGEST_UNBINDABLE,
				`grill round: the round holding R${round}.1 could not be digested: ${digested.reason} — the binding is UNKNOWN. Nothing was posted.`,
				diagnostics,
			);
		}

		// The retirement scan runs only when there is something to retire: it costs one ACL read per
		// distinct marker author, and the common path retires nothing.
		const retired: {id: QuestionId; digest: RoundDigest}[] = [];
		if (options.supersedes.length > 0) {
			const markers = yield* scanMarkers(repo, comments.value);
			if (markers._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`grill round: cannot resolve ${markers.login}'s permission on ${repo}: ${markers.reason} — whether the target is already retired is UNKNOWN. Nothing was posted.`,
					diagnostics,
				);
			}
			const alreadyRetired = retirements(markers.scan);
			for (const raw of options.supersedes) {
				const id = questionId(raw);
				const held = id === null ? undefined : index.get(id);
				if (id === null || held === undefined) {
					return refuse(
						QUESTION_UNKNOWN,
						`grill round: --supersedes ${raw} names no question on #${session}.`,
						diagnostics,
					);
				}
				const by = alreadyRetired.get(id);
				if (by !== undefined) {
					return refuse(
						QUESTION_RETIRED,
						`grill round: --supersedes ${id} was already superseded by round ${by}.`,
						diagnostics,
					);
				}
				const bound = digestRound(held.round.questions);
				if (bound._tag === "Unbindable") {
					return refuse(
						DIGEST_UNBINDABLE,
						`grill round: the round holding ${id} could not be digested: ${bound.reason} — the supersede binding is UNKNOWN. Nothing was posted.`,
						diagnostics,
					);
				}
				retired.push({id, digest: bound.digest});
			}
		}

		const comment = composeRoundComment(round, questions);
		const posted = yield* createComment(repo, session, comment);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill round: the comment write failed, so whether the round posted is UNKNOWN — read #${session} before re-running.`,
				diagnostics,
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(comment)
		) {
			return refuse(
				READBACK_MISMATCH,
				`grill round: the round posted but the read-back does not match what was sent.`,
				diagnostics,
			);
		}

		let supersedeComment: number | null = null;
		const at = stampOf(options.now());
		const entries: grillSupersede.SupersedeEntry[] =
			at === null
				? []
				: retired.map((entry) => ({question: entry.id, digest: entry.digest, round, at}));
		const [head, ...tail] = entries;
		if (retired.length > 0) {
			const orphaned = `${retired.map((entry) => entry.id).join(", ")} are NOT retired and still hold the frontier. Re-run grill round --supersedes on the new round, do not re-post the round.`;
			if (head === undefined) {
				return refuse(
					WRITE_UNKNOWN,
					`grill round: the round posted as #${posted.value.id} and the supersede marker could not be stamped — ${orphaned}`,
					diagnostics,
				);
			}
			const markerBody = grillSupersede.emit([head, ...tail]);
			const marker = yield* createComment(repo, session, markerBody);
			if (marker._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`grill round: the round posted as #${posted.value.id} and the supersede marker failed — ${orphaned}`,
					diagnostics,
				);
			}
			const markerLanded = yield* getComment(repo, marker.value.id);
			if (
				markerLanded._tag === "Failure" ||
				normalizeForReadback(markerLanded.value) !== normalizeForReadback(markerBody)
			) {
				return refuse(
					READBACK_MISMATCH,
					"grill round: the supersede marker posted but the read-back does not match what was sent.",
					diagnostics,
				);
			}
			supersedeComment = marker.value.id;
		}

		return answer(
			JSON.stringify({
				session,
				round,
				digest: digested.digest,
				questions: questions.map((question) => ({id: question.id, kind: question.kind})),
				supersedes: retired.map((entry) => entry.id),
				comment: posted.value.id,
				supersedeComment,
			}),
			diagnostics,
		);
	});
