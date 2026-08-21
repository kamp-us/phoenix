/**
 * The claim protocol `claim` / `confirm` / `release` share, and that every mutating verb re-runs
 * before it touches a number.
 *
 * One comment-marker race on the issue: post a marker carrying this session's token, re-read the
 * markers, and the **earliest authorized** one wins. The shape is ADR 0115's, re-implemented rather
 * than called (ADR 0238).
 *
 * **Ownership turns on the whole token, never on the session id alone.** A session is not a lane: one
 * driver session routinely runs several builders at once, and each mints its own token. Deciding
 * `Mine` on `parsed.session === session` reads as the obvious simplification — it is indistinguishable
 * under one lane per session — and it told the second lane it held the first lane's claim, so both ran
 * the same repair and both pushed (#6037). The asking lane therefore names itself, as a {@link Caller},
 * and a same-session marker under a different nonce is `Foreign`.
 *
 * **Authorization comes from repository permissions, never from the marker's text** (ADR 0055). A
 * marker whose author resolves below `write` is counted and reported, and never wins — otherwise the
 * race is decided by whoever is willing to type the winning string. A permission read that *fails* is
 * UNKNOWN, never a demotion: v1 silently demoted an authorized author on a transient read failure
 * (`claim/github.ts:229-231`), which hands the lane to a later claimant on a network blip.
 *
 * Three refusals stay separate, because v1 fused them and callers guessed: a proven loss is `15`, a
 * missing session id is `1`, and an unreadable marker set is `11` — never "unclaimed".
 *
 * The protocol is namespaced by a {@link ClaimGrammar} so a second kind of lane can race on the same
 * issue without colliding with a build claim; `build` reads {@link BUILD_CLAIM}, which is the default
 * everywhere, and the `lane` group reads its own (`../lane/claim.ts`).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import {sessionIdFrom, sessionIdUnset} from "../io/session-id.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {CLAIM_NOT_MINE, PRECONDITION_UNKNOWN} from "./codes.ts";
import {nonceOf, parseToken} from "./lane.ts";

/** The permissions that authorize a marker — the ADR 0055 `write+` set. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

/**
 * One claim namespace: the marker line's leading word, and the token's leading segment.
 *
 * Two namespaces race on the same issue and never see each other — `build-claim:`/`build:` for a
 * builder, `lane-claim:`/`lane:` for the `operate` driver that spawns it (#5761). That separation is
 * the whole reason the grammar is a value: the marker's regex is *derived* from the keyword and the
 * prefix, so a namespace cannot ship a writer and a reader that disagree, and a driver holding a
 * lane claim on issue N cannot lock its own builder out of N.
 */
export interface ClaimGrammar {
	readonly keyword: string;
	readonly prefix: string;
	readonly marker: RegExp;
}

const NAMESPACE = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * A namespace's grammar. Both halves are checked because they are interpolated into a regex: a
 * keyword carrying a metacharacter would compile a pattern nobody wrote, and the callers pass module
 * constants, so an off-shape one is a programming error rather than input to refuse.
 */
export const claimGrammar = (keyword: string, prefix: string): ClaimGrammar => {
	if (!NAMESPACE.test(keyword) || !NAMESPACE.test(prefix)) {
		throw new Error(`"${keyword}"/"${prefix}" is not a claim namespace (${NAMESPACE.source})`);
	}
	return {
		keyword,
		prefix,
		marker: new RegExp(`^${keyword}:\\s*(${prefix}:[^\\s·]+)\\s*(?:·.*)?$`, "m"),
	};
};

/**
 * The builder's namespace, and the one every existing caller reads: `build-claim: <token> · <ISO>`.
 *
 * The token is the only field ownership turns on. The timestamp is for a human reading the thread —
 * the tiebreak uses the comment's own `created_at`, which a claimant cannot author.
 */
export const BUILD_CLAIM: ClaimGrammar = claimGrammar("build-claim", "build");

