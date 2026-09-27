/**
 * Whose pull request this is — the one answer `build` (repair), `ship` (enqueue, merge) and
 * `heal-ci` (routing) read before they drive a PR.
 *
 * A pull request belongs to its author. It is the pipeline's to drive when its author is one of the
 * repo's own accounts (`ownAccounts`, or the running account alone when that set is empty), or when
 * an account the repo trusts to grant has handed it over with a takeover grant. Anything else is
 * `Foreign`, and a foreign PR is its author's to finish.
 *
 * Pure: the reads live in `./read.ts`. Everything here takes facts that were already read in full,
 * so each clause is a test over values, and an unreadable input never reaches this module.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9844#issuecomment-5851228368
 */

import {read as readGrant} from "../wire/takeover-grant.ts";

/** Who counts as ours: the declared `ownAccounts` set, or the running account alone. */
export type OwnSet =
	| {
			readonly _tag: "Declared";
			/** The entries as the file spells them, for the reason a refusal prints. */
			readonly entries: ReadonlyArray<string>;
			readonly holds: (login: string) => boolean;
	  }
	| {
			readonly _tag: "RunningAccount";
			readonly login: string;
			/** Why no declared set applies: absent file, absent key, empty array, or a malformed value. */
			readonly why: string;
	  };

export const ownSetHolds = (own: OwnSet, login: string): boolean =>
	own._tag === "Declared" ? own.holds(login) : sameLogin(own.login, login);

export const sameLogin = (a: string, b: string): boolean =>
	a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** One takeover-grant marker on the PR, judged. Only an honoured row hands the PR over. */
export interface GrantRow {
	readonly commentId: number;
	readonly by: string;
	readonly honoured: boolean;
	/** Why the row is not honoured. Absent on an honoured row. */
	readonly reason?: string;
}

/** The grant-author set, or why nobody may grant. */
export type Grantors =
	| {readonly _tag: "Set"; readonly holds: (login: string) => boolean}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** One comment, as much of it as grant judging reads. */
export interface GrantComment {
	readonly id: number;
	readonly author: string;
	readonly body: string;
}

/** The facts one PR's grants are judged against. */
export interface GrantFacts {
	readonly pr: number;
	/** The PR's author, whose own grant never counts. */
	readonly author: string;
	readonly grantors: Grantors;
	/** Whether a login holds `write+` on the repo, read live. */
	readonly writes: (login: string) => boolean;
}

/** Every comment that reaches for the takeover-grant marker, so a caller reads the ACL for just those. */
export const grantMarkers = <C extends GrantComment>(
	comments: ReadonlyArray<C>,
): ReadonlyArray<C> => comments.filter((comment) => readGrant(comment.body)._tag !== "Absent");

/**
 * Why one grant comment hands over nothing, or `null` when every clause holds.
 *
 * The clauses are conjunctive: the marker parses and names this PR, its author is in the
 * grant-author set, is not the PR's own author, and holds `write+`. The committed set narrows the
 * ACL, it never stands in for one.
 */
export const grantRefusal = (comment: GrantComment, facts: GrantFacts): string | null => {
	const parsed = readGrant(comment.body);
	if (parsed._tag === "Absent") return "the comment carries no takeover-grant marker";
	if (parsed._tag === "Malformed") return `the marker is malformed: ${parsed.reason}`;
	if (parsed.value.pr !== facts.pr) {
		return `the marker grants #${parsed.value.pr}, not #${facts.pr}`;
	}
	if (sameLogin(comment.author, facts.author)) {
		return `${comment.author} is this PR's author, and an author cannot hand their own PR over`;
	}
	if (facts.grantors._tag === "Unusable") return facts.grantors.reason;
	if (!facts.grantors.holds(comment.author)) {
		return `${comment.author} is not in the repo's grant-author set`;
	}
	return facts.writes(comment.author)
		? null
		: `${comment.author} holds no write permission on the repo`;
};

export const judgeGrants = (
	comments: ReadonlyArray<GrantComment>,
	facts: GrantFacts,
): ReadonlyArray<GrantRow> =>
	grantMarkers(comments).map((comment) => {
		const reason = grantRefusal(comment, facts);
		return {
			commentId: comment.id,
			by: comment.author,
			honoured: reason === null,
			...(reason === null ? {} : {reason}),
		};
	});

export type PrOwnership =
	| {readonly _tag: "Own"; readonly author: string; readonly basis: string}
	| {readonly _tag: "Granted"; readonly author: string; readonly grant: GrantRow}
	| {
			readonly _tag: "Foreign";
			readonly author: string;
			readonly basis: string;
			readonly grants: ReadonlyArray<GrantRow>;
	  };

/** The basis a PR is ours on, or would have been — the words every line and refusal repeats. */
export const ownSetText = (own: OwnSet): string =>
	own._tag === "Declared"
		? `ownAccounts (${own.entries.join(", ")})`
		: `the running account ${own.login}, since ${own.why}`;

/**
 * Whose PR this is.
 *
 * An author the read could not name is foreign, never ours: an empty login can hold no set, so the
 * fail-closed direction is the one that leaves the PR alone.
 */
export const prOwnershipOf = (
	author: string,
	own: OwnSet,
	grants: ReadonlyArray<GrantRow>,
): PrOwnership => {
	if (author.trim() !== "" && ownSetHolds(own, author)) {
		return {_tag: "Own", author, basis: ownSetText(own)};
	}
	const honoured = grants.find((grant) => grant.honoured);
	if (honoured !== undefined) return {_tag: "Granted", author, grant: honoured};
	return {_tag: "Foreign", author, basis: ownSetText(own), grants};
};

/** Whether the pipeline may drive the PR. */
export const drivable = (ownership: PrOwnership): boolean => ownership._tag !== "Foreign";

/** One stderr line naming the answer and what it rests on. */
export const prOwnershipLine = (verb: string, pr: number, ownership: PrOwnership): string => {
	switch (ownership._tag) {
		case "Own":
			return `${verb}: PR #${pr} was opened by ${ownership.author}, one of ours under ${ownership.basis}.`;
		case "Granted":
			return `${verb}: PR #${pr} was opened by ${ownership.author}, and ${ownership.grant.by} handed it over in comment ${ownership.grant.commentId}.`;
		case "Foreign":
			return `${verb}: PR #${pr} was opened by ${ownership.author === "" ? "an author the read could not name" : ownership.author}, who is not ours under ${ownership.basis}, and no valid takeover grant stands on it.`;
	}
};

/** One stderr line per grant marker that hands over nothing, so a void grant is seen to be void. */
export const voidGrantLines = (verb: string, ownership: PrOwnership): ReadonlyArray<string> =>
	ownership._tag === "Foreign"
		? ownership.grants.map(
				(grant) =>
					`${verb}: the takeover grant in comment ${grant.commentId} by ${grant.by} is void: ${grant.reason ?? "unhonoured"}.`,
			)
		: [];
