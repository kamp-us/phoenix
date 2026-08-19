/**
 * `guard unresolved-threads check` — the ADR 0158 merge gate, ported off
 * `pipeline-cli unresolved-threads-guard` (epic #5720).
 *
 * The whole decision is in `./unresolved-threads.ts`; this file is the two reads it rests on and the
 * fail-closed posture around them.
 *
 * - The threads come from `ship`'s `listReviewThreads` — the one sanctioned GraphQL path (REST has
 *   no `isResolved`), already paged and count-proved. A short read is UNKNOWN here, never a shorter
 *   thread list, because a verdict over a truncated set is a verdict over unknown scope.
 * - The verdict body is the newest `review-code:` marker whose author holds write+ on the repo
 *   (ADR 0055). Without that gate a forged `review-code: PASS … path:line` from anyone with a
 *   keyboard would account for the very thread it is hiding.
 *
 * **An unreadable ACL drops the marker rather than refusing the run.** That is the opposite of
 * `ship gate`, and deliberately: there, a dropped verdict reads as `absent` and the gate must not
 * decide, while here dropping one can only *add* unaccounted threads — the guard gets stricter, never
 * more permissive. What must never be dropped is a thread or a comment page, so both of those reads
 * fail to `11`.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments, resolveRepo} from "../io/issues.ts";
import {getPullRequest, permissionFor} from "../io/pulls.ts";
import {listReviewThreads} from "../ship/github.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {readNamespaced} from "../wire/verdict-marker.ts";
import {judge} from "./unresolved-threads.ts";
import {emitVerdict, type GuardVerdict, unknown, zeroScope} from "./verdict.ts";

const VERB = "guard unresolved-threads check";

/** The gate whose verdict is the accounting surface. A `review-doc` PASS accounts for nothing. */
const NAMESPACE = "review-code";

/** The permission levels ADR 0055 counts as an authorized verdict author. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

export interface UnresolvedThreadsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const unreadable = (what: string, reason: string): GuardVerdict =>
	unknown(`${VERB}: cannot read ${what}: ${reason} — the verdict is UNKNOWN, never clean.`);

/** The write stamp a verdict is ordered by; the create stamp only when the platform sent none. */
const stampOf = (comment: CommentRecord): string =>
	comment.updatedAt === "" ? comment.createdAt : comment.updatedAt;

const outranks = (candidate: CommentRecord, best: CommentRecord): boolean => {
	const a = stampOf(candidate);
	const b = stampOf(best);
	return a === b ? candidate.id > best.id : a > b;
};

/**
 * The newest authorized `review-code` verdict body on the PR, or `null`.
 *
 * Ordered by the **write** stamp, not the create stamp: a verdict comment is upserted in place, so a
 * FAIL rewritten into an older comment after a PASS is the one in force (#4200). The comment id
 * breaks a tie between two writes sharing a second.
 */
const latestVerdictBody = (
	repo: string,
	comments: ReadonlyArray<CommentRecord>,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const markers = comments.filter(
			(comment) => comment.author !== "" && readNamespaced(comment.body, NAMESPACE) !== null,
		);
		const authorized = new Map<string, boolean>();
		const trusted: CommentRecord[] = [];
		for (const comment of markers) {
			if (!authorized.has(comment.author)) {
				const permission = yield* permissionFor(repo, comment.author);
				authorized.set(
					comment.author,
					permission._tag === "Present" && AUTHORIZED.has(permission.value),
				);
			}
			if (authorized.get(comment.author) === true) trusted.push(comment);
		}
		const newest = trusted.reduce<CommentRecord | null>(
			(best, comment) => (best === null || outranks(comment, best) ? comment : best),
			null,
		);
		return newest?.body ?? null;
	});

const gather = (
	repo: string,
	pr: number,
): Effect.Effect<GuardVerdict, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") {
			return zeroScope(
				`${VERB}: PR #${pr} not found in ${repo} — there is nothing to gate, fail-closed (ADR 0092).`,
			);
		}
		if (found._tag === "Unknown") return unreadable(`PR #${pr} in ${repo}`, found.reason);

		const listed = yield* listReviewThreads(repo, pr);
		if (listed._tag === "Failure") {
			return unreadable(`#${pr}'s review threads`, listed.reason);
		}
		const {declared, threads} = listed.value;
		if (threads.length < declared) {
			return unknown(
				`${VERB}: received ${threads.length} of ${declared} review threads on #${pr} — a partial sweep proves nothing, so the verdict is UNKNOWN.`,
			);
		}

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return unreadable(`#${pr}'s comments`, commented.reason);
		}
		if (commented.value.length < found.value.comments) {
			return unknown(
				`${VERB}: received ${commented.value.length} of ${found.value.comments} comments on #${pr} — the review-code verdict may be in the part that never arrived, so the verdict is UNKNOWN.`,
			);
		}

		// Zero live threads is answered before the ACL sweep: with nothing to account for, no verdict
		// body can change the outcome, and probing collaborator permissions would be pure cost.
		if (threads.every((thread) => thread.isResolved)) return judge({threads, verdictBody: null});
		return judge({threads, verdictBody: yield* latestVerdictBody(repo, commented.value)});
	});

export const runUnresolvedThreadsGuard = (
	options: UnresolvedThreadsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, env} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}
		const repo = yield* resolveRepo(options.repo, env);
		if (repo._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		return emitVerdict(yield* gather(repo.value, pr), env);
	});
