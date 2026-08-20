/**
 * The two reads both approval verbs share — who may approve, and what approval already stands — plus
 * the one gate the three re-deriving verbs enforce them through.
 *
 * The roster is resolved from `.github/CODEOWNERS` on the repository's default branch, through the
 * same `../ship/codeowners.ts` + `../ship/github.ts` pair `ship cp-approval` uses. One ACL module,
 * not two — a second reading of "who is on the control plane" would drift from the one the merge
 * gate enforces, and drift here is an approval nobody with authority gave.
 *
 * **Both sides resolve it, because a marker is bytes.** The write resolves it to decide whether this
 * invocation may post, and the read resolves it again to decide whose posted bytes count: posting a
 * `plan-approved:` line takes nothing but the ability to comment on the epic, and the digest it must
 * carry is printed on `plan check`'s stdout. A read honouring the format alone would let any agent
 * token in this pipeline approve a plan, which ADR 0289 forbids in as many words and which the
 * sibling `../build/clearances.ts` refuses under its clause 2 (ADR 0055 over 0051: a committed list
 * with no author gate is exactly the shape 0055 supersedes 0051 to forbid).
 *
 * The one collapse this module refuses to make is #4223's: a roster that could not be read is
 * `Unknown`, never an empty roster and never a permissive one. An empty roster is a *proven* fact and
 * a separate answer.
 *
 * **What the roster proves, exactly.** That the invoking token (on the write) or the marker's author
 * (on the read) is an account the control-plane owners resolve to. It does not prove a human typed
 * the command; nothing mechanical can, and the residue is the same one `build clear` carries. ADR
 * 0289 asks for a human on `@kamp-us/control-plane`, and this is the mechanical half of that. The
 * founder's grilling-Q1 ruling on epic #5843 keeps the driver-records-the-ruling pattern inside that
 * half rather than outside it: a driver writing on his behalf posts from a roster account, so its
 * marker is honoured for the same reason a founder-typed one is.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {defaultBranch} from "../build/github.ts";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {readBoundary} from "../ship/boundary.ts";
import {controlPlaneOwnersOf, splitTeam} from "../ship/codeowners.ts";
import {listTeamMembers} from "../ship/github.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {approves, type PlanApproval, read as readApproval} from "../wire/plan-approval.ts";
import {PLAN_UNAPPROVED, PRECONDITION_UNKNOWN} from "./codes.ts";
import type {PlanMessages} from "./load.ts";

export type RosterRead =
	| {readonly _tag: "Unknown"; readonly reason: string}
	| {
			readonly _tag: "Roster";
			/** The logins that may approve. Empty is proven — nobody may, and that is an answer. */
			readonly logins: ReadonlySet<string>;
			/** The CODEOWNERS owners it was expanded from, for the refusal's own evidence. */
			readonly owners: ReadonlyArray<string>;
			readonly ref: string;
	  };

/**
 * The control-plane roster on `repo`'s default branch.
 *
 * The ref is the default branch rather than a PR's base, because an epic has no branch — the
 * boundary is still read off a ref nobody in this run controls, which is the property #981 is about.
 * An individual `@login` owner IS a roster entry and needs no team read (#6299).
 */
export const controlPlaneRoster = (
	repo: string,
): Effect.Effect<RosterRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const trunk = yield* defaultBranch(repo);
		if (trunk._tag === "Failure") {
			return {_tag: "Unknown" as const, reason: `the default branch: ${trunk.reason}`};
		}
		const boundary = yield* readBoundary(repo, trunk.value);
		if (boundary._tag === "Unreadable") {
			return {_tag: "Unknown" as const, reason: `the §CP boundary: ${boundary.reason}`};
		}
		const owners = controlPlaneOwnersOf(boundary.rows);
		const logins = new Set<string>();
		for (const owner of owners) {
			const split = splitTeam(owner);
			if (split === null) {
				logins.add(owner.slice(1));
				continue;
			}
			const members = yield* listTeamMembers(split.org, split.team);
			if (members._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: `the ${owner} roster: ${members.reason}`};
			}
			if (members._tag === "Present") for (const login of members.value) logins.add(login);
		}
		return {_tag: "Roster" as const, logins, owners, ref: trunk.value};
	});

/** The three states an epic's approval resolves to. A fourth would have to be added here, in the open. */
export type ApprovalState = "current" | "stale" | "absent";

export interface StandingApproval {
	readonly approval: PlanApproval;
	readonly by: string;
	readonly comment: number;
}

