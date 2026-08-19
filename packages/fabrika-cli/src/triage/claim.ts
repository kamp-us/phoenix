/**
 * The `triage claim` race protocol, as a pure function of the comments that were read.
 *
 * The whole verb is one rule: **`won` requires positive proof that the earliest surviving marker is
 * this lane's.** Nothing else may produce it — not an empty comment list, not a marker whose
 * ordering key is unreadable, not a set the caller could not fetch. v1's claim printed `won` and
 * exited 0 when its own identity read came back empty, because every comparison against an empty
 * string succeeded; that is a fail-open claim on a token that cannot write. Here the absence of
 * evidence resolves to {@link Unresolvable} or to `lost`, never to `won`.
 *
 * **A session is not a lane.** One triage fan-out routinely runs several triagers under one
 * `CLAUDE_CODE_SESSION_ID`, so a marker stamped with the session alone cannot tell two of them
 * apart: on 2026-08-18 two siblings each read a same-session marker back as their own and both
 * resolved `won`, then both wrote the issue (#6132). Every claimant therefore names itself as a
 * {@link Caller} — the same identity the `build` namespace resolves ownership against (#6037) — and
 * a same-session marker under a different lane nonce is somebody else's.
 *
 * Keeping the resolution here rather than in the verb is what makes the losing and the ambiguous
 * branches testable without a network: the verb supplies markers, a clock and a caller, and
 * this module decides.
 */
import type {Caller} from "../build/claim.ts";
import {composeToken, nonceOf, parseToken} from "../build/lane.ts";

export {anySessionCaller, type Caller, type LaneCaller, laneCaller} from "../build/claim.ts";

/**
 * The claim token shape a triage lane holds: `triage:<session-id>:<uuid>`.
 *
 * Its own namespace beside `build:` and `lane:`, on the shared token grammar rather than a second
 * one — the reader and the writer are `../build/lane.ts`'s, parameterised by this prefix.
 */
export const TOKEN_PREFIX = "triage";

/** Compose this lane's token from the session id and a fresh UUID. */
export const composeClaimToken = (session: string, uuid: string): string =>
	composeToken(session, uuid, TOKEN_PREFIX);

/** The lane nonce a triage token confers, or `null` when it does not parse as one. */
export const claimNonceOf = (token: string): string | null => nonceOf(token, TOKEN_PREFIX);

/** The session and uuid halves of a triage token, or `null` when it does not parse as one. */
export const parseClaimToken = (
	token: string,
): {readonly session: string; readonly uuid: string} | null => parseToken(token, TOKEN_PREFIX);

/** The exact one-line body a claim marker carries, up to the session id. */
export const MARKER_PREFIX = "<!-- fabrika-triage-claim session=";
const LANE_KEY = " lane=";
const MARKER_SUFFIX = " -->";

/**
 * The marker literal for one lane. One line, no surrounding prose — matched back by prefix.
 *
 * The `lane=` field is what a sibling lane of the same session reads back as *not* its own; a marker
 * without it is a pre-#6132 claim, which every lane now treats as another claimant's.
 */
export const markerBody = (caller: {readonly session: string; readonly nonce: string}): string =>
	`${MARKER_PREFIX}${caller.session}${LANE_KEY}${caller.nonce}${MARKER_SUFFIX}`;

/**
 * A session id fit to stamp a marker with: one whitespace-free token that cannot close the comment
 * early.
 *
 * An id carrying a space would post a marker this module reads back as a *different* session, so the
 * claim it proves would not be the claim it made. Refusing up front is the only reading that keeps
 * `won` a proof.
 */
export const isStampableSession = (session: string): boolean =>
	/^\S+$/.test(session) && !session.includes("-->");

/**
 * The session id stamped on `body`, or `null` when it is not a marker at all.
 *
 * Matched by the exact prefix the contract fixes, never by parsing prose. A body that carries the
 * prefix but no readable id yields `""` rather than `null`: it *is* a marker — some session posted
 * it — and dropping it would let a malformed competitor be silently ignored, which is the one
 * direction this protocol may not fail.
 */
