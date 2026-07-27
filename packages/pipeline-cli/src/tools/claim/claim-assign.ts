/**
 * The pure layer-one decision — may this run write the coarse availability gate (the assignee)
 * on a lane, and does it still need writing? IO-free and total.
 *
 * The claim is two layers (gh-issue-intake-formats.md §7): the **assignee** is the coarse,
 * login-blind availability gate the write-code Step-1 picker reads, and the session-stamped
 * **claim comment** is the fine resolver. Only layer one stands between a finished lane and an
 * idle picker while a PR is in review, and on the delegated (orchestrated) path nobody the
 * contract named was writing it — so an issue could sit `status:triaged` + unassigned with a
 * finished implementation awaiting a gate (#4298).
 *
 * Two properties are the whole design, and both are structural here rather than a caller's
 * discipline:
 *
 *  - **Positive proof, never inference from absence.** The plan is `refuse` unless the caller's
 *    claim verdict is a proven `mine`. A missing assignee is *not* read as evidence about any
 *    other party — the run writes layer one because it holds the lane, not because it concluded
 *    someone else failed. That is the shape ADR 0215 §5 forbids, and it stays unrepresentable:
 *    there is no arm of `AssignPlan` that clears or reassigns a slot.
 *  - **Additive and idempotent.** A gate already carrying our login is `already-set` (no write);
 *    otherwise `assign` adds ours. Nothing here can unassign — every agent authenticates as the
 *    same login, so the assignee is one shared slot and "never unassign a slot you did not fill"
 *    (§7, #4015) is enforced by the type, not by review.
 */
import type {ClaimReason, ClaimVerdict} from "./claim-is-mine.ts";

/** Why layer one was refused: the claim did not resolve as ours, or we have no login to write. */
export type AssignRefusal = ClaimReason | "no-login";

/** What an assign will do: nothing (refused), nothing (already gated), or add our login. */
export type AssignPlan =
	| {readonly _tag: "refuse"; readonly reason: AssignRefusal; readonly owner: string | null}
	| {readonly _tag: "already-set"; readonly login: string}
	| {readonly _tag: "assign"; readonly login: string};

const has = (assignees: ReadonlyArray<string>, login: string): boolean =>
	assignees.some((a) => a.trim().toLowerCase() === login.trim().toLowerCase());

/**
 * Decide layer one for a lane: refuse unless the claim resolved as ours, no-op when the gate
 * already carries our login, else add it. `login` is the authenticated account the write would
 * name; an empty one refuses rather than posting an unnamed assignee.
 */
export const assignPlan = (input: {
	readonly verdict: ClaimVerdict;
	readonly login: string;
	readonly assignees: ReadonlyArray<string>;
}): AssignPlan => {
	if (!input.verdict.mine) {
		return {
			_tag: "refuse",
			reason: input.verdict.reason,
			owner: input.verdict.winner?.session ?? null,
		};
	}
	if (input.login.trim() === "") {
		return {_tag: "refuse", reason: "no-login", owner: input.verdict.winner?.session ?? null};
	}
	return has(input.assignees, input.login)
		? {_tag: "already-set", login: input.login}
		: {_tag: "assign", login: input.login};
};
