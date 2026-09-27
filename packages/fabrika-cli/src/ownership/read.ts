/**
 * The reads behind {@link prOwnershipOf}: the config at the PR's base ref, the running account, the
 * PR's comments and the live ACL of whoever posted a grant.
 *
 * The config is read at the **base** ref, never the head, so a pull request cannot add its own author
 * to `ownAccounts`. Who may post a grant is the control-plane set `.github/CODEOWNERS` names on the
 * default branch — the set `build clear` reads — so a pull request cannot name its own granter either.
 *
 * Each read happens only when the answer still depends on it: a PR one of ours opened costs the
 * config read (and the running account, when no set is declared) and nothing else, and the ACL is
 * read only for grant authors the control-plane set already names. A read that could not complete is
 * `Unknown`, never "foreign" and never "ours" — a gate that could not read whose PR this is has
 * proven nothing about it.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	clearsWriteFloor,
	controlPlaneMembership,
	expandAuthors,
	permissionsFor,
} from "../build/clearances.ts";
import {grantAuthorText} from "../config/keys/cap-clear-authors.ts";
import {OWN_ACCOUNTS, ownAccountsKey} from "../config/keys/own-accounts.ts";
import {loadConfig, resolve} from "../config/load.ts";
import type {Attempt} from "../io/git.ts";
import type {CommentRecord, Existence} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {CONFIG_PATH} from "../repo-config.ts";
import {readFileAtRef} from "../ship/github.ts";
import {
	type Grantors,
	grantMarkers,
	judgeGrants,
	type OwnSet,
	ownSetHolds,
	type PrOwnership,
	prOwnershipOf,
	sameLogin,
} from "./pr-ownership.ts";

export type PrOwnershipRead =
	| {readonly _tag: "Read"; readonly ownership: PrOwnership}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** The PR facts ownership is judged over — every caller already holds these off its own PR read. */
export interface PullFacts {
	readonly number: number;
	readonly author: string;
	readonly baseRef: string;
}

type OwnSetRead =
	| {readonly _tag: "Own"; readonly own: OwnSet}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** `ownAccounts` off the base-ref bytes, falling back to the running account when none applies. */
const ownSetFrom = (
	file: Existence<string>,
	baseRef: string,
): Effect.Effect<OwnSetRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (file._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: `${CONFIG_PATH} at ${baseRef}: ${file.reason}`};
		}
		const resolved = resolve(
			loadConfig(file._tag === "Absent" ? {_tag: "Absent"} : {_tag: "Text", text: file.value}),
			ownAccountsKey,
		);
		if (resolved._tag === "Unknown") {
			return {_tag: "Unknown" as const, reason: `${CONFIG_PATH} at ${baseRef}: ${resolved.reason}`};
		}
		if (resolved._tag === "Declared" && resolved.value.length > 0) {
			const expanded = yield* expandAuthors(resolved.value);
			if (expanded._tag === "Unknown") return expanded;
			return {
				_tag: "Own" as const,
				own: {
					_tag: "Declared" as const,
					entries: resolved.value.map(grantAuthorText),
					holds: expanded.holds,
				},
			};
		}
		const why =
			resolved._tag === "Malformed"
				? `\`${OWN_ACCOUNTS}\` at ${baseRef} is unusable (${resolved.reason})`
				: resolved._tag === "Declared"
					? `\`${OWN_ACCOUNTS}\` at ${baseRef} is empty`
					: `no \`${OWN_ACCOUNTS}\` is declared at ${baseRef}`;
		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return {_tag: "Unknown" as const, reason: `the running account: ${viewer.reason}`};
		}
		return {
			_tag: "Own" as const,
			own: {_tag: "RunningAccount" as const, login: viewer.value, why},
		};
	});

/**
 * Whose pull request this is, read in full.
 *
 * `comments` is handed in as an effect so a caller that already listed them passes the list it
 * holds, and one that has not pays for the read only when the PR is not plainly ours.
 */
export const readPrOwnership = <R>(
	repo: string,
	pull: PullFacts,
	comments: Effect.Effect<Attempt<ReadonlyArray<CommentRecord>>, never, R>,
): Effect.Effect<PrOwnershipRead, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const file = yield* readFileAtRef(repo, CONFIG_PATH, pull.baseRef);
		const own = yield* ownSetFrom(file, pull.baseRef);
		if (own._tag === "Unknown") return own;
		if (pull.author.trim() !== "" && ownSetHolds(own.own, pull.author)) {
			return {_tag: "Read" as const, ownership: prOwnershipOf(pull.author, own.own, [])};
		}

		const listed = yield* comments;
		if (listed._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `the comments on #${pull.number}: ${listed.reason}`,
			};
		}
		const markers = grantMarkers(listed.value);
		if (markers.length === 0) {
			return {_tag: "Read" as const, ownership: prOwnershipOf(pull.author, own.own, [])};
		}

		const membership = yield* controlPlaneMembership(repo);
		if (membership._tag === "Unknown") return membership;
		const grantors: Grantors =
			membership._tag === "Set" ? {_tag: "Set", holds: membership.holds} : membership;
		// Only a grant author the control-plane set already names, and who is not the PR's author, is worth an
		// ACL read: any other marker is void on a clause that cost nothing, and a hiccup reading an
		// irrelevant login must not turn a plainly void grant into an UNKNOWN gate.
		const permissions = yield* permissionsFor(
			repo,
			grantors._tag === "Set"
				? markers.flatMap((comment) =>
						grantors.holds(comment.author) && !sameLogin(comment.author, pull.author)
							? [comment.author]
							: [],
					)
				: [],
		);
		if (permissions._tag === "Unknown") return permissions;
		const rows = judgeGrants(markers, {
			pr: pull.number,
			author: pull.author,
			grantors,
			writes: (login) => clearsWriteFloor(permissions.levelOf(login)),
		});
		return {_tag: "Read" as const, ownership: prOwnershipOf(pull.author, own.own, rows)};
	});
