/**
 * An owner's sign-off on a pull request — the read that clears an `owner-action-required` park.
 *
 * The park says a reviewed, green PR waits on a step its owner takes by hand outside the pipeline.
 * No read proves that step ran, so the owner says it did: a comment on the PR carrying
 * `owner-action-signoff @ <sha>`. It counts only when the SHA is the PR's live head, so a push after
 * the sign-off holds the park again, and only when its author is on the control-plane roster
 * (`./roster.ts`), whether or not the PR touches a control-plane path.
 *
 * It is not a control-plane approval and never stands in for one. `ship cp-approval` reads its own
 * `control-plane-self-approval` marker and nothing here, so a sign-off grants no §CP discharge, and
 * this read never counts that marker, so an approval clears no owner's-step park.
 *
 * A roster or comment list that could not be read is `Unreadable`, never `Unsigned`: a failed read
 * that held as "not signed yet" would look like a wait on the owner when it is a wait on nobody.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10316#issuecomment-5974128227
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import type {PullRecord} from "../io/pulls.ts";
import {controlPlaneRoster} from "./roster.ts";
import {prefixMatch} from "./target.ts";

/** The marker's token, outside every verdict namespace and apart from `control-plane-self-approval`. */
export const OWNER_SIGNOFF_TOKEN = "owner-action-signoff";

const OWNER_SIGNOFF = /owner-action-signoff[ \t]*@[ \t]*([0-9a-f]{7,40})\b/i;

export type OwnerSignoff =
	/** A roster member signed off at the live head. */
	| {readonly _tag: "Signed"; readonly login: string; readonly sha: string}
	/** Every read landed and no sign-off counts at the live head, so the park holds. */
	| {readonly _tag: "Unsigned"; readonly reason: string}
	/** A read did not land, so whether the owner signed off is UNKNOWN. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Whether `comments` carry a sign-off by a member of `roster` bound to `head`.
 *
 * An empty roster is a proven answer and holds: nobody may sign off. A sign-off at another SHA is
 * named in the hold, because the owner's next move is a fresh sign-off at the head, not a first one.
 */
export const signoffAt = (
	comments: ReadonlyArray<Pick<CommentRecord, "author" | "body">>,
	roster: ReadonlySet<string>,
	head: string,
): OwnerSignoff => {
	if (roster.size === 0) {
		return {
			_tag: "Unsigned",
			reason: "the control-plane roster resolves to nobody, so no sign-off can count",
		};
	}
	let stale: {readonly login: string; readonly sha: string} | null = null;
	for (const comment of comments) {
		if (!roster.has(comment.author)) continue;
		const sha = OWNER_SIGNOFF.exec(comment.body)?.[1];
		if (sha === undefined) continue;
		if (prefixMatch(sha, head)) return {_tag: "Signed", login: comment.author, sha};
		stale = {login: comment.author, sha};
	}
	return stale === null
		? {
				_tag: "Unsigned",
				reason: `no control-plane owner has commented \`${OWNER_SIGNOFF_TOKEN} @ ${head}\``,
			}
		: {
				_tag: "Unsigned",
				reason: `${stale.login}'s sign-off binds ${stale.sha}, not the live head ${head} — a push after a sign-off needs a new one`,
			};
};

/** Read the roster and every comment on `pull`, then judge them with {@link signoffAt}. */
export const readOwnerSignoff = (
	repo: string,
	pull: Pick<PullRecord, "number" | "headSha" | "comments">,
): Effect.Effect<OwnerSignoff, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return {_tag: "Unreadable", reason: `the control-plane roster: ${roster.reason}`};
		}
		const listed = yield* listComments(repo, pull.number);
		if (listed._tag === "Failure") {
			return {_tag: "Unreadable", reason: `#${pull.number}'s comments: ${listed.reason}`};
		}
		if (listed.value.length < pull.comments) {
			return {
				_tag: "Unreadable",
				reason: `#${pull.number}'s comments: received ${listed.value.length} of ${pull.comments} declared, so a sign-off could sit in the part nobody read`,
			};
		}
		return signoffAt(listed.value, roster.logins, pull.headSha);
	});
