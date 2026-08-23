/**
 * The one GitHub read local to this group: whether a login is a member of a `@org/team` entry in
 * `campaignAuthors`.
 *
 * REST, never GraphQL, per skill conventions §11. The collaborator-permission read is
 * `../io/pulls.ts`'s `permissionFor` and is not re-implemented.
 *
 * **A `404` on the membership and a `404` on the team are two answers, and the split is the point.**
 * The first is a proven "not a member"; the second is a typo in `campaignAuthors`, and reading it as
 * "not a member" would send the caller off to find a different approver instead of to the key. So a
 * missing membership probes the team before it answers.
 */

import {Effect} from "effect";
import {authedExistence, existenceOf, restRead} from "../io/gh-api.ts";
import {fail, ok, type Shell} from "../io/git.ts";
import type {Existence} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";

const probeTeam = (org: string, team: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		Effect.map(restRead(token, "GET", `orgs/${org}/teams/${team}`), (outcome) =>
			existenceOf(outcome, (body) =>
				isRecord(body) && typeof body.slug === "string"
					? ok(body.slug)
					: fail("GitHub answered 200 but named no team"),
			),
		),
	);

const probeMembership = (org: string, team: string, login: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		Effect.map(
			restRead(token, "GET", `orgs/${org}/teams/${team}/memberships/${login}`),
			(outcome) =>
				existenceOf(outcome, (body) =>
					isRecord(body) && typeof body.state === "string"
						? ok(body.state)
						: fail("GitHub answered 200 but named no membership state"),
				),
		),
	);

/** Four answers, because "the org has no such team" routes to the config key and the others do not. */
export type TeamRead =
	| {readonly _tag: "Member"}
	| {readonly _tag: "NotMember"}
	| {readonly _tag: "NoTeam"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Whether `login` is an active member of `@org/team`. */
export const teamHolds = (org: string, team: string, login: string): Shell<TeamRead> =>
	Effect.gen(function* () {
		const membership = yield* probeMembership(org, team, login);
		if (membership._tag === "Unknown") return {_tag: "Unknown" as const, reason: membership.reason};
		if (membership._tag === "Present") {
			return membership.value === "active"
				? ({_tag: "Member"} as const)
				: ({_tag: "NotMember"} as const);
		}
		const exists = yield* probeTeam(org, team);
		if (exists._tag === "Unknown") return {_tag: "Unknown" as const, reason: exists.reason};
		return exists._tag === "Absent" ? ({_tag: "NoTeam"} as const) : ({_tag: "NotMember"} as const);
	});