/** An admission override: the lane it is taken for, and why. Both required — see `readOverride`. */
export interface ClaimOverride {
	readonly lane: string;
	readonly reason: string;
}

/**
 * The marker body, with an admission override recorded beneath it when one was used.
 *
 * The override rides on its **own line** rather than in the marker line: ownership turns on the token
 * alone, and a reason appended inline would be a free-text field inside the one line the resolver
 * parses. On a second line the escape hatch leaves the trace ADR 0245 asks for and the marker grammar
 * is untouched.
 */
export const composeMarker = (
	token: string,
	at: string,
	override: ClaimOverride | null = null,
	grammar: ClaimGrammar = BUILD_CLAIM,
): string =>
	override === null
		? `${grammar.keyword}: ${token} · ${at}`
		: `${grammar.keyword}: ${token} · ${at}\n${grammar.keyword}-override: ${override.lane} · ${override.reason}`;

/**
 * The marker a comment body carries in `grammar`, or `null` when it carries none of that kind.
 *
 * The session comes back beside the token because it is read out of the same parse the token's
 * well-formedness already turns on — deriving it again at a call site is a second parse that can
 * disagree, and the one it would disagree about is which session a stranded claim names.
 */
const readMarker = (
	body: string,
	grammar: ClaimGrammar,
): {readonly token: string; readonly session: string} | null => {
	const m = grammar.marker.exec(body);
	if (m?.[1] === undefined) return null;
	const parsed = parseToken(m[1], grammar.prefix);
	return parsed === null ? null : {token: m[1], session: parsed.session};
};

/** The token a comment body claims in `grammar`, or `null` when it carries no marker of that kind. */
export const readMarkerToken = (body: string, grammar: ClaimGrammar = BUILD_CLAIM): string | null =>
	readMarker(body, grammar)?.token ?? null;

export interface ClaimMarker {
	readonly commentId: number;
	readonly author: string;
	readonly createdAt: string;
	readonly token: string;
	/** The session the token names — what `build adopt --session` takes when that session is gone. */
	readonly session: string;
}

/**
 * The succession marker: `build-adopt: <dead-session> by <token> · <ISO> · reason: <text>`.
 *
 * A driver session dies and its builders' claim markers stay on the board; the successor names the
 * dead session here and `build release` then answers `Mine` for its claim (ADR 0295). The keyword is
 * derived from the namespace's prefix for the same reason the claim marker's is derived from its
 * keyword — a namespace cannot ship a writer and a reader that disagree.
 *
 * `by <token>` is what keeps this from being a general eviction: the adopt confers ownership on the
 * one session that token names, so a third session reading the same marker still sees `Foreign`.
 */
export const adoptMarkerRe = (grammar: ClaimGrammar): RegExp =>
	new RegExp(
		`^${grammar.prefix}-adopt:\\s*([^\\s·]+)\\s+by\\s+(${grammar.prefix}:[^\\s·]+)\\s*·\\s*[^·]*·\\s*reason:\\s*(\\S.*)$`,
		"m",
	);

export const composeAdoptMarker = (
	adopted: string,
	token: string,
	at: string,
	reason: string,
	grammar: ClaimGrammar = BUILD_CLAIM,
): string => `${grammar.prefix}-adopt: ${adopted} by ${token} · ${at} · reason: ${reason}`;

export interface AdoptMarker {
	readonly commentId: number;
	readonly author: string;
	readonly createdAt: string;
	/** The dead session whose claim this marker adopts. */
	readonly adopted: string;
	/** The adopting run's token — its session is the one that inherits the claim. */
	readonly token: string;
	readonly reason: string;
}

/** The adoption a comment body records, or `null` when it carries no well-formed adopt marker. */
export const readAdoptMarker = (
	body: string,
	grammar: ClaimGrammar = BUILD_CLAIM,
): {readonly adopted: string; readonly token: string; readonly reason: string} | null => {
	const m = adoptMarkerRe(grammar).exec(body);
	if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
	if (parseToken(m[2], grammar.prefix) === null) return null;
	const reason = m[3].trim();
	return reason === "" ? null : {adopted: m[1], token: m[2], reason};
};

