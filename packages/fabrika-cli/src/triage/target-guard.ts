/**
 * The two preconditions every mutating `triage` verb re-reads on its target: it is still open, and
 * no live claim marker on it names another session.
 *
 * `triage claim` resolved the race correctly and nothing after it read the answer back, so the
 * protocol held only as long as prose discipline did. On 2026-08-15 it did not: a session that had
 * read `lost` ran `triage enrich` anyway and replaced the winner's authored body four minutes after
 * that session had closed the issue (#5644, on #5642). Both facts were sitting on the issue and
 * neither was read.
 *
 * **Holding no marker passes.** The check is "does a live marker name somebody else", not "do I hold
 * one": an unclaimed issue is the ordinary first-triage case, and demanding a marker would refuse
 * every existing caller. The consequence is that this guard narrows the window rather than closing
 * it — two unclaimed sessions still race — which is `triage claim`'s job, not this one's.
 *
 * **The session is the whole identity here, and the lane nonce #6132 added is not read.** These five
 * verbs are handed no claim token, so a sibling lane of one session reads its sibling's marker as
 * its own and passes — the same window that stayed open before, no wider. Closing it means threading
 * the token through every mutating verb, which is its own change.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type IssueRecord, listComments} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	DEFAULT_TTL_MINUTES,
	isStampableSession,
	liveMarkers,
	type Marker,
	markersOf,
} from "./claim.ts";
import {CLAIMED_ELSEWHERE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

/**
 * The live markers naming a session other than `session`, or the reason the set is unreadable.
 *
 * A session id this module cannot attribute a marker to — unset, or not one stampable token — makes
 * **every** live marker foreign. The alternative fails open exactly where it matters: an empty id
 * matches no marker, so a set full of live competitors would resolve to "nobody else holds it".
 */
export const foreignMarkers = ({
	markers,
	session,
	now,
	ttlMinutes,
}: {
	readonly markers: ReadonlyArray<Marker>;
	readonly session: string;
	readonly now: number;
	readonly ttlMinutes: number;
}):
	| {readonly _tag: "Foreign"; readonly foreign: ReadonlyArray<Marker>}
	| {
			readonly _tag: "Unresolvable";
			readonly reason: string;
	  } => {
	const scanned = liveMarkers({markers, now, ttlMinutes});
	if (scanned._tag === "Unresolvable") return scanned;
	const mine = isStampableSession(session) ? session : null;
	return {
		_tag: "Foreign",
		foreign: scanned.live.filter((m) => mine === null || m.session !== mine),
	};
};

export interface GuardOptions {
	/** The verb's own name, so the refusal reads as that verb's. */
	readonly verb: string;
	readonly repo: string;
	readonly issue: number;
	/** The record already read — this guard never re-fetches an issue a verb has in hand. */
	readonly target: IssueRecord;
	/** What the target is to this verb — `split` guards a parent, not the issue it creates. */
	readonly noun?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now?: () => Date;
}

/**
 * The refusal this target earns, or `null` when it is open and uncontested.
 *
 * Placed after the verb's own read of the issue and before its first write, so a refusal here always
 * means nothing landed.
 */
export const guardTarget = (
	options: GuardOptions,
): Effect.Effect<VerbOutcome | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {verb, repo, issue, target} = options;
		const noun = options.noun ?? "issue";

		if (target.state === "closed") {
			return refuse(ZERO_SCOPE, `${verb}: ${noun} #${issue} is already closed.`);
		}

		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read #${issue}'s comments in ${repo}: ${comments.reason} — the claim on it is UNKNOWN; nothing was written.`,
			);
		}

		const scanned = foreignMarkers({
			markers: markersOf(comments.value),
			session: options.env.CLAUDE_CODE_SESSION_ID ?? "",
			now: (options.now ?? (() => new Date()))().getTime(),
			ttlMinutes: DEFAULT_TTL_MINUTES,
		});
		if (scanned._tag === "Unresolvable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot resolve the claim on #${issue} in ${repo}: ${scanned.reason} — nothing was written.`,
			);
		}

		const holder = scanned.foreign[0];
		if (holder !== undefined) {
			return refuse(
				CLAIMED_ELSEWHERE,
				`${verb}: #${issue} is claimed by session ${holder.session === "" ? "(unreadable)" : holder.session} — refusing to mutate another session's issue. Run \`fabrika triage claim ${issue}\` and act only on \`won\`.`,
			);
		}
		return null;
	});
