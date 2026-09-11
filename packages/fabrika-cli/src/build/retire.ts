/**
 * The release predicate `build retire` turns on: may this worktree's checkout be taken from it?
 *
 * Pure, and separated from the verb because the whole ruling lives here — the two licenses are
 * board-attested positive statements, and neither is an inference from a tree that looks idle, so
 * the ban on evicting a lane by inference is satisfied rather than widened.
 *
 * **Dirty is not an input to either board license.** The founder's ruling rejects it explicitly:
 * agents routinely leave a worktree dirty long after its ticket merged, so dirtiness is a false
 * negative for "work in progress" and reading it would keep the deadlock in the case that most needs
 * clearing.
 *
 * The third license covers the case the board says nothing about at all — no
 * authorized claim marker carries the branch's lane nonce, because the claim was released. Nothing
 * holds that lane, so there is no claim to evict; but with no board statement to lean on, the
 * evidence is `./reap.ts`'s rather than a board license's, and it is read the same way: a tree goes
 * only on positive proof that it carries nothing, and every other case holds.
 *
 * **What it counts as carried is what the removal would strand**, not what the branch is ahead by. A
 * removal takes the checkout and leaves the branch, so a commit the tree's own lane branch reaches
 * survives it by name and is nothing to lose; counting it held every salvaged tree forever, since
 * committing the work the uncommitted clause named was what tripped the commit clause. Only an
 * uncommitted path and a commit no ref of this clone reaches — a detached HEAD's orphans — die with
 * the checkout, and those are what hold. The ruling above is about *proof*, and proof of carrying
 * nothing is what this still demands.
 */

import {type LaneBranch, laneNumber, nonceOf, parseLaneBranch} from "./lane.ts";

/** One worktree of this clone that holds a build lane branch. */
export interface Subject {
	readonly path: string;
	readonly branch: string;
	readonly lane: LaneBranch;
}

/** The subjects among `checkouts` whose branch is a lane branch claimed under `number`. */
export const subjectsFor = (
	number: number,
	checkouts: ReadonlyArray<{readonly path: string; readonly branch: string}>,
): ReadonlyArray<Subject> =>
	checkouts.flatMap((checkout) => {
		const lane = parseLaneBranch(checkout.branch);
		return lane === null || laneNumber(lane) !== number
			? []
			: [{path: checkout.path, branch: checkout.branch, lane}];
	});

/**
 * What the board says about the number a lane branch carries.
 *
 * `terminal` is the *ticket* reaching its end — a closed issue, a merged pull request — and it is
 * read off the board rather than derived from anything local. `adoptedSessions` are the sessions an
 * **authorized** adopt marker on this number declares gone; `sessionByNonce` maps each
 * authorized claim marker's lane nonce to the session that took it, which is the only link from a
 * branch name back to a session.
 */
export interface BoardState {
	readonly terminal: boolean;
	/** What the board state is, in one clause a refusal or an answer can quote. */
	readonly describe: string;
	readonly adoptedSessions: ReadonlyArray<string>;
	readonly sessionByNonce: Readonly<Record<string, string>>;
}

/** Why a worktree may be retired. One constructor per license. */
export type License = "ticket-terminal" | "session-adopted" | "lane-unclaimed";

export type Verdict =
	| {readonly _tag: "Release"; readonly license: License; readonly because: string}
	| {readonly _tag: "Hold"; readonly because: string}
	/** This is the tree the verb is running in — git refuses to remove it, and so does this. */
	| {readonly _tag: "Self"}
	/**
	 * No lane holds this branch and the board licenses nothing: {@link seatResidue} decides on what
	 * the tree itself carries. Its own verdict rather than a `Release` because the caller has to go
	 * and read that, and a read it must make is one the type should not let it skip.
	 */
	| {readonly _tag: "Unclaimed"};

/** A verdict a caller acts on — every arm but the one {@link classify} defers to the tree. */
export type Seated = Exclude<Verdict, {readonly _tag: "Unclaimed"}>;