/** Every adopt marker of `grammar` in a comment list, oldest first, ties broken by comment id. */
export const adoptMarkersIn = (
	comments: ReadonlyArray<CommentRecord>,
	grammar: ClaimGrammar = BUILD_CLAIM,
): ReadonlyArray<AdoptMarker> => {
	const markers: AdoptMarker[] = [];
	for (const comment of comments) {
		const read = readAdoptMarker(comment.body, grammar);
		if (read !== null) {
			markers.push({
				commentId: comment.id,
				author: comment.author,
				createdAt: comment.createdAt,
				...read,
			});
		}
	}
	return [...markers].sort((a, b) =>
		a.createdAt === b.createdAt ? a.commentId - b.commentId : a.createdAt < b.createdAt ? -1 : 1,
	);
};

/** Every claim marker of `grammar` in a comment list, oldest first, ties broken by comment id. */
export const markersIn = (
	comments: ReadonlyArray<CommentRecord>,
	grammar: ClaimGrammar = BUILD_CLAIM,
): ReadonlyArray<ClaimMarker> => {
	const markers: ClaimMarker[] = [];
	for (const comment of comments) {
		const read = readMarker(comment.body, grammar);
		if (read !== null) {
			markers.push({
				commentId: comment.id,
				author: comment.author,
				createdAt: comment.createdAt,
				...read,
			});
		}
	}
	return [...markers].sort((a, b) =>
		a.createdAt === b.createdAt ? a.commentId - b.commentId : a.createdAt < b.createdAt ? -1 : 1,
	);
};

/**
 * Which lane is asking — the identity every ownership question is answered against.
 *
 * `Lane` is the real one: a session plus the nonce of the token that lane holds, which is what
 * separates two builders of one session. `AnySession` is the pre-#6037 identity, kept only for the
 * claim namespaces that have not adopted a lane nonce (the `lane:` driver claim, and the epic claims
 * the `plan` and `ledger` groups take); it is a named opt-in precisely so the session-only rule cannot
 * come back as a default.
 */
export type Caller =
	| {
			readonly _tag: "Lane";
			readonly session: string;
			readonly nonce: string;
			/** The token the lane was handed, when it passed one — carried so a refusal can name it. */
			readonly token: string | null;
	  }
	| {readonly _tag: "AnySession"; readonly session: string};

/** The identity a build lane always has: a session AND the nonce of the token it holds. */
export type LaneCaller = Extract<Caller, {readonly _tag: "Lane"}>;

export const laneCaller = (
	session: string,
	nonce: string,
	token: string | null = null,
): LaneCaller => ({_tag: "Lane", session, nonce, token});

export const anySessionCaller = (session: string): Caller => ({_tag: "AnySession", session});

/** How a refusal names the asking lane, so a reader can tell two lanes of one session apart. */
export const describeCaller = (caller: Caller): string =>
	caller._tag === "AnySession"
		? `session ${caller.session}`
		: (caller.token ?? `the lane on nonce ${caller.nonce}`);

export type CallerRead =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Caller"; readonly caller: LaneCaller};

/**
 * The asking lane, read off the `--token` its `claim` verb handed it.
 *
 * A token from another session is refused rather than trusted: the env says which session is running,
 * the flag says which lane, and a pair that disagrees is a threaded-through token from somewhere else.
 * `grammar` is what keeps a namespace from admitting another's token — a `lane:` token handed to a
 * `build` verb names no lane it can resolve, so it is read as unparseable rather than as an identity.
 */
