/**
 * `handoff claim` — claim the latest sealed pack, keyed on the run nonce.
 *
 * A compare-and-set on a marker; *whether to take up the work* is the caller's. Re-running with the
 * nonce that already holds the pack is `resumed`, not an error, and posts no second comment: a
 * stateless re-dispatch of the same run must be able to prove it still owns the pack.
 *
 * **This verb does not re-derive the ground state and does not report drift.** That is `read`'s, and
 * duplicating it here would be a second answer to one question.
 *
 * `epic-lock`'s scars are designed out: it never reads back the presence stamp it writes, so an
 * abandoned lock wedges the issue forever, and it collapses several distinct refusals onto one exit
 * code. Here the write is read back (`9`), and `13`, `14`, `15` and `11` are four seats with four
 * remedies.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {packNonce} from "../wire/handoff-pack.ts";
import {
	NO_PACK,
	PACK_CLAIMED,
	PACK_MALFORMED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {requireIssue, targetRepo} from "./guards.ts";
import {composeClaimMarker, stampOf} from "./markers.ts";
import {resolvePack} from "./packs.ts";

export interface ClaimOptions {
	readonly issue: number;
	readonly nonce: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

const VERB = "handoff claim";

export const runClaim = (
	options: ClaimOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const nonce = packNonce(options.nonce);
		if (nonce === null) {
			return refuse(
				FAILED,
				`${VERB}: --nonce "${options.nonce}" is not eight lowercase hex characters — a human-readable label like run-1, which two runs would collide on, is not a claim key.`,
			);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const issue = yield* requireIssue(VERB, repo, options.issue);
		if (issue._tag === "Refused") return issue.outcome;

		const resolved = yield* resolvePack(repo, options.issue);
		if (resolved._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${resolved.reason} — whether a pack is claimed is UNKNOWN, never free.`,
			);
		}
		if (resolved._tag === "Malformed") {
			return refuse(
				PACK_MALFORMED,
				`${VERB}: #${options.issue}'s latest pack (comment #${resolved.comment}) does not parse (${resolved.reason}) — refusing to claim a pack whose contents are UNKNOWN.`,
			);
		}
		if (resolved._tag === "None") {
			return refuse(
				NO_PACK,
				`${VERB}: #${options.issue} carries no sealed pack — there is nothing to claim. Work the issue from its artifacts.`,
			);
		}

		const scope = `${VERB}: ${repo}, #${options.issue}, ${resolved.comments} comment(s) scanned, pack #${resolved.sealed.comment}.`;
		const held = resolved.heldBy;
		if (held !== null) {
			return held.claimNonce === nonce
				? answer(
						JSON.stringify({
							issue: options.issue,
							packComment: resolved.sealed.comment,
							claimNonce: nonce,
							claim: "resumed",
							claimedAt: held.claimedAt,
							claimComment: held.claimComment,
						}),
						[scope],
					)
				: refuse(
						PACK_CLAIMED,
						`${VERB}: pack #${resolved.sealed.comment} is held by ${held.claimNonce} since ${held.claimedAt} — refusing to open a second claim on one pack.`,
						[scope],
					);
		}

		const claimedAt = stampOf(options.now());
		const body = composeClaimMarker({
			nonce,
			packComment: resolved.sealed.comment,
			claimedAt,
		});
		const posted = yield* createComment(repo, options.issue, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the claim write to #${options.issue} failed: ${posted.reason} — whether the claim holds is UNKNOWN. Read #${options.issue} before working it.`,
				[scope],
			);
		}
		// The POST's own response is the server echoing the request; the claim is only held once the
		// marker reads back, which is the read-back `epic-lock` never performed on its own stamp.
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted the claim on #${options.issue} and the read-back differs — whether the claim holds is UNKNOWN. Read #${options.issue} before working it.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				issue: options.issue,
				packComment: resolved.sealed.comment,
				claimNonce: nonce,
				claim: "held",
				claimedAt,
				claimComment: posted.value.id,
			}),
			[scope],
		);
	});