/** What a subject tree would take with it — the evidence the unclaimed arm turns on. */
export interface Residue {
	/** Paths the tree holds uncommitted. */
	readonly uncommitted: number;
	/** Commits the tree's HEAD reaches that no branch, remote-tracking ref or tag reaches. */
	readonly strandedCommits: number;
}

/**
 * Seat one subject against the board.
 *
 * The self arm comes first because it is not a licensing question at all: a process cannot pull the
 * checkout out from under itself, and a verdict that said it could would be a refusal git makes
 * anyway, one step later and with a worse message.
 *
 * A branch whose nonce a live claim marker carries holds on that alone, ahead of {@link seatResidue}
 * — a lane that holds its claim owns its tree however empty the tree looks, which is the
 * eviction-by-inference the ban forbids and this order makes unreachable.
 */
export const classify = (
	subject: Subject,
	board: BoardState,
	selfPaths: ReadonlySet<string>,
): Verdict => {
	if (selfPaths.has(subject.path)) return {_tag: "Self"};
	if (board.terminal) {
		return {
			_tag: "Release",
			license: "ticket-terminal",
			because: `#${laneNumber(subject.lane)} ${board.describe}`,
		};
	}
	const session = board.sessionByNonce[subject.lane.nonce];
	if (session !== undefined && board.adoptedSessions.includes(session)) {
		return {
			_tag: "Release",
			license: "session-adopted",
			because: `session ${session} holds this lane's claim and an authorized build-adopt marker on #${laneNumber(subject.lane)} declares it gone`,
		};
	}
	if (session !== undefined) {
		return {
			_tag: "Hold",
			because: `#${laneNumber(subject.lane)} ${board.describe}, and no authorized build-adopt marker on it names session ${session}`,
		};
	}
	return {_tag: "Unclaimed"};
};

/**
 * Seat an unclaimed subject on what it carries — the arm for a lane no claim holds.
 *
 * Everything short of both proofs holds, and each refusal names the count that blocked it, because
 * an operator's next move differs: uncommitted paths are committed onto the tree's branch or
 * discarded, and a stranded commit is given a name — a branch, a tag — before the checkout that is
 * its only handle goes. A tree carrying both is named for both rather than for whichever was read
 * first — there is no second read to discover the other one.
 */
export const seatResidue = (subject: Subject, residue: Residue): Seated => {
	const carried = [
		...(residue.uncommitted > 0 ? [`${residue.uncommitted} uncommitted path(s)`] : []),
		...(residue.strandedCommits > 0
			? [`${residue.strandedCommits} commit(s) no branch, remote-tracking ref or tag reaches`]
			: []),
	];
	return carried.length === 0
		? {
				_tag: "Release",
				license: "lane-unclaimed",
				because: `no authorized claim marker on #${laneNumber(subject.lane)} carries this branch's lane nonce, so no lane holds it, and the tree carries nothing its removal would strand: it is clean, and every commit it reaches is named by a ref that outlives the checkout`,
			}
		: {
				_tag: "Hold",
				because: `no authorized claim marker on #${laneNumber(subject.lane)} carries this branch's lane nonce, and the tree carries ${carried.join(" and ")} — with no board license, only a tree whose removal would strand nothing may go`,
			};
};

/**
 * The lane nonce an authorized claim marker's token confers, paired with the session that took it.
 *
 * Later markers do not overwrite earlier ones: the earliest authorized marker is the holder every
 * other ownership question resolves against (`./claim.ts`), and a retirement must key on the same
 * one rather than on whoever posted last.
 */
export const sessionsByNonce = (
	markers: ReadonlyArray<{
		readonly token: string;
		readonly session: string;
		readonly authorized: boolean;
	}>,
): Readonly<Record<string, string>> => {
	const byNonce: Record<string, string> = {};
	for (const marker of markers) {
		if (!marker.authorized) continue;
		const nonce = nonceOf(marker.token);
		if (nonce !== null && byNonce[nonce] === undefined) byNonce[nonce] = marker.session;
	}
	return byNonce;
};