export const requireCallerToken = (
	verb: string,
	session: string,
	token: string,
	grammar: ClaimGrammar = BUILD_CLAIM,
): CallerRead => {
	const usage = (message: string): CallerRead => ({
		_tag: "Refused",
		outcome: refuse(FAILED, `${verb}: ${message}`),
	});
	const trimmed = token.trim();
	const parsed = parseToken(trimmed, grammar.prefix);
	const nonce = nonceOf(trimmed, grammar.prefix);
	if (parsed === null || nonce === null) {
		return usage(
			`--token "${trimmed}" is not a claim token (${grammar.prefix}:<session-id>:<uuid>) — which lane is asking is not stated.`,
		);
	}
	if (parsed.session !== session) {
		return usage(
			`--token "${trimmed}" carries session ${parsed.session}, but this run is session ${session} — a lane names itself, never another.`,
		);
	}
	return {_tag: "Caller", caller: laneCaller(session, nonce, trimmed)};
};

/**
 * Who holds the claim — four outcomes, and no two of them fold.
 *
 * `Mine` carries the adopt marker when the claim came through succession rather than directly, so
 * `release` can retract both comments; `adopt` is `null` on the ordinary path.
 */
export type Ownership =
	| {readonly _tag: "Mine"; readonly marker: ClaimMarker; readonly adopt: AdoptMarker | null}
	| {
			readonly _tag: "Foreign";
			readonly marker: ClaimMarker;
			/** The winner is another lane of the caller's own session — a wrong lane, not a wrong session. */
			readonly sameSession: boolean;
	  }
	| {readonly _tag: "Unclaimed"}
	| {readonly _tag: "Unknown"; readonly reason: string};