export interface ApprovalScan {
	/** The newest conforming marker naming this epic, or `null` when none does. */
	readonly standing: StandingApproval | null;
	/**
	 * Comments that reach for the marker key and miss.
	 *
	 * Counted rather than dropped: a drifted marker is a *visible* state, the way `grill read` reports
	 * a disregarded ruling. Folding it into "nobody approved" would tell a founder who did approve
	 * that he never did.
	 */
	readonly disregarded: number;
	/**
	 * Conforming markers naming this epic whose author is off the roster.
	 *
	 * Counted for the same reason as `disregarded`, and it matters more: someone posted an approval
	 * that does not count, and a scan that dropped it silently would report the epic as never
	 * approved to the very account that tried.
	 */
	readonly unauthorized: number;
}

/**
 * The standing approval among an epic's comments, newest last.
 *
 * `roster` is the read-time author gate — a marker from an account outside it is not an approval,
 * however fresh its digest. Empty means nobody may approve here, so nothing stands.
 *
 * Ordered by `updatedAt` and then by id, never by `createdAt`: a marker edited after a later one was
 * posted is the newer statement, and only the write stamp says so (#4200).
 */
export const scanApprovals = (
	comments: ReadonlyArray<CommentRecord>,
	epic: number,
	roster: ReadonlySet<string>,
): ApprovalScan => {
	const ordered = [...comments].sort((a, b) =>
		a.updatedAt === b.updatedAt ? a.id - b.id : a.updatedAt < b.updatedAt ? -1 : 1,
	);
	let standing: StandingApproval | null = null;
	let disregarded = 0;
	let unauthorized = 0;
	for (const comment of ordered) {
		const found = readApproval(comment.body);
		if (found._tag === "Malformed") {
			disregarded += 1;
			continue;
		}
		if (found._tag !== "Found" || found.value.epic !== epic) continue;
		if (!roster.has(comment.author)) {
			unauthorized += 1;
			continue;
		}
		standing = {approval: found.value, by: comment.author, comment: comment.id};
	}
	return {standing, disregarded, unauthorized};
};

/** The state a scan resolves to against the digest derived from the plan as it now stands. */
export const stateOf = (scan: ApprovalScan, epic: number, derived: string): ApprovalState => {
	if (scan.standing === null) return "absent";
	return approves(scan.standing.approval, epic, derived) ? "current" : "stale";
};

export type ApprovalGate =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Approved"; readonly standing: StandingApproval};

/**
 * The approval **enforcement** the three re-deriving verbs share — ADR 0289's fail-closed
 * precondition, seated ahead of the floor so a defective unapproved plan refuses on the approval and
 * not on its defects.
 *
 * `derived` is the digest taken from the plan as this run has just read it, never one a caller
 * carried: an approval is a statement about a scope, so measuring it against a scope the caller
 * supplied would attest whatever the caller pleased. Same discipline as the `--digest` re-gate.
 *
 * `absent` and `stale` share {@link PLAN_UNAPPROVED} and the stderr line names which, because the two
 * need different repairs — one needs a founder to read the plan, the other to read it *again*.
 */
export const requireApproval = (
	messages: PlanMessages,
	repo: string,
	epic: number,
	derived: string,
	notes: ReadonlyArray<string>,
): Effect.Effect<ApprovalGate, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {verb} = messages;
		const refused = (
			code: number,
			message: string,
			lines: ReadonlyArray<string>,
		): ApprovalGate => ({
			_tag: "Refused" as const,
			outcome: refuse(code, message, lines),
		});

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refused(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read ${roster.reason} — who may approve is unread, so the approval is UNKNOWN, not absent.`,
				notes,
			);
		}
		const listed = yield* listComments(repo, epic);
		if (listed._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				messages.unreadable(`the comments on #${epic}`, listed.reason),
				notes,
			);
		}

		const scan = scanApprovals(listed.value, epic, roster.logins);
		const evidence = [
			...notes,
			`${verb}: read ${listed.value.length} comment(s) on #${epic}; ${scan.disregarded} disregarded marker(s), ${scan.unauthorized} from an account off the ${roster.logins.size}-account control-plane roster at ${roster.ref}.`,
		];
		const standing = scan.standing;
		if (standing === null) {
			return refused(
				PLAN_UNAPPROVED,
				`${verb}: #${epic} carries no founder approval of this plan (state absent) — refusing ahead of the floor (ADR 0289).`,
				evidence,
			);
		}
		if (!approves(standing.approval, epic, derived)) {
			return refused(
				PLAN_UNAPPROVED,
				`${verb}: #${epic}'s approval binds digest ${standing.approval.digest} but the plan now derives ${derived} (state stale) — it moved after it was approved; re-approve (ADR 0289).`,
				evidence,
			);
		}
		return {_tag: "Approved" as const, standing};
	});
