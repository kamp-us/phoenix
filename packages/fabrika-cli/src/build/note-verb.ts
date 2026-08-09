/**
 * `build note` — post a progress or handoff comment, head-stamped, leak-guarded, read back.
 *
 * **It runs only the posting guards — never the tree assertions.** A stop-report must stay postable
 * from a tree `build tree` just refused; a note that could only be written from a healthy lane is a
 * note that cannot report the lane being broken.
 *
 * When the target resolves to a pull request the note carries the PR's head SHA at post time, so a
 * reader can see at a glance that a note predates a later push. Without it a spot judgement carries no
 * freshness signal at all, which is the stale-repair-note class (#4808).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {requireClaim, requireSession} from "./claim.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {isPullRequest} from "./github.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build note";

const SURFACE = {
	verb: VERB,
	emptyMessage: `${VERB}: stdin held nothing — the body is the input.`,
	bareAtMessage: `${VERB}: the body is a bare @ path reference — write the body, not a pointer to it.`,
};

export interface NoteOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** The head stamp, appended as the note's final line. */
export const headStamp = (sha: string): string => `— at ${sha}`;

export const runNote = (
	options: NoteOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number} = options;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const kind = yield* isPullRequest(repo, number);
		if (kind._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${number} is proven absent or closed — nothing to post to.`,
			);
		}
		if (kind._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${number}: ${kind.reason} — nothing was written.`,
			);
		}

		let head: string | null = null;
		if (kind.value) {
			const pull = yield* getPullRequest(repo, number);
			if (pull._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read PR #${number}'s head: ${pull.reason} — nothing was written.`,
				);
			}
			if (pull._tag === "Absent" || pull.value.state !== "open") {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: #${number} is proven absent or closed — nothing to post to.`,
				);
			}
			head = pull.value.headSha;
		}

		const held = yield* requireClaim(VERB, repo, number, session.id);
		if (held._tag === "Refused") return held.outcome;

		const composed = head === null ? authored.text : `${authored.text}\n\n${headStamp(head)}`;
		const leaked = leakRefusal(VERB, composed);
		if (leaked !== null) return leaked;

		const posted = yield* createComment(repo, number, composed);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the write failed: ${posted.reason} — it may or may not have landed; re-read #${number} before retrying.`,
				held.notes,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		const matches =
			back._tag === "Ok" && normalizeForReadback(back.value) === normalizeForReadback(composed);
		return matches
			? answer(
					JSON.stringify({answer: "posted", number, commentId: posted.value.id, head}),
					held.notes,
				)
			: refuse(
					READBACK_MISMATCH,
					`${VERB}: posted (comment ${posted.value.id}) but the read-back does not match — it needs a human eye.`,
					held.notes,
				);
	});
