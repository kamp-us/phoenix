/**
 * `grill answer` — record an agent-established answer to a `fact` question.
 *
 * **The kind guard is the mechanical half of the division of labour.** Recording an agent answer
 * against a `decision` question is work proceeding past a decision nobody made, so it is refused
 * rather than warned about. The finding is recorded as the agent's, never as authority: the comment
 * carries a `grill-answered:` marker and never a `grill-ruled:` one, and `recordedAs` is on the
 * answer object so a reader never infers authorship from the absence of a ruling marker.
 *
 * **The marker's digest is informational.** It records which text was answered, so a reader can see
 * the question moved, and it never changes the state — a re-worded `fact` stays `answered`. `stale`
 * exists to protect a *ruling* from drifting out from under the founder, and a fact has no founder
 * to protect.
 *
 * **Under-determined clause, surfaced rather than invented (#5023).** The contract's shared matrix
 * marks `DIGEST_UNBINDABLE` unreachable for this verb, while the `grill-answer` marker requires a
 * 12-hex digest field — so a round whose questions parse but whose blocks are missing a field the
 * digest is taken over leaves this verb with a marker it cannot compose and no seat allocated. It is
 * seated on `DIGEST_UNBINDABLE` here, which is the same fact under the same name the sibling verbs
 * use; folding it into `QUESTION_UNKNOWN` would put two meanings on one code.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments, resolveRepo} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import * as grillAnswer from "../wire/grill-answer.ts";
import {questionId, stampOf} from "../wire/grill-marker.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	KIND_MISMATCH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	QUESTION_RETIRED,
	QUESTION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {digestRound} from "./round.ts";
import {questionIndex, resolveSession, retirements, scanMarkers, scanRounds} from "./session.ts";

/** A file the adapter read for the verb, so the verb itself touches no filesystem. */
export type DocumentRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface AnswerOptions<R = never> {
	readonly session: number;
	readonly question: string;
	/** The `--finding` path, carried for the refusal messages only. */
	readonly findingPath: string;
	readonly finding: Effect.Effect<DocumentRead, never, R>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runAnswer = <R = never>(
	options: AnswerOptions<R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {session, findingPath} = options;
		if (!Number.isInteger(session) || session <= 0) {
			return refuse(FAILED, `grill answer: ${session} is not a session issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"grill answer: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.finding;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`grill answer: could not read --finding ${findingPath}: ${read.reason} — the finding is UNKNOWN, never empty.`,
			);
		}
		const finding = read.text;
		if (finding.trim() === "") {
			return refuse(
				BAD_SECTIONS,
				`grill answer: --finding ${findingPath} is empty — refusing to record an answer with no content.`,
			);
		}
		if (isBareAtReference(finding)) {
			return refuse(
				BARE_AT_PATH,
				"grill answer: the finding is a bare @ path reference — not redactable, refusing to post it.",
			);
		}
		const leaks = scanBody(finding);
		const firstLeak = leaks.leaks[0];
		if (firstLeak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`grill answer: the finding carries a machine-local path: ${firstLeak.text} — refusing to post it.`,
				renderLeaks(leaks.leaks),
			);
		}

		const found = yield* resolveSession(repo, session);
		if (found._tag === "Absent") {
			return refuse(
				NO_TARGET,
				`grill answer: session #${session} does not exist, or is not a grilling session.`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill answer: cannot read the rounds on #${session}: ${found.reason} — whether ${options.question} exists is UNKNOWN. Nothing was posted.`,
			);
		}

		const comments = yield* listComments(repo, session);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill answer: cannot read the rounds on #${session}: ${comments.reason} — whether ${options.question} exists is UNKNOWN. Nothing was posted.`,
			);
		}
		const markers = yield* scanMarkers(repo, comments.value);
		if (markers._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill answer: cannot resolve ${markers.login}'s permission on ${repo}: ${markers.reason} — whether ${options.question} was retired is UNKNOWN. Nothing was posted.`,
			);
		}

		const rounds = scanRounds(comments.value);
		const index = questionIndex(rounds.rounds);
		const id = questionId(options.question);
		const held = id === null ? undefined : index.get(id);
		const scopeLine = `grill answer: ${repo}#${session}, ${comments.value.length} comment(s), ${rounds.rounds.length} round(s) read.`;
		if (id === null || held === undefined) {
			return refuse(
				QUESTION_UNKNOWN,
				`grill answer: ${options.question} names no question on #${session}.`,
				[scopeLine],
			);
		}

		const by = retirements(markers.scan).get(id);
		if (by !== undefined) {
			return refuse(
				QUESTION_RETIRED,
				`grill answer: ${id} was superseded by round ${by} — answer the question that replaced it.`,
				[scopeLine],
			);
		}
		if (held.question.kind !== "fact") {
			return refuse(
				KIND_MISMATCH,
				`grill answer: ${id} is a decision question — a decision is the founder's. Record his ruling with grill rule, or re-ask it as a fact.`,
				[scopeLine],
			);
		}

		const digested = digestRound(held.round.questions);
		if (digested._tag === "Unbindable") {
			return refuse(
				DIGEST_UNBINDABLE,
				`grill answer: the round holding ${id} could not be digested: ${digested.reason} — the marker's binding is UNKNOWN. Nothing was posted.`,
				[scopeLine],
			);
		}
		const at = stampOf(options.now());
		if (at === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				"grill answer: the clock did not render an ISO-8601 UTC instant — the marker cannot be stamped. Nothing was posted.",
				[scopeLine],
			);
		}

		const body = `${grillAnswer.emit({question: id, digest: digested.digest, at})}\n${finding.trim()}\n`;
		const posted = yield* createComment(repo, session, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill answer: the comment write failed, so whether the answer posted is UNKNOWN — read #${session} before re-running.`,
				[scopeLine],
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				"grill answer: the answer posted but the read-back does not match what was sent.",
				[scopeLine],
			);
		}

		return answer(
			JSON.stringify({
				session,
				question: id,
				kind: "fact",
				comment: posted.value.id,
				recordedAs: "agent",
			}),
			[scopeLine],
		);
	});
