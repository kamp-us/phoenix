/**
 * `ship resolve` — the sanctioned thread-resolution write.
 *
 * Five steps, each gating the next: re-derive the thread's live state and class, leak-scan the
 * rationale, post the reply, fire the resolve, read back. Steps 3–4 are one logical write and the
 * ordering is deliberate — rationale first, so an interrupted run never leaves a silent resolve.
 *
 * **The `16` refusal is the founder ruling's structural anchor.** The nit-vs-substantive call stays
 * in the skill; this verb is the mechanics under it, scoped to positively bot-classed threads, and
 * that scope is enforced by re-deriving the class here rather than trusting the caller's dispatch. A
 * confused caller cannot resolve a human's objection.
 *
 * There is deliberately **no `--sha` and no `12` seat**: a thread is not head-bound, and step 1
 * re-reads its live state at write time, so there is no stale carried observation for `12` to guard.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readAuthored, type StdinSource} from "./authored.ts";
import {
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {listReviewThreads, replyToThread, resolveThread} from "./github.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "./target.ts";
import {classOfThread, firstHumanOf} from "./threads.ts";

const VERB = "ship resolve";

export interface ResolveOptions {
	readonly pr: number;
	readonly thread: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: StdinSource;
}

export const runResolve = (
	options: ResolveOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json, thread: threadId} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(VERB, yield* options.stdin, {
			empty: `${VERB}: no rationale on stdin — a silent resolve discards an objection unauditably; write why.`,
			bareAt: `${VERB}: the rationale is a bare "@" path reference — the text never arrived. Send its bytes on stdin.`,
			leaked: (_count, first) =>
				`${VERB}: the rationale carries a machine-local path at line ${first.line} (${first.class}) — cite it repo-relative (#4994's class routes to a human, see the shared section).`,
		});
		if (authored._tag === "Refused") return authored.outcome;
		const rationale = authored.text;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) =>
				`${VERB}: cannot re-derive thread ${threadId}'s state: ${reason} — nothing was written.`,
		});
		if (target._tag === "Refused") return target.outcome;

		const listed = yield* listReviewThreads(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot re-derive thread ${threadId}'s state: ${listed.reason} — nothing was written.`,
			);
		}
		const thread = listed.value.threads.find((candidate) => candidate.id === threadId);
		if (thread === undefined) {
			return refuse(ZERO_SCOPE, `${VERB}: thread ${threadId} not found on PR #${pr}.`);
		}
		if (thread.isResolved) {
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: thread ${threadId} is already resolved — nothing to do.`,
			);
		}
		if (classOfThread(thread) !== "bot") {
			const human = firstHumanOf(thread);
			return refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: thread ${threadId} is not positively bot-classed (author ${human?.login ?? "unknown"} is ${human?.typename ?? "unknown"}) — only a bot thread is resolvable here; a human objection is theirs to resolve.`,
			);
		}

		const replied = yield* replyToThread(threadId, rationale);
		if (replied._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: reply failed: ${replied.reason} — UNKNOWN what landed; run \`fabrika ship threads ${pr}\` before retrying.`,
			);
		}
		const mutated = yield* resolveThread(threadId);
		if (mutated._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: resolve failed: ${mutated.reason} — UNKNOWN what landed; run \`fabrika ship threads ${pr}\` before retrying.`,
			);
		}

		// The mutation's own response is never the proof — the thread is re-read, and both halves of
		// the write must show in it.
		const after = yield* listReviewThreads(repo, pr);
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: resolve failed: ${after.reason} — UNKNOWN what landed; run \`fabrika ship threads ${pr}\` before retrying.`,
			);
		}
		const landed = after.value.threads.find((candidate) => candidate.id === threadId);
		const carriesRationale =
			landed?.comments.some(
				(comment) => normalizeForReadback(comment.body) === normalizeForReadback(rationale),
			) === true;
		if (landed === undefined || !landed.isResolved || !carriesRationale) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the read-back does not show ${threadId} resolved with the rationale — inspect the thread.`,
			);
		}

		return json
			? answer(JSON.stringify({outcome: "resolved", thread: threadId, commentUrl: replied.value}))
			: answer(`resolved\t${threadId}\t${replied.value}`);
	});
