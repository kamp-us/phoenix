/**
 * Who is on the control plane — one read, shared by every verb that needs it.
 *
 * Resolved from `.github/CODEOWNERS` on the repository's default branch, through the same
 * `./codeowners.ts` + `./github.ts` pair `ship cp-approval` uses. **One ACL module, not three.** A
 * second reading of "who is on the control plane" would drift from the one the merge gate enforces,
 * and drift here is an approval nobody with authority gave. It lives beside the merge gate rather
 * than under the group that reached for it first, because both `plan approve` and `decision rule`
 * resolve it and neither owns it.
 *
 * The one collapse this module refuses to make: a roster that could not be read is
 * `Unknown`, never an empty roster and never a permissive one. An empty roster is a *proven* fact and
 * a separate answer.
 *
 * **What the roster proves, exactly.** That the invoking token (on a write) or a marker's author (on
 * a read) is an account the control-plane owners resolve to. It does not prove a human typed the
 * command; nothing mechanical can, and the residue is the same one `build clear` carries. The rule
 * asks for a human behind the control-plane owner, and this is the mechanical half of that. A driver
 * recording a decision on that human's behalf posts from a roster account, so its marker is honoured
 * for the same reason a human-typed one is.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readBoundary} from "./boundary.ts";
import {controlPlaneOwnersOf, splitTeam} from "./codeowners.ts";
import {defaultBranch, listTeamMembers} from "./github.ts";

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
 * The ref is the default branch rather than a PR's base, because an issue has no branch — the
 * boundary is still read off a ref nobody in this run controls, which is the whole property. An
 * individual `@login` owner IS a roster entry and needs no team read.
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
