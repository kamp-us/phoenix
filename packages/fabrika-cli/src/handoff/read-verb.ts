/**
 * `handoff read` — resolve the latest sealed pack, parse it into its two halves, re-derive the
 * ground now, and report the drift field by field.
 *
 * <!-- anchor: DRIFT-IS-NEVER-OPTIONAL --> **There is no way to read a pack without its drift.** The
 * two were one verb from the start, because a caller who could skip the second call would sometimes
 * skip it, and a pack read as current while stale is the failure this whole group is built against
 * (#3330).
 *
 * <!-- anchor: WHY-NO-PACK-IS-0-ON-READ-AND-13-ON-CLAIM --> Zero packs on an issue is a **fact** —
 * most issues have none — so it is the `none` token at exit `0`, and a successor branches on the
 * token. `claim` refuses `13` on the same fact because it *acts*: asking to claim a pack that does
 * not exist is a request that cannot be honoured. Seating this answer on `13` would hand a booting
 * successor empty stdout on the ordinary case.
 *
 * <!-- anchor: ONE-SUMMARY-NOT-TWO --> `ground` carries only `packed`, the digest the pack attested
 * at seal time, and there is deliberately no `live` counterpart: a live digest over the nineteen
 * would fold in the successor's own working copy, and over the sixteen it is not comparable to
 * `packed` at all. Two top-level summaries that can disagree, with nothing saying which wins, is
 * worse than one.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {repoDefaultBranch} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PACK_MALFORMED, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	comparableOf,
	compareGround,
	deriveComparable,
	deriveLiveBoard,
	driftState,
	type LiveGround,
	resolveBranch,
} from "./ground.ts";
import {requireIssue, targetRepo} from "./guards.ts";
import {resolvePack} from "./packs.ts";

export interface ReadOptions {
	readonly issue: number;
	readonly base: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "handoff read";

export const runRead = (
	options: ReadOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const issue = yield* requireIssue(VERB, repo, options.issue);
		if (issue._tag === "Refused") return issue.outcome;

		const resolved = yield* resolvePack(repo, options.issue);
		if (resolved._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${resolved.reason} — whether a pack exists is UNKNOWN, never none.`,
			);
		}
		if (resolved._tag === "Malformed") {
			return refuse(
				PACK_MALFORMED,
				`${VERB}: comment #${resolved.comment} carries a handoff marker and does not parse (${resolved.reason}) — refusing to report no pack over a pack that exists. Read #${resolved.comment}.`,
			);
		}
		if (resolved._tag === "None") {
			return answer(
				JSON.stringify({
					issue: options.issue,
					pack: "none",
					packComment: null,
					packNonce: null,
					sealedAt: null,
					author: null,
					asserted: null,
					ground: null,
					drift: null,
					heldBy: null,
					disregarded: resolved.disregarded,
					scanned: {comments: resolved.comments},
				}),
				[
					`${VERB}: ${repo}, #${options.issue}, ${resolved.comments} comment(s) scanned, ${resolved.disregarded.length} disregarded, no pack.`,
				],
			);
		}

		const {sealed, heldBy, disregarded} = resolved;
		const packedBranch = yield* resolveBranch(sealed.ground.git.branch);
		if (packedBranch === "unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot re-derive the ground state: ${sealed.ground.git.branch} could not be resolved and this checkout could not be read either — the pack was found and the drift is UNKNOWN, so it is not reported as unchanged.`,
			);
		}

		let base = options.base;
		if (base === null) {
			const named = yield* repoDefaultBranch(repo);
			if (named._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot re-derive the ground state: ${named.reason} — the pack was found and the drift is UNKNOWN, so it is not reported as unchanged.`,
				);
			}
			base = named.value;
		}

		const board = {state: issue.value.state, labels: issue.value.labels};
		const branch = sealed.ground.git.branch;
		const derived =
			packedBranch === "resolves"
				? yield* deriveComparable({repo, issue: options.issue, ref: branch, base, board})
				: yield* deriveLiveBoard({repo, issue: options.issue, branch, board});
		if (derived._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot re-derive the ground state: ${derived.failure.reason} — the pack was found and the drift is UNKNOWN, so it is not reported as unchanged.`,
			);
		}
		const live: LiveGround = derived.value;

		const fields = compareGround(comparableOf(sealed.ground), live);
		const moved = fields.filter((row) => row.state !== "same");

		return answer(
			JSON.stringify({
				issue: options.issue,
				pack: heldBy === null ? "sealed" : "claimed",
				packComment: sealed.comment,
				packNonce: sealed.pack.nonce,
				sealedAt: sealed.pack.sealedAt,
				author: sealed.author,
				asserted: {
					intent: sealed.pack.intent,
					established: sealed.pack.established,
					nextAct: sealed.pack.nextAct,
					unsure: sealed.pack.unsure,
				},
				ground: {packed: sealed.pack.groundDigest},
				drift: {packedBranch, state: driftState(fields), fields: moved},
				heldBy,
				disregarded,
				scanned: {comments: resolved.comments},
			}),
			[
				`${VERB}: ${repo}, #${options.issue}, ${resolved.comments} comment(s) scanned, ${disregarded.length} disregarded, pack #${sealed.comment}, branch ${branch} ${packedBranch}.`,
			],
		);
	});