type Permission =
	| {readonly _tag: "Authorized"}
	| {readonly _tag: "Unauthorized"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** One memoized ACL reader — a repeat author costs one lookup, and a failed read is never a demotion. */
const permissionReader = (repo: string) => {
	const cache = new Map<string, boolean>();
	return (
		author: string,
	): Effect.Effect<Permission, never, ChildProcessSpawner.ChildProcessSpawner> =>
		Effect.gen(function* () {
			const cached = cache.get(author);
			if (cached !== undefined) {
				return cached ? ({_tag: "Authorized"} as const) : ({_tag: "Unauthorized"} as const);
			}
			const read = yield* permissionFor(repo, author);
			if (read._tag === "Unknown") {
				return {
					_tag: "Unknown" as const,
					reason: `the repository permission of "${author}" could not be read (${read.reason})`,
				};
			}
			const authorized = read._tag === "Present" && AUTHORIZED.has(read.value);
			cache.set(author, authorized);
			return authorized ? ({_tag: "Authorized"} as const) : ({_tag: "Unauthorized"} as const);
		});
};

/**
 * Resolve ownership of `number` against the asking lane.
 *
 * The ACL lookups run in marker order and stop at the first authorized one, so a thread full of
 * unauthorized markers costs one lookup each and the winner is found without reading the rest.
 * `unauthorized` carries the ones that were counted but did not win, which the caller reports on
 * stderr — content is not authority, but an ignored marker should still be visible.
 *
 * A winning marker held by another session is `Foreign` **unless** an authorized adopt marker on the
 * same number names that session and hands it to the asking lane (ADR 0295). An adopt is read
 * against the same `namesCaller` test the ordinary win is, so succession confers the claim on
 * exactly the lane its `by <token>` names and never re-widens ownership back to a whole session
 * (#6060). The adopt is read only on that branch, so the ordinary path costs exactly what it did.
 */
export const resolveOwnership = (
	repo: string,
	number: number,
	caller: Caller,
	grammar: ClaimGrammar = BUILD_CLAIM,
): Effect.Effect<
	{
		readonly ownership: Ownership;
		readonly unauthorized: ReadonlyArray<ClaimMarker>;
		readonly unauthorizedAdopts: ReadonlyArray<AdoptMarker>;
	},
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return {
				ownership: {_tag: "Unknown" as const, reason: listed.reason},
				unauthorized: [],
				unauthorizedAdopts: [],
			};
		}
		const authorizationOf = permissionReader(repo);
		/** Does `token` name the asking lane — its session, and its nonce too unless the namespace opted out. */
		const namesCaller = (token: string): boolean => {
			const parsed = parseToken(token, grammar.prefix);
			if (parsed === null || parsed.session !== caller.session) return false;
			return caller._tag === "AnySession" || nonceOf(token, grammar.prefix) === caller.nonce;
		};
		const unauthorized: ClaimMarker[] = [];
		let winner: ClaimMarker | null = null;
		for (const marker of markersIn(listed.value, grammar)) {
			const permission = yield* authorizationOf(marker.author);
			if (permission._tag === "Unknown") {
				return {
					ownership: {_tag: "Unknown" as const, reason: permission.reason},
					unauthorized,
					unauthorizedAdopts: [],
				};
			}
			if (permission._tag === "Unauthorized") {
				unauthorized.push(marker);
				continue;
			}
			winner = marker;
			break;
		}
		if (winner === null) {
			return {
				ownership: {_tag: "Unclaimed" as const},
				unauthorized,
				unauthorizedAdopts: [],
			};
		}
		const parsed = parseToken(winner.token, grammar.prefix);
		const sameSession = parsed !== null && parsed.session === caller.session;
		if (namesCaller(winner.token)) {
			return {
				ownership: {_tag: "Mine" as const, marker: winner, adopt: null},
				unauthorized,
				unauthorizedAdopts: [],
			};
		}
		const unauthorizedAdopts: AdoptMarker[] = [];
		for (const adopt of adoptMarkersIn(listed.value, grammar)) {
			if (parsed === null || adopt.adopted !== parsed.session) continue;
			if (!namesCaller(adopt.token)) continue;
			const permission = yield* authorizationOf(adopt.author);
			if (permission._tag === "Unknown") {
				return {
					ownership: {_tag: "Unknown" as const, reason: permission.reason},
					unauthorized,
					unauthorizedAdopts,
				};
			}
			if (permission._tag === "Unauthorized") {
				unauthorizedAdopts.push(adopt);
				continue;
			}
			return {
				ownership: {_tag: "Mine" as const, marker: winner, adopt},
				unauthorized,
				unauthorizedAdopts,
			};
		}
		return {
			ownership: {_tag: "Foreign" as const, marker: winner, sameSession},
			unauthorized,
			unauthorizedAdopts,
		};
	});

/** One claim marker on a thread, with the authority question already answered for it. */
export interface Claimant extends ClaimMarker {
	/** Whether the author's repository permission authorizes the marker (ADR 0055). */
	readonly authorized: boolean;
}

/** One succession marker, with the same authority question answered. */
export interface Adopter extends AdoptMarker {
	readonly authorized: boolean;
}

/**
 * Who holds a number, asked by nobody in particular.
 *
 * `Unknown` is the whole reason this is a sum rather than a list: a comment page or an ACL read that
 * failed leaves the question unanswered, and "no claim" is the one answer it must never collapse to.
 */
export type Claimants =
	| {readonly _tag: "Unknown"; readonly reason: string}
	| {
			readonly _tag: "Read";
			/** Every marker on the thread, oldest first — the unauthorized ones included. */
			readonly claimants: ReadonlyArray<Claimant>;
			readonly adopts: ReadonlyArray<Adopter>;
			/** The earliest authorized marker: the one every ownership question resolves against. */
			readonly holder: Claimant | null;
	  };

