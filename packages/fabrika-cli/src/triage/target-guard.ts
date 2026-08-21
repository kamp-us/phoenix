/**
 * The two preconditions every mutating `triage` verb re-reads on its target: it is still open, and
 * no live claim marker on it names a claimant other than the asking lane.
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
 * **Foreignness is the session+lane pair, never the session alone (#6303).** A `--token` names which
 * lane of the session is asking, and a same-session marker under a different nonce is somebody
 * else's — the identity `triage claim` already resolves on (#6132) and the `build` namespace resolves
 * ownership against (#6037), now read on this side of the claim too.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type IssueRecord, listComments} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	type Asked,
	anySessionCaller,
	type Caller,
	DEFAULT_TTL_MINUTES,
	isStampableSession,
	liveMarkers,
	type Marker,
	markersOf,
	namesCaller,
	requireCallerToken,
	requireSession,
} from "./claim.ts";
import {CLAIMED_ELSEWHERE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";

/**
 * The live markers that do not name `caller`, or the reason the set is unreadable.
 *
 * A session id this module cannot attribute a marker to — unset, or not one stampable token — makes
 * **every** live marker foreign. The alternative fails open exactly where it matters: an empty id
 * matches no marker, so a set full of live competitors would resolve to "nobody else holds it".
 *
 * A tokenless caller (`AnySession`) cannot prove *which* lane of its session it is, so it is priced
 * fail-closed on exactly that ambiguity: it passes its session's markers while they all name one
 * lane, and once two lanes of its session hold live markers every one of them is foreign, because
 * the caller has no way to say which is its own. That keeps the uncontested call sites working and
 * refuses precisely the sibling race #6303 is about.
 */
export const foreignMarkers = ({
	markers,
	caller,
	now,
	ttlMinutes,
}: {
	readonly markers: ReadonlyArray<Marker>;
	readonly caller: Caller;
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
	if (!isStampableSession(caller.session)) {
		return {_tag: "Foreign", foreign: scanned.live};
	}
	if (caller._tag === "Lane") {
		return {_tag: "Foreign", foreign: scanned.live.filter((m) => !namesCaller(m, caller))};
	}
	const lanes = new Set(
		scanned.live.filter((m) => m.session === caller.session).map((m) => m.lane),
	);
	const contested = lanes.size > 1;
	return {
		_tag: "Foreign",
		foreign: scanned.live.filter((m) => contested || m.session !== caller.session),
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
	/**
	 * The token `triage claim` handed this lane, when the caller passed one — what tells two lanes of
	 * one session apart. Absent, the guard falls back to the session-wide identity and its
	 * fail-closed reading of a contested session.
	 */
	readonly token?: string | null;
	readonly now?: () => Date;
}

/** Which claimant is asking: the lane `--token` names, or the whole session when it named none. */
const askCaller = (
	verb: string,
	env: Readonly<Record<string, string | undefined>>,
	token: string | null | undefined,
): Asked<Caller> => {
	const trimmed = (token ?? "").trim();
	if (trimmed === "") {
		return {_tag: "Asked", value: anySessionCaller((env.CLAUDE_CODE_SESSION_ID ?? "").trim())};
	}
	const session = requireSession(
		verb,
		env,
		"the lane --token names cannot be checked against the session running it",
	);
	if (!("_tag" in session)) return session;
	const lane = requireCallerToken(verb, session.value, trimmed);
	return "_tag" in lane ? {_tag: "Asked", value: lane.value.caller} : lane;
};

/**
 * How the refusal names the claimant that beat this caller.
 *
 * A sibling lane of one session and a wholly foreign session are the same refusal and different
 * facts, and "claimed by session <mine>" over the first would read as this caller's own claim
 * locking it out.
 */
const heldElsewhere = (issue: number, holder: Marker, caller: Caller): string => {
	const run = `Run \`fabrika triage claim ${issue}\` and act only on \`won\`.`;
	if (holder.session !== caller.session) {
		const named = holder.session === "" ? "(unreadable)" : holder.session;
		return `#${issue} is claimed by session ${named} — refusing to mutate another session's issue. ${run}`;
	}
	if (caller._tag === "Lane") {
		return `#${issue} is claimed by lane ${holder.lane ?? "(pre-#6132, session-only)"} of this session, not by this lane (${caller.nonce}) — refusing to mutate a sibling lane's issue. ${run}`;
	}
	return `#${issue} carries live claim markers from more than one lane of this session and this call names none, so which lane is asking is UNKNOWN — pass the \`--token\` \`fabrika triage claim ${issue}\` handed this lane.`;
};

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

		const asked = askCaller(verb, options.env, options.token);
		if (!("_tag" in asked)) return asked.refusal;

		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read #${issue}'s comments in ${repo}: ${comments.reason} — the claim on it is UNKNOWN; nothing was written.`,
			);
		}

		const caller = asked.value;
		const scanned = foreignMarkers({
			markers: markersOf(comments.value),
			caller,
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
			return refuse(CLAIMED_ELSEWHERE, `${verb}: ${heldElsewhere(issue, holder, caller)}`);
		}
		return null;
	});
