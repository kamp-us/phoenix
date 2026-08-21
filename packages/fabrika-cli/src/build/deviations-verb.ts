/**
 * `build deviations` — post an epic child's disclosure as the ONE `build-deviations` marker on its
 * issue, replaced in place on every later round.
 *
 * An epic child opens no PR (ADR 0285), so its `## Deviations` section lands as a marker comment on
 * the child issue instead of a PR body. The skill used to compose that comment with `wire emit` and
 * post it with a raw `gh issue comment`, which appends — so a repair round left the issue carrying
 * two markers, and `wire read --format build-deviations` refuses two conforming headings as
 * undecidable. The tail review is told to read every child's disclosure through that verb, so one
 * repaired child stranded a whole epic's tail (#6691).
 *
 * **One marker per issue is this verb's invariant, and it is enforced in both directions.** The
 * standing marker is PATCHed in place rather than appended, and any older marker of this issue's own
 * — this account's, read through the format — is retracted after the new bytes read back. Retraction
 * is what makes the invariant hold on an issue a pre-fix lane already stacked; leaving the stale one
 * would keep the reader at `malformed` for exactly the reason the fix exists. A retraction that
 * fails is UNKNOWN and never a success: two markers still read as no disclosure at all.
 *
 * The marker line is composed here from the positional, never taken from stdin, so a disclosure
 * cannot name an issue other than the one it sits on.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {Attempt} from "../io/git.ts";
import {
	type CommentRecord,
	createComment,
	deleteComment,
	getComment,
	listComments,
} from "../io/issues.ts";
import {patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import * as buildDeviations from "../wire/build-deviations.ts";
import * as deviations from "../wire/deviations.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {requireCallerToken, requireClaim, requireSession} from "./claim.ts";
import {
	BAD_SECTIONS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {isPullRequest} from "./github.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build deviations";

const SURFACE = {
	verb: VERB,
	emptyMessage: `${VERB}: stdin held nothing — an absent disclosure reads as "never considered it"; send the "## ${deviations.HEADING_TEXT}" section, or "${deviations.NONE_TEXT}" under its heading.`,
	bareAtMessage: `${VERB}: the disclosure is a bare @ path reference — write the section, not a pointer to it.`,
};

export interface DeviationsOptions {
	/** The epic child the disclosure is for — the issue the comment sits on. */
	readonly issue: number;
	/** The token `build claim` handed this lane — the identity it posts under (#6037). */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/**
 * This account's standing markers for `issue`, oldest first.
 *
 * Read through the format rather than by prefix match, so a comment that merely quotes the marker
 * line is not mistaken for one, and a marker disclosing for another issue is never edited from here.
 */
const standingMarkers = (
	comments: ReadonlyArray<CommentRecord>,
	me: string,
	issue: number,
): ReadonlyArray<CommentRecord> =>
	comments.filter((comment) => {
		if (comment.author !== me) return false;
		const read = buildDeviations.read(comment.body);
		return read._tag === "Found" && read.value.issue === issue;
	});

/**
 * Why the re-fetched comment does not show what was posted, or `null` when it does.
 *
 * Both assertions are needed. The **format** read is the contract a tail reviewer will run, so a
 * comment that landed unreadable must refuse here rather than a review round later. The **bytes**
 * comparison is the broader net: a marker that parses proves nothing about the section under it,
 * and the section is the disclosure.
 */
const readbackMismatch = (
	back: Attempt<string>,
	composed: string,
	issue: number,
): string | null => {
	if (back._tag === "Failure") return back.reason;
	const normalized = normalizeForReadback(back.value);
	const parsed = buildDeviations.read(normalized);
	if (parsed._tag === "Absent") return parsed.reason;
	if (parsed._tag === "Malformed") return parsed.reason;
	if (parsed.value.issue !== issue) {
		return `the marker discloses for #${parsed.value.issue}, expected #${issue}`;
	}
	return normalized === normalizeForReadback(composed)
		? null
		: "the comment's bytes are not the ones that were sent";
};

export const runDeviations = (
	options: DeviationsOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const {issue} = options;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		const section = deviations.read(authored.text);
		if (section._tag === "Absent") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the disclosure carries no "${"#".repeat(deviations.HEADING_LEVEL)} ${deviations.HEADING_TEXT}" heading — ${section.reason}.`,
			);
		}
		if (section._tag === "Malformed") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the disclosure is malformed — ${section.reason} (${section.evidence}).`,
			);
		}

		const sessionRead = requireSession(VERB, options.env);
		if (sessionRead._tag === "Refused") return sessionRead.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const kind = yield* isPullRequest(options.env, repo, issue);
		if (kind._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue} is proven absent or closed — nothing to disclose on.`,
			);
		}
		if (kind._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}: ${kind.reason} — nothing was written.`,
			);
		}
		if (kind.value) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${issue} is a pull request — a PR discloses in its body, and this marker is the epic child's surface (ADR 0285). Use \`fabrika build pr\` or \`fabrika build pr-body\`.`,
			);
		}

		const asking = requireCallerToken(VERB, sessionRead.id, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const held = yield* requireClaim(VERB, repo, issue, asking.caller);
		if (held._tag === "Refused") return held.outcome;

		const composed = buildDeviations.emit({issue, disclosure: section.value});
		const leaked = leakRefusal(VERB, composed);
		if (leaked !== null) return leaked;

		const me = yield* viewerLogin;
		if (me._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the authenticated user: ${me.reason} — nothing was written.`,
				held.notes,
			);
		}
		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue}'s comments: ${comments.reason} — nothing was written; a partial list would stack a second marker.`,
				held.notes,
			);
		}
		const standing = standingMarkers(comments.value, me.value, issue);
		// The NEWEST standing marker is the one in force, and the list arrives oldest-first — editing
		// the first match would revise a superseded disclosure and leave the live one untouched.
		const current = standing.at(-1);

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (current === undefined) {
			const created = yield* createComment(repo, issue, composed);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, current.id, composed);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: current.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the write failed: ${failure ?? "unknown"} — UNKNOWN whether the disclosure landed; re-read #${issue} before retrying.`,
				held.notes,
			);
		}
		const upsert = current === undefined ? "created" : "edited";

		// The write call's own echo is not evidence (#3173): re-fetch, and assert both halves — the
		// bytes that were sent, and that the format still reads them as this issue's disclosure.
		const back = yield* getComment(repo, landed.id);
		const mismatch = readbackMismatch(back, composed, issue);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted (comment ${landed.id}) but the read-back does not yield this disclosure (${mismatch}) — it needs a human eye.`,
				held.notes,
			);
		}

		// Retract every older marker only once the live one is proven — a retraction taken first would
		// destroy the standing disclosure on a write that then failed.
		const stale = standing.filter((comment) => comment.id !== landed.id);
		const leftover: number[] = [];
		for (const comment of stale) {
			const removed = yield* deleteComment(repo, comment.id);
			if (removed._tag === "Failure") leftover.push(comment.id);
		}
		if (leftover.length > 0) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the disclosure landed on comment ${landed.id}, but ${leftover.length} superseded marker(s) could not be retracted (${leftover.join(", ")}) — #${issue} still carries more than one, so \`fabrika wire read --format build-deviations\` reads it as malformed; delete them and re-run.`,
				held.notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "posted",
				issue,
				commentId: landed.id,
				upsert,
				retracted: stale.length,
				url: landed.url,
			}),
			held.notes,
		);
	});
