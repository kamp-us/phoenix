/**
 * `build claimants` — who holds the claim on this number, asked by a caller holding none.
 *
 * The protocol's three ownership verbs all ask about the asking lane: `confirm` re-proves this
 * lane's claim and takes a token that must belong to this session, so a driver arriving after a
 * session limit killed its builders cannot use it to inspect the numbers those dead lanes left
 * claimed — and `claim` would answer only by racing a marker of its own, which is a write (#6771).
 * This asks the board and reports, and it is the whole of what it does.
 *
 * **It clears nothing.** ADR 0295 bans a TTL, a lease, a steal and eviction inferred from absence: a
 * stranded claim passes to a successor through a written `build adopt` and leaves through
 * `build release`. So this verb's answer is a list a driver acts on, never an act.
 *
 * A closed issue is reported rather than refused, unlike the rest of the group's `openIssue` fold:
 * the question here is answerable on a closed thread, and a claim marker outliving the issue it was
 * taken on is precisely the strandedness this verb is for. Absent is still `7` — there is no thread
 * to read — and unreadable is still `11`.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type Adopter, type Claimant, type Claimants, readClaimants} from "./claim.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {resolveTargetRepo} from "./target.ts";

const CLAIMANTS = "build claimants";

export interface ClaimantsOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** How the answer names one marker: the token, and the session a successor would adopt. */
const claimantJson = (claimant: Claimant) => ({
	commentId: claimant.commentId,
	author: claimant.author,
	createdAt: claimant.createdAt,
	token: claimant.token,
	session: claimant.session,
	authorized: claimant.authorized,
});

const adoptJson = (adopt: Adopter) => ({
	commentId: adopt.commentId,
	author: adopt.author,
	createdAt: adopt.createdAt,
	adopted: adopt.adopted,
	token: adopt.token,
	reason: adopt.reason,
	authorized: adopt.authorized,
});

export const runClaimants = (
	options: ClaimantsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const resolved = yield* resolveTargetRepo(CLAIMANTS, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {repo} = resolved;
		const {number} = options;

		const found = yield* getIssue(repo, number);
		if (found._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${CLAIMANTS}: issue #${number} is proven absent — there is no thread to read a claim off.`,
			);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIMANTS}: cannot read #${number}: ${found.reason} — who holds it is UNKNOWN, never "unclaimed".`,
			);
		}

		const read = yield* readClaimants(repo, number);
		if (read._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${CLAIMANTS}: cannot read the claim markers on #${number}: ${read.reason} — who holds it is UNKNOWN, never "unclaimed".`,
			);
		}

		const holder = read.holder;
		const payload = {
			answer: holder === null ? "unclaimed" : "held",
			number,
			holder: holder === null ? null : claimantJson(holder),
			claimants: read.claimants.map(claimantJson),
			adopts: read.adopts.map(adoptJson),
		};
		const notes = [
			...(found.value.state === "open" ? [] : [`${CLAIMANTS}: #${number} is closed.`]),
			...read.claimants
				.filter((claimant) => !claimant.authorized)
				.map(
					(claimant) =>
						`${CLAIMANTS}: comment ${claimant.commentId} carries a claim marker from "${claimant.author}", who holds no write permission — counted, never a winner.`,
				),
		];
		if (holder === null) {
			return answer(JSON.stringify(payload), [
				...notes,
				`${CLAIMANTS}: no authorized claim marker stands on #${number}.`,
			]);
		}
		const succeeded = read.adopts.some(
			(adopt) => adopt.authorized && adopt.adopted === holder.session,
		);
		return answer(JSON.stringify(payload), [
			...notes,
			`${CLAIMANTS}: #${number} is held by ${holder.token} (session ${holder.session}, comment ${holder.commentId}, posted ${holder.createdAt}).`,
			succeeded
				? `${CLAIMANTS}: session ${holder.session} has already been adopted — the lane that adopt names releases it.`
				: `${CLAIMANTS}: if that session is gone, the succession is a written one: fabrika build adopt ${number} --session ${holder.session} --reason "<why>", then release under the token adopt prints. Nothing clears a claim on its own (ADR 0295).`,
		]);
	});

/**
 * The same read, shaped for a sweep: a repo resolved once, then one answer per number.
 *
 * `lane stale --claims` pairs a lane with its issue's claim state, and it holds a token for none of
 * them — so it reaches the board through this rather than through the protocol's own verbs. The
 * repo is resolved on the first call and reused: a sweep of forty lanes otherwise pays forty
 * resolutions for one answer that cannot change mid-run.
 */
export const claimReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ((
	number: number,
) => Effect.Effect<Claimants, never, ChildProcessSpawner.ChildProcessSpawner>) => {
	let resolved: string | null = null;
	return (number) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			return yield* readClaimants(resolved, number);
		});
};
