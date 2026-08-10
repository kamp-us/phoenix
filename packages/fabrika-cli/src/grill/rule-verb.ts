/**
 * `grill rule` — record a founder ruling. The only sanctioned path by which an agent records one.
 *
 * The four clauses are conjunctive and any miss resolves to *not recorded*, never to a warning: the
 * invoking token resolves `write+` at the ACL, the question exists, its round digests, and the
 * quoted authorization is present and dated. A bare stamp is void (#4938), which is why
 * `--authorization` is required rather than inferred.
 *
 * **Write ordering is an invariant, not an implementation detail.** The authorization comment lands
 * first and the marker second: an interrupted run that wrote the marker first would leave a void
 * ruling a careless reader sees as present, while the reverse leaves an authorization quote with no
 * marker, which resolves to nothing and harms no one.
 *
 * <!-- anchor: AUTHORIZATION-BINDS-ONE-QUESTION --> **An authorization binds the question it was
 * given about, and no other — and this is CONVENTION, not enforcement.** Say so plainly, because
 * the temptation is to claim otherwise. This verb digests the round holding the id it is *given*,
 * so stamping a three-day-old quote onto a brand-new, narrower question a later round split out
 * **succeeds**, and nothing here knows which question the quote was originally about. That sits
 * beside "the quoted authorization is truthful" as the second thing no machine can check; the
 * agent's restraint is what holds it. A quote answering an older, broader question is evidence for
 * a recommendation, never a ruling on the new one.
 *
 * **What `ruled` proves, exactly.** That a `write+` account posted a marker binding this question's
 * current text, with a dated authorization comment beside it. It does not prove the quoted
 * authorization is a truthful record of what the founder said; nothing mechanical can, and #4441 is
 * open on it.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments, resolveRepo} from "../io/issues.ts";
import {permissionFor, viewerLogin} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {questionId, stampOf} from "../wire/grill-marker.ts";
import * as grillRuling from "../wire/grill-ruling.ts";
import type {DocumentRead} from "./answer-verb.ts";
import {
	AUTHORIZATION_ABSENT,
	BARE_AT_PATH,
	DIGEST_UNBINDABLE,
	KIND_MISMATCH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	QUESTION_RETIRED,
	QUESTION_UNKNOWN,
	READBACK_MISMATCH,
	TOKEN_UNAUTHORIZED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {digestRound} from "./round.ts";
import {
	AUTHORIZED,
	ISO_DATE,
	questionIndex,
	resolveSession,
	retirements,
	scanMarkers,
	scanRounds,
} from "./session.ts";

export interface RuleOptions<R = never> {
	readonly session: number;
	readonly question: string;
	/** The `--authorization` path, carried for the refusal messages only. */
	readonly authorizationPath: string;
	readonly authorization: Effect.Effect<DocumentRead, never, R>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runRule = <R = never>(
	options: RuleOptions<R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {session, authorizationPath} = options;
		if (!Number.isInteger(session) || session <= 0) {
			return refuse(FAILED, `grill rule: ${session} is not a session issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"grill rule: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const read = yield* options.authorization;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`grill rule: could not read --authorization ${authorizationPath}: ${read.reason} — the authorization is UNKNOWN, never empty.`,
			);
		}
		const quoted = read.text;
		if (quoted.trim() === "") {
			return refuse(
				AUTHORIZATION_ABSENT,
				`grill rule: --authorization ${authorizationPath} is empty — a ruling with no quoted authorization is void (#4938).`,
			);
		}
		if (!ISO_DATE.test(quoted)) {
			return refuse(
				AUTHORIZATION_ABSENT,
				`grill rule: --authorization ${authorizationPath} carries no ISO-8601 date — the authorization must be dated.`,
			);
		}
		if (isBareAtReference(quoted)) {
			return refuse(
				BARE_AT_PATH,
				"grill rule: the authorization is a bare @ path reference — not redactable, refusing to post it.",
			);
		}
		const leaks = scanBody(quoted);
		const firstLeak = leaks.leaks[0];
		if (firstLeak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`grill rule: the authorization carries a machine-local path: ${firstLeak.text} — refusing to post it.`,
				renderLeaks(leaks.leaks),
			);
		}

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill rule: cannot resolve the invoking token's permission on ${repo}: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
			);
		}
		const permission = yield* permissionFor(repo, viewer.value);
		if (permission._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill rule: cannot resolve the invoking token's permission on ${repo}: ${permission.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
			);
		}
		const level = permission._tag === "Present" ? permission.value : "no collaboration";
		if (permission._tag === "Absent" || !AUTHORIZED.has(level)) {
			return refuse(
				TOKEN_UNAUTHORIZED,
				`grill rule: the invoking token resolves to ${level} on ${repo}, below write — refusing to record a ruling.`,
			);
		}

		const found = yield* resolveSession(repo, session);
		if (found._tag === "Absent") {
			return refuse(
				NO_TARGET,
				`grill rule: session #${session} does not exist, or is not a grilling session.`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill rule: cannot read the rounds on #${session}: ${found.reason} — whether ${options.question} exists is UNKNOWN. Nothing was posted.`,
			);
		}

		const comments = yield* listComments(repo, session);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill rule: cannot read the rounds on #${session}: ${comments.reason} — whether ${options.question} exists is UNKNOWN. Nothing was posted.`,
			);
		}
		const markers = yield* scanMarkers(repo, comments.value);
		if (markers._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill rule: cannot resolve ${markers.login}'s permission on ${repo}: ${markers.reason} — whether ${options.question} was retired is UNKNOWN. Nothing was posted.`,
			);
		}

		const rounds = scanRounds(comments.value);
		const index = questionIndex(rounds.rounds);
		const id = questionId(options.question);
		const held = id === null ? undefined : index.get(id);
		const scopeLine = `grill rule: ${repo}#${session}, ${comments.value.length} comment(s), ${rounds.rounds.length} round(s) read; invoking token resolves ${level}.`;
		if (id === null || held === undefined) {
			return refuse(
				QUESTION_UNKNOWN,
				`grill rule: ${options.question} names no question on #${session}.`,
				[scopeLine],
			);
		}

		const by = retirements(markers.scan).get(id);
		if (by !== undefined) {
			return refuse(
				QUESTION_RETIRED,
				`grill rule: ${id} was superseded by round ${by} — a retired question cannot be ruled. Rule the question that replaced it.`,
				[scopeLine],
			);
		}
		if (held.question.kind !== "decision") {
			return refuse(
				KIND_MISMATCH,
				`grill rule: ${id} is a fact question — establish it with grill answer; a fact is not the founder's to rule.`,
				[scopeLine],
			);
		}

		const digested = digestRound(held.round.questions);
		if (digested._tag === "Unbindable") {
			return refuse(
				DIGEST_UNBINDABLE,
				`grill rule: the round holding ${id} could not be digested: ${digested.reason} — the binding is UNKNOWN. Nothing was posted.`,
				[scopeLine],
			);
		}
		const at = stampOf(options.now());
		if (at === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				"grill rule: the clock did not render an ISO-8601 UTC instant — the marker cannot be stamped. Nothing was posted.",
				[scopeLine],
			);
		}

		const authorizationBody = quoted.trim().endsWith("\n") ? quoted.trim() : `${quoted.trim()}\n`;
		const authorizationComment = yield* createComment(repo, session, authorizationBody);
		if (authorizationComment._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill rule: the authorization write failed, so whether it posted is UNKNOWN and no marker was written — read #${session} before re-running.`,
				[scopeLine],
			);
		}

		const markerBody = grillRuling.emit({question: id, digest: digested.digest, at});
		const marker = yield* createComment(repo, session, markerBody);
		if (marker._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill rule: the authorization comment landed as #${authorizationComment.value.id} and the marker write failed — the ruling is INCOMPLETE and does NOT count. Read #${session} before re-running.`,
				[scopeLine],
			);
		}
		const landed = yield* getComment(repo, marker.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(markerBody)
		) {
			return refuse(
				READBACK_MISMATCH,
				"grill rule: the marker posted but the read-back does not match what was sent.",
				[scopeLine],
			);
		}

		return answer(
			JSON.stringify({
				session,
				question: id,
				digest: digested.digest,
				authorization: authorizationComment.value.id,
				marker: marker.value.id,
				resolvesTo: "ruled",
			}),
			[scopeLine],
		);
	});