export const sessionOf = (body: string): string | null => {
	const trimmed = body.trim();
	if (!trimmed.startsWith(MARKER_PREFIX)) return null;
	const rest = trimmed.slice(MARKER_PREFIX.length);
	const token = rest.split(/\s/, 1)[0] ?? "";
	return token;
};

// The whitespace is required, not cosmetic: without it a session id that itself began `lane=` would
// be read as its own lane nonce, and the marker would name a claimant nobody posted.
const LANE_RE = /\slane=(\S*)/;

/**
 * The lane nonce stamped on `body`, or `null` when the marker carries no `lane=` field at all.
 *
 * `null` is the pre-#6132 marker — a claimant that named a session and nothing else. It is read as a
 * distinct claimant rather than as a wildcard: a marker no live lane can prove is its own must lose
 * a race to the lane that can, and it ages out on the same TTL as any other.
 */
export const laneOf = (body: string): string | null => {
	if (sessionOf(body) === null) return null;
	const trimmed = body.trim();
	const rest = trimmed.slice(MARKER_PREFIX.length);
	const found = LANE_RE.exec(rest);
	return found?.[1] ?? null;
};

/** One claim marker, as the resolution orders it. */
export interface Marker {
	readonly id: number;
	readonly session: string;
	/** The lane nonce the marker names, or `null` for a pre-#6132 session-only marker. */
	readonly lane: string | null;
	/** GitHub's `created_at` — the ordering key, never a timestamp from the caller-supplied body. */
	readonly createdAt: string;
}

/** The markers among `comments`, in the order they were read. */
export const markersOf = (
	comments: ReadonlyArray<{readonly id: number; readonly createdAt: string; readonly body: string}>,
): ReadonlyArray<Marker> => {
	const out: Marker[] = [];
	for (const comment of comments) {
		const session = sessionOf(comment.body);
		if (session !== null) {
			out.push({
				id: comment.id,
				session,
				lane: laneOf(comment.body),
				createdAt: comment.createdAt,
			});
		}
	}
	return out;
};

/** Epoch milliseconds for an ISO timestamp, or `null` when it is not one. */
export const instantOf = (iso: string): number | null => {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
};

/**
 * How long a marker binds before it is treated as abandoned — the only TTL in the protocol.
 *
 * A constant rather than a flag: `triage claim --ttl-minutes 240` posted a marker the five mutating
 * verbs stopped honouring at 60, because they age a marker they did not place and the marker carries
 * no TTL of its own. That is the fail-open case #5644 exists to close, so the flag went and one
 * reading stands. Widening it means widening it here, for placer and reader alike.
 */
export const DEFAULT_TTL_MINUTES = 60;

export type ClaimResolution =
	| {readonly _tag: "Won"; readonly marker: Marker; readonly live: number; readonly expired: number}
	| {
			readonly _tag: "Lost";
			readonly holder: Marker;
			/** Non-null by construction: a set holding no marker of this lane is {@link MineAbsent}. */
			readonly mine: Marker;
			readonly live: number;
			readonly expired: number;
	  }
	/** No marker of this lane survives — whatever was posted is not on the issue. */
	| {readonly _tag: "MineAbsent"; readonly live: number; readonly expired: number}
	/** The ordering key itself could not be read, so no claim was resolved. */
	| {readonly _tag: "Unresolvable"; readonly reason: string};

export interface ResolveInput {
	readonly markers: ReadonlyArray<Marker>;
	/** Which claimant is asking — a lane, or a whole session for a namespace with no nonce yet. */
	readonly caller: Caller;
	/** Epoch milliseconds — the clock the TTL is measured against. */
	readonly now: number;
	readonly ttlMinutes: number;
}

