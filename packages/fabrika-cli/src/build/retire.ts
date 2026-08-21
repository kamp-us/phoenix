/**
 * The release predicate `build retire` turns on: may this worktree's checkout be taken from it?
 *
 * Pure, and separated from the verb because the whole ruling on #6610 lives here — the two licenses
 * are board-attested positive statements, and neither is an inference from a tree that looks idle
 * (ADR 0323, which is why ADR [0215](../../../../.decisions/0215-claim-identity-continuity-proof.md)
 * §5's ban on eviction-by-inference is satisfied rather than widened).
 *
 * **Dirty is not an input.** The founder's ruling rejects it explicitly: agents routinely leave a
 * worktree dirty long after its ticket merged, so dirtiness is a false negative for "work in
 * progress" and reading it would keep the deadlock in the case that most needs clearing.
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
 * **authorized** ADR 0295 adopt marker on this number declares gone; `sessionByNonce` maps each
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

/** Why a worktree may be retired. Two constructors, because there are exactly two licenses. */
export type License = "ticket-terminal" | "session-adopted";

export type Verdict =
	| {readonly _tag: "Release"; readonly license: License; readonly because: string}
	| {readonly _tag: "Hold"; readonly because: string}
	/** This is the tree the verb is running in — git refuses to remove it, and so does this. */
	| {readonly _tag: "Self"};

/**
 * Seat one subject against the board.
 *
 * The self arm comes first because it is not a licensing question at all: a process cannot pull the
 * checkout out from under itself, and a verdict that said it could would be a refusal git makes
 * anyway, one step later and with a worse message.
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
	return {
		_tag: "Hold",
		because:
			session === undefined
				? `#${laneNumber(subject.lane)} ${board.describe}, and no authorized claim marker on it carries this branch's lane nonce — nothing on the board says its session is gone`
				: `#${laneNumber(subject.lane)} ${board.describe}, and no authorized build-adopt marker on it names session ${session}`,
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
