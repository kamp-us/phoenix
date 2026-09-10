/**
 * `build deviations` — post an epic child's disclosure as the ONE `build-deviations` marker on its
 * issue, replaced in place on every later round.
 *
 * An epic child opens no PR, so its `## Deviations` section lands as a marker comment on
 * the child issue instead of a PR body. The skill used to compose that comment with `wire emit` and
 * post it with a raw `gh issue comment`, which appends — so a repair round left the issue carrying
 * two markers, and `wire read --format build-deviations` refuses two conforming headings as
 * undecidable. The tail review is told to read every child's disclosure through that verb, so one
 * repaired child stranded a whole epic's tail.
 *
 * **One marker per issue is this verb's invariant, and it is enforced in both directions.** The
 * standing marker is PATCHed in place rather than appended, and any older marker of this issue's own
 * — this account's, read through the format — is retracted after the new bytes read back. Retraction
 * is what makes the invariant hold on an issue a pre-fix lane already stacked; leaving the stale one
 * would keep the reader at `malformed` for exactly the reason the fix exists. A retraction that
 * fails is UNKNOWN and never a success: two markers still read as no disclosure at all.
 *
 * **The marker discloses the whole reviewed range, not the round that last wrote it.** One marker
 * replaced in place means a repair round's natural rewrite — the entries that round produced — silently
 * retires the entries the round before it disclosed, which is how a child's standing text came to
 * describe a narrower range than the one a reviewer grades. So the replacement is compared against
 * the standing disclosure before it is written, and a section that drops an entry is refused: an
 * entry leaves only by restating it under a `Disposition` that says what became of it.
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
	DISCLOSURE_INCOMPLETE,
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
	/** The token `build claim` handed this lane — the identity it posts under. */
	readonly token: string;
	/** Read the standing disclosure and write nothing — what a round carries forward. */
	readonly standing: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** A standing marker of this account's, with the disclosure it already carries. */
interface StandingMarker {
	readonly comment: CommentRecord;
	readonly disclosure: deviations.DeviationsDisclosure;
}

/**
 * This account's standing markers for `issue`, oldest first, each with its disclosure read out.
 *
 * Read through the format rather than by prefix match, so a comment that merely quotes the marker
 * line is not mistaken for one, and a marker disclosing for another issue is never edited from here.
 * The disclosure rides along because the carry-forward gate needs it and a second read of the same
 * bytes could answer differently from the one that selected the comment.
 */
const standingMarkers = (
	comments: ReadonlyArray<CommentRecord>,
	me: string,
	issue: number,
): ReadonlyArray<StandingMarker> =>
	comments.flatMap((comment) => {
		if (comment.author !== me) return [];
		const read = buildDeviations.read(comment.body);
		return read._tag === "Found" && read.value.issue === issue
			? [{comment, disclosure: read.value.disclosure}]
			: [];
	});

type Ask =
	| {readonly _tag: "Read"}
	| {
			readonly _tag: "Post";
			readonly section: deviations.DeviationsDisclosure;
			readonly composed: string;
	  }
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** The disclosure on stdin, composed for `issue` — or the refusal its bytes earned. */
const askedDisclosure = (issue: number, stdin: StdinRead): Ask => {
	const authored = readAuthored(SURFACE, stdin);
	if (authored._tag === "Refused") return {_tag: "Refused", outcome: authored.outcome};

	const section = deviations.read(authored.text);
	if (section._tag === "Absent") {
		return {
			_tag: "Refused",
			outcome: refuse(
				BAD_SECTIONS,
				`${VERB}: the disclosure carries no "${"#".repeat(deviations.HEADING_LEVEL)} ${deviations.HEADING_TEXT}" heading — ${section.reason}.`,
			),
		};
	}
	if (section._tag === "Malformed") {
		return {
			_tag: "Refused",
			outcome: refuse(
				BAD_SECTIONS,
				`${VERB}: the disclosure is malformed — ${section.reason} (${section.evidence}).`,
			),
		};
	}
	return {
		_tag: "Post",
		section: section.value,
		composed: buildDeviations.emit({issue, disclosure: section.value}),
	};
};

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

		const ask: Ask = options.standing
			? {_tag: "Read"}
			: askedDisclosure(issue, yield* options.stdin);
		if (ask._tag === "Refused") return ask.outcome;

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
				`${VERB}: #${issue} is a pull request — a PR discloses in its body, and this marker is the epic child's surface. Use \`fabrika build pr\` or \`fabrika build pr-body\`.`,
			);
		}

		const asking = requireCallerToken(VERB, sessionRead.id, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const held = yield* requireClaim(VERB, repo, issue, asking.caller);
		if (held._tag === "Refused") return held.outcome;

		if (ask._tag === "Post") {
			const leaked = leakRefusal(VERB, ask.composed);
			if (leaked !== null) return leaked;
		}

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

		if (ask._tag === "Read") {
			return answer(
				current === undefined ? "" : deviations.emit(current.disclosure),
				current === undefined
					? [
							...held.notes,
							`${VERB}: #${issue} carries no standing marker — this round's disclosure is the first.`,
						]
					: [...held.notes, `${VERB}: standing marker: comment ${current.comment.id}.`],
			);
		}

		const dropped =
			current === undefined ? [] : deviations.droppedEntries(current.disclosure, ask.section);
		if (dropped.length > 0) {
			return refuse(
				DISCLOSURE_INCOMPLETE,
				`${VERB}: the replacement drops ${dropped.length} entry/entries the standing marker discloses (${dropped.map((entry) => `"${entry.said}"`).join("; ")}) — the marker discloses the whole reviewed range, not this round's commits, so an entry leaves only by restating it with a **${deviations.fieldLabel("disposition")}:** that says what became of it. Read the standing text with \`fabrika build deviations ${issue} --standing --token <token>\`, carry each entry into the section, and re-run.`,
				held.notes,
			);
		}

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (current === undefined) {
			const created = yield* createComment(repo, issue, ask.composed);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, current.comment.id, ask.composed);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: current.comment.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the write failed: ${failure ?? "unknown"} — UNKNOWN whether the disclosure landed; re-read #${issue} before retrying.`,
				held.notes,
			);
		}
		const upsert = current === undefined ? "created" : "edited";

		// The write call's own echo is not evidence: re-fetch, and assert both halves — the
		// bytes that were sent, and that the format still reads them as this issue's disclosure.
		const back = yield* getComment(repo, landed.id);
		const mismatch = readbackMismatch(back, ask.composed, issue);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted (comment ${landed.id}) but the read-back does not yield this disclosure (${mismatch}) — it needs a human eye.`,
				held.notes,
			);
		}

		// Retract every older marker only once the live one is proven — a retraction taken first would
		// destroy the standing disclosure on a write that then failed.
		const stale = standing.filter((marker) => marker.comment.id !== landed.id);
		const leftover: number[] = [];
		for (const marker of stale) {
			const removed = yield* deleteComment(repo, marker.comment.id);
			if (removed._tag === "Failure") leftover.push(marker.comment.id);
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