/**
 * Every claim on `number`, read against no asking lane at all.
 *
 * {@link resolveOwnership} answers "is this mine", which is the only question the protocol needed
 * while every asker held a claim. A driver arriving after a session limit killed its builders holds
 * none, and had no way to ask which issues those dead lanes left claimed (#6771) — `confirm` requires
 * a token of the caller's own session, and `claim` would answer only by racing a marker of its own.
 *
 * Unlike `resolveOwnership`, which stops at the first authorized marker because the winner is all it
 * needs, every marker's author is resolved: an unauthorized marker sitting beside the winner is
 * exactly what explains a thread a driver cannot make sense of, and hiding it would leave the
 * stranded set half-named. The ACL reader is memoized, so a thread of one author still costs one read.
 *
 * It reads and returns. Nothing here clears a claim, and nothing infers one from absence: the two
 * clearances are `build release` and `build adopt` (ADR 0295).
 */
export const readClaimants = (
	repo: string,
	number: number,
	grammar: ClaimGrammar = BUILD_CLAIM,
): Effect.Effect<Claimants, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") return {_tag: "Unknown" as const, reason: listed.reason};
		const authorizationOf = permissionReader(repo);
		const claimants: Claimant[] = [];
		for (const marker of markersIn(listed.value, grammar)) {
			const permission = yield* authorizationOf(marker.author);
			if (permission._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: permission.reason};
			}
			claimants.push({...marker, authorized: permission._tag === "Authorized"});
		}
		const adopts: Adopter[] = [];
		for (const adopt of adoptMarkersIn(listed.value, grammar)) {
			const permission = yield* authorizationOf(adopt.author);
			if (permission._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: permission.reason};
			}
			adopts.push({...adopt, authorized: permission._tag === "Authorized"});
		}
		return {
			_tag: "Read" as const,
			claimants,
			adopts,
			holder: claimants.find((claimant) => claimant.authorized) ?? null,
		};
	});

export type Session =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Session"; readonly id: string};

/** This run's session id, or the usage refusal. Unset is `1`: an identity-less claim is not a claim. */
export const requireSession = (
	verb: string,
	env: Readonly<Record<string, string | undefined>>,
): Session => {
	const id = sessionIdFrom(env);
	return id === null
		? {
				_tag: "Refused",
				outcome: refuse(
					FAILED,
					`${verb}: ${sessionIdUnset} — a claim without an identity is not a claim.`,
				),
			}
		: {_tag: "Session", id};
};

export type Held =
	| {
			readonly _tag: "Refused";
			readonly outcome: VerbOutcome;
			/** Why it refused, so a branch-asserting caller can re-map a same-session loss to `14`. */
			readonly ownership: Ownership;
			readonly notes: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Held"; readonly marker: ClaimMarker; readonly notes: ReadonlyArray<string>};

/**
 * The precondition every mutating verb runs: this lane holds `number`'s claim, proven now.
 *
 * The three refusals are the contract's, with the invoked verb's name substituted. Unclaimed lands on
 * `15` beside foreign because the caller's action is the same in both — stop, claim first — while the
 * message keeps the two facts apart for a reader.
 */
export const requireClaim = (
	verb: string,
	repo: string,
	number: number,
	caller: Caller,
): Effect.Effect<Held, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, caller);
		const notes = unauthorized.map(
			(marker) =>
				`${verb}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
		);
		if (ownership._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				ownership,
				notes,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read the claim markers on #${number}: ${ownership.reason} — the lane is UNKNOWN.`,
					notes,
				),
			};
		}
		if (ownership._tag === "Unclaimed") {
			return {
				_tag: "Refused" as const,
				ownership,
				notes,
				outcome: refuse(
					CLAIM_NOT_MINE,
					`${verb}: no claim exists on #${number} — nothing to confirm; run "fabrika build claim ${number}" first.`,
					notes,
				),
			};
		}
		if (ownership._tag === "Foreign") {
			return {
				_tag: "Refused" as const,
				ownership,
				notes,
				outcome: refuse(
					CLAIM_NOT_MINE,
					`${verb}: #${number} is held by ${ownership.marker.token}, not by ${describeCaller(caller)}.`,
					notes,
				),
			};
		}
		return {_tag: "Held" as const, marker: ownership.marker, notes};
	});
