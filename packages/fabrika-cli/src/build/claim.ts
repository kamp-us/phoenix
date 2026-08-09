/**
 * The claim protocol `claim` / `confirm` / `release` share, and that every mutating verb re-runs
 * before it touches a number.
 *
 * One comment-marker race on the issue: post a marker carrying this session's token, re-read the
 * markers, and the **earliest authorized** one wins. The shape is ADR 0115's, re-implemented rather
 * than called (ADR 0238).
 *
 * **Authorization comes from repository permissions, never from the marker's text** (ADR 0055). A
 * marker whose author resolves below `write` is counted and reported, and never wins — otherwise the
 * race is decided by whoever is willing to type the winning string. A permission read that *fails* is
 * UNKNOWN, never a demotion: v1 silently demoted an authorized author on a transient read failure
 * (`claim/github.ts:229-231`), which hands the lane to a later claimant on a network blip.
 *
 * Three refusals stay separate, because v1 fused them and callers guessed: a proven loss is `15`, a
 * missing session id is `1`, and an unreadable marker set is `11` — never "unclaimed".
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {CLAIM_NOT_MINE, PRECONDITION_UNKNOWN} from "./codes.ts";
import {parseToken} from "./lane.ts";

/** The env var the session id arrives in. A claim without an identity is not a claim. */
export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/** The permissions that authorize a marker — the ADR 0055 `write+` set. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

/**
 * The marker's one line: `build-claim: <token> · <ISO-8601-UTC>`.
 *
 * The token is the only field ownership turns on. The timestamp is for a human reading the thread —
 * the tiebreak uses the comment's own `created_at`, which a claimant cannot author.
 */
const MARKER_RE = /^build-claim:\s*(build:[^\s·]+)\s*(?:·.*)?$/m;

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
): string =>
	override === null
		? `build-claim: ${token} · ${at}`
		: `build-claim: ${token} · ${at}\nbuild-claim-override: ${override.lane} · ${override.reason}`;

/** The token a comment body claims, or `null` when it carries no marker. */
export const readMarkerToken = (body: string): string | null => {
	const m = MARKER_RE.exec(body);
	return m?.[1] === undefined || parseToken(m[1]) === null ? null : m[1];
};

export interface ClaimMarker {
	readonly commentId: number;
	readonly author: string;
	readonly createdAt: string;
	readonly token: string;
}

/** Every claim marker in a comment list, oldest first, ties broken by comment id. */
export const markersIn = (comments: ReadonlyArray<CommentRecord>): ReadonlyArray<ClaimMarker> => {
	const markers: ClaimMarker[] = [];
	for (const comment of comments) {
		const token = readMarkerToken(comment.body);
		if (token !== null) {
			markers.push({
				commentId: comment.id,
				author: comment.author,
				createdAt: comment.createdAt,
				token,
			});
		}
	}
	return [...markers].sort((a, b) =>
		a.createdAt === b.createdAt ? a.commentId - b.commentId : a.createdAt < b.createdAt ? -1 : 1,
	);
};

/** Who holds the claim — four outcomes, and no two of them fold. */
export type Ownership =
	| {readonly _tag: "Mine"; readonly marker: ClaimMarker}
	| {readonly _tag: "Foreign"; readonly marker: ClaimMarker}
	| {readonly _tag: "Unclaimed"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * Resolve ownership of `number` against `session`.
 *
 * The ACL lookups run in marker order and stop at the first authorized one, so a thread full of
 * unauthorized markers costs one lookup each and the winner is found without reading the rest.
 * `unauthorized` carries the ones that were counted but did not win, which the caller reports on
 * stderr — content is not authority, but an ignored marker should still be visible.
 */
export const resolveOwnership = (
	repo: string,
	number: number,
	session: string,
): Effect.Effect<
	{readonly ownership: Ownership; readonly unauthorized: ReadonlyArray<ClaimMarker>},
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const listed = yield* listComments(repo, number);
		if (listed._tag === "Failure") {
			return {ownership: {_tag: "Unknown" as const, reason: listed.reason}, unauthorized: []};
		}
		const markers = markersIn(listed.value);
		const unauthorized: ClaimMarker[] = [];
		const permissions = new Map<string, string | null>();
		for (const marker of markers) {
			let permission = permissions.get(marker.author);
			if (permission === undefined) {
				const read = yield* permissionFor(repo, marker.author);
				if (read._tag === "Unknown") {
					return {
						ownership: {
							_tag: "Unknown" as const,
							reason: `the repository permission of "${marker.author}" could not be read (${read.reason})`,
						},
						unauthorized,
					};
				}
				permission = read._tag === "Present" ? read.value : null;
				permissions.set(marker.author, permission);
			}
			if (permission === null || !AUTHORIZED.has(permission)) {
				unauthorized.push(marker);
				continue;
			}
			const parsed = parseToken(marker.token);
			const mine = parsed !== null && parsed.session === session;
			return {
				ownership: mine ? ({_tag: "Mine", marker} as const) : ({_tag: "Foreign", marker} as const),
				unauthorized,
			};
		}
		return {ownership: {_tag: "Unclaimed" as const}, unauthorized};
	});

export type Session =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Session"; readonly id: string};

/** This run's session id, or the usage refusal. Unset is `1`: an identity-less claim is not a claim. */
export const requireSession = (
	verb: string,
	env: Readonly<Record<string, string | undefined>>,
): Session => {
	const id = (env[SESSION_ENV] ?? "").trim();
	return id === ""
		? {
				_tag: "Refused",
				outcome: refuse(
					FAILED,
					`${verb}: ${SESSION_ENV} is unset — a claim without an identity is not a claim.`,
				),
			}
		: {_tag: "Session", id};
};

export type Held =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Held"; readonly marker: ClaimMarker; readonly notes: ReadonlyArray<string>};

/**
 * The precondition every mutating verb runs: this session holds `number`'s claim, proven now.
 *
 * The three refusals are the contract's, with the invoked verb's name substituted. Unclaimed lands on
 * `15` beside foreign because the caller's action is the same in both — stop, claim first — while the
 * message keeps the two facts apart for a reader.
 */
export const requireClaim = (
	verb: string,
	repo: string,
	number: number,
	session: string,
): Effect.Effect<Held, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {ownership, unauthorized} = yield* resolveOwnership(repo, number, session);
		const notes = unauthorized.map(
			(marker) =>
				`${verb}: comment ${marker.commentId} carries a claim marker from "${marker.author}", who holds no write permission — counted, never a winner.`,
		);
		if (ownership._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
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
				outcome: refuse(
					CLAIM_NOT_MINE,
					`${verb}: #${number} is held by ${ownership.marker.token}, not this session.`,
					notes,
				),
			};
		}
		return {_tag: "Held" as const, marker: ownership.marker, notes};
	});