/**
 * Does `marker` name the asking claimant — its session, and its lane nonce too unless the caller
 * named none?
 *
 * A `Lane` caller matches on the pair, which is the whole fix: two lanes of one session read each
 * other's markers as foreign. An `AnySession` caller is the pre-#6132 identity, kept for the readers
 * that have not adopted a nonce, and named rather than defaulted so the session-only rule cannot
 * come back by omission.
 */
export const namesCaller = (marker: Marker, caller: Caller): boolean =>
	marker.session === caller.session &&
	(caller._tag === "AnySession" || marker.lane === caller.nonce);

/** The markers still binding at `now`, oldest first — or the reason the set could not be ordered. */
export type LiveMarkers =
	| {readonly _tag: "Live"; readonly live: ReadonlyArray<Marker>; readonly expired: number}
	| {readonly _tag: "Unresolvable"; readonly reason: string};

/**
 * Discard the markers older than the TTL and order what survives, oldest first.
 *
 * A marker whose `created_at` will not parse is **not** dropped as expired and **not** ordered
 * against: it can neither be aged out nor placed, so the set has no answer and this refuses. The
 * tempting alternatives both break the invariant — treating it as expired discards a possibly-live
 * competitor, and treating it as newest lets an unreadable marker lose a race it was never placed
 * in.
 *
 * Split out of {@link resolveClaim} because two questions need it and only one of them is a race:
 * `triage claim` asks who won, and the mutating verbs ask whether any live marker names a session
 * other than theirs — a question `resolveClaim` cannot answer, since a caller holding no marker of
 * its own resolves {@link ClaimResolution} to `MineAbsent` however many competitors are live (#5644).
 */
export const liveMarkers = ({
	markers,
	now,
	ttlMinutes,
}: Omit<ResolveInput, "caller">): LiveMarkers => {
	const ttlMs = ttlMinutes * 60_000;
	const live: Marker[] = [];
	let expired = 0;
	for (const marker of markers) {
		const at = instantOf(marker.createdAt);
		if (at === null) {
			return {
				_tag: "Unresolvable",
				reason: `comment ${marker.id} carries no readable created_at, so the markers cannot be ordered`,
			};
		}
		if (now - at > ttlMs) expired++;
		else live.push(marker);
	}
	const ordered = [...live].sort((a, b) => {
		const at = instantOf(a.createdAt) ?? 0;
		const bt = instantOf(b.createdAt) ?? 0;
		return at === bt ? a.id - b.id : at - bt;
	});
	return {_tag: "Live", live: ordered, expired};
};

/** Order the live markers, then let the earliest survivor win. */
export const resolveClaim = ({markers, caller, now, ttlMinutes}: ResolveInput): ClaimResolution => {
	const scanned = liveMarkers({markers, now, ttlMinutes});
	if (scanned._tag === "Unresolvable") return scanned;
	const {live: ordered, expired} = scanned;

	const mine = ordered.find((m) => namesCaller(m, caller)) ?? null;
	const earliest = ordered[0];
	if (earliest === undefined || mine === null) {
		return {_tag: "MineAbsent", live: ordered.length, expired};
	}
	return namesCaller(earliest, caller)
		? {_tag: "Won", marker: earliest, live: ordered.length, expired}
		: {_tag: "Lost", holder: earliest, mine, live: ordered.length, expired};
};

/**
 * This lane's surviving marker, on either resolved outcome — `null` when it holds none.
 *
 * What "do I already hold a live marker here?" and "which marker do I retract on a loss?" both ask,
 * so both ask it once.
 */
export const myMarker = (resolution: ClaimResolution): Marker | null =>
	resolution._tag === "Won"
		? resolution.marker
		: resolution._tag === "Lost"
			? resolution.mine
			: null;

/** When a marker created at `createdAt` stops binding, as an ISO instant. */
export const expiryOf = (createdAt: string, ttlMinutes: number): string | null => {
	const at = instantOf(createdAt);
	return at === null ? null : new Date(at + ttlMinutes * 60_000).toISOString();
};
