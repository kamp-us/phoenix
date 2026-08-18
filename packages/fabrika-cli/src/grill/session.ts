/**
 * What a grilling session is on GitHub, and how its comments are read back into questions and
 * markers — the one reader all five verbs share.
 *
 * A session is an issue carrying the `grilling:session` label. Its rounds and every recorded
 * ruling, answer and retirement live in its comments; nothing is kept locally, so there is no
 * scratch state for two runs to collide over.
 *
 * **A recorded ruling is bound to an authority, not to a string.** Every marker's author is
 * resolved against repository permissions before it counts, and a permission read that *fails* is
 * UNKNOWN rather than a demotion — the invariant `../build/claim.ts` states and ADR 0055 owns. The
 * gate applies to all three markers, not only to rulings: `clear` requires every question to be
 * `answered`, `ruled` or `superseded`, and `clear` is the token a downstream skill keys on, so an
 * un-gated answer or retirement would let any account with push access walk a session into the
 * state that licenses the next step.
 *
 * **Zero comments is a fact; a comment read that could not complete is not.** The session that has
 * been opened and not yet grilled is the ordinary first state, and it reads `empty`. A read that
 * failed leaves every question's state UNKNOWN — never `open` — because an unpaginated or truncated
 * read would silently drop the newest rounds and report a ruled question as open, which is the
 * fail-open direction (ADR 0092).
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, getIssue} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import * as grillAnswer from "../wire/grill-answer.ts";
import type {QuestionId, Stamp} from "../wire/grill-marker.ts";
import * as grillRuling from "../wire/grill-ruling.ts";
import * as grillSupersede from "../wire/grill-supersede.ts";
import {type Question, readRoundComment} from "./round.ts";

/** The label that makes a session findable. A created-but-unlabelled issue is invisible to it. */
export const SESSION_LABEL = "grilling:session";

/** The permissions that let an account's marker count. Anything else is recorded and disregarded. */
export const AUTHORIZED: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/**
 * Topic matching is exact under a stated normalization, never fuzzy: NFC, case folding, trimming,
 * and every internal whitespace run collapsed to one space. Nothing else — no stemming, no
 * substring, no edit distance. A fuzzy predicate would be judgment living inside a verb, and it
 * would refuse on titles a human reads as unrelated.
 */
export const normalizeTopic = (topic: string): string =>
	topic.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ");

export type SessionRead =
	| {
			readonly _tag: "Session";
			readonly title: string;
			readonly url: string;
			/** Carried so a reader can answer which ticket the session is bound to (`../came-from.ts`). */
			readonly body: string;
	  }
	/** Proven: no such issue, or an issue that is not a grilling session. */
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const resolveSession = (
	repo: string,
	issue: number,
): Effect.Effect<SessionRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, issue);
		if (found._tag === "Absent") return {_tag: "Absent" as const};
		if (found._tag === "Unknown") return {_tag: "Unknown" as const, reason: found.reason};
		return found.value.labels.includes(SESSION_LABEL)
			? {
					_tag: "Session" as const,
					title: found.value.title,
					url: found.value.url,
					body: found.value.body,
				}
			: {_tag: "Absent" as const};
	});

/** A round comment as it currently reads, with the comment that carries it. */
export interface PostedRound {
	readonly round: number;
	readonly comment: number;
	readonly questions: ReadonlyArray<Question>;
}

/** A comment that opens as a round and whose blocks do not parse — surfaced, never skipped. */
export interface BrokenRound {
	readonly round: number;
	readonly comment: number;
	readonly reason: string;
}

export interface RoundScan {
	readonly rounds: ReadonlyArray<PostedRound>;
	readonly broken: ReadonlyArray<BrokenRound>;
}

/** Every round on the session, in comment order. A malformed one is reported, not dropped. */
export const scanRounds = (comments: ReadonlyArray<CommentRecord>): RoundScan => {
	const rounds: PostedRound[] = [];
	const broken: BrokenRound[] = [];
	for (const comment of comments) {
		const read = readRoundComment(comment.body);
		if (read._tag === "NotARound") continue;
		if (read._tag === "Malformed") {
			broken.push({round: read.round, comment: comment.id, reason: read.reason});
			continue;
		}
		rounds.push({round: read.round, comment: comment.id, questions: read.questions});
	}
	return {rounds, broken};
};

/** The next round number: one past the highest round already posted. Zero rounds is a fact. */
export const nextRoundNumber = (scan: RoundScan): number =>
	Math.max(
		0,
		...scan.rounds.map((round) => round.round),
		...scan.broken.map((round) => round.round),
	) + 1;

/** `id → the question and the round holding it`, so a verb resolves an id without re-walking. */
export const questionIndex = (
	rounds: ReadonlyArray<PostedRound>,
): ReadonlyMap<string, {readonly question: Question; readonly round: PostedRound}> => {
	const index = new Map<string, {question: Question; round: PostedRound}>();
	for (const round of rounds) {
		for (const question of round.questions) index.set(question.id, {question, round});
	}
	return index;
};

/** Why a purported marker was not counted. A closed set, so a consumer can branch on it. */
export type DisregardedReason = "malformed" | "unauthorized" | "unbindable" | "unattested";

export interface Disregarded {
	readonly comment: number;
	readonly reason: DisregardedReason;
	readonly detail: string;
}

export interface CountedStamp {
	readonly comment: number;
	/** Where the comment sits in the session's comment order — how clause 4 finds its neighbour. */
	readonly index: number;
	readonly author: string;
	readonly stamp: Stamp;
}

export interface CountedSupersede {
	readonly comment: number;
	readonly author: string;
	readonly entries: grillSupersede.GrillSupersede;
}

export interface MarkerScan {
	readonly rulings: ReadonlyArray<CountedStamp>;
	readonly answers: ReadonlyArray<CountedStamp>;
	readonly supersedes: ReadonlyArray<CountedSupersede>;
	readonly disregarded: ReadonlyArray<Disregarded>;
	readonly authorsResolved: number;
}

export type MarkerScanResult =
	| {readonly _tag: "Scanned"; readonly scan: MarkerScan}
	/**
	 * A permission read that did not complete. Authority is never granted by a failed lookup, and
	 * `subject` names the marker left unjudged so the refusal says which question went UNKNOWN.
	 */
	| {
			readonly _tag: "Unknown";
			readonly login: string;
			readonly reason: string;
			readonly subject: string;
	  };

const REACHES: ReadonlyArray<readonly [string, "ruling" | "answer" | "supersede"]> = [
	[grillRuling.KEY, "ruling"],
	[grillAnswer.KEY, "answer"],
	[grillSupersede.KEY, "supersede"],
];

const markerKindOf = (body: string): "ruling" | "answer" | "supersede" | null => {
	const first =
		body
			.split("\n")
			.find((line) => line.trim() !== "")
			?.trim() ?? "";
	const bare = first.replace(/^\*{0,2}\s*/, "");
	return REACHES.find(([key]) => bare.startsWith(`${key}:`))?.[1] ?? null;
};

/**
 * Scan every comment for the three markers, resolving each distinct author once at the ACL.
 *
 * A malformed marker lands a `disregarded` row rather than reading as absent — that is the scar
 * this group is built against, where a real approval whose shape the guard could not see had to be
 * re-stamped months later. An unauthorized author lands one too: content is not authority, but an
 * ignored marker should still be visible.
 */
export const scanMarkers = (
	repo: string,
	comments: ReadonlyArray<CommentRecord>,
): Effect.Effect<MarkerScanResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const rulings: CountedStamp[] = [];
		const answers: CountedStamp[] = [];
		const supersedes: CountedSupersede[] = [];
		const disregarded: Disregarded[] = [];
		const permissions = new Map<string, string | null>();

		for (const [index, comment] of comments.entries()) {
			const kind = markerKindOf(comment.body);
			if (kind === null) continue;

			const read =
				kind === "ruling"
					? grillRuling.read(comment.body)
					: kind === "answer"
						? grillAnswer.read(comment.body)
						: grillSupersede.read(comment.body);
			if (read._tag === "Absent") continue;
			if (read._tag === "Malformed") {
				disregarded.push({comment: comment.id, reason: "malformed", detail: read.reason});
				continue;
			}

			const subject =
				kind === "supersede"
					? (read.value as grillSupersede.GrillSupersede).map((entry) => entry.question).join(", ")
					: (read.value as Stamp).question;

			let permission = permissions.get(comment.author);
			if (permission === undefined) {
				const resolved = yield* permissionFor(repo, comment.author);
				if (resolved._tag === "Unknown") {
					return {
						_tag: "Unknown" as const,
						login: comment.author,
						reason: resolved.reason,
						subject,
					};
				}
				permission = resolved._tag === "Present" ? resolved.value : null;
				permissions.set(comment.author, permission);
			}
			if (permission === null || !AUTHORIZED.has(permission)) {
				disregarded.push({
					comment: comment.id,
					reason: "unauthorized",
					detail: `${comment.author} resolves to ${permission ?? "no collaboration"} on ${repo}, below write`,
				});
				continue;
			}

			if (kind === "supersede") {
				supersedes.push({
					comment: comment.id,
					author: comment.author,
					entries: read.value as grillSupersede.GrillSupersede,
				});
				continue;
			}
			const counted: CountedStamp = {
				comment: comment.id,
				index,
				author: comment.author,
				stamp: read.value as Stamp,
			};
			if (kind === "ruling") rulings.push(counted);
			else answers.push(counted);
		}

		return {
			_tag: "Scanned" as const,
			scan: {rulings, answers, supersedes, disregarded, authorsResolved: permissions.size},
		};
	});

/** `question id → the round that retired it`. The only source of a supersession; prose is never one. */
export const retirements = (scan: MarkerScan): ReadonlyMap<QuestionId, number> => {
	const retired = new Map<QuestionId, number>();
	for (const marker of scan.supersedes) {
		for (const entry of marker.entries) {
			const seen = retired.get(entry.question);
			if (seen === undefined || entry.round < seen) retired.set(entry.question, entry.round);
		}
	}
	return retired;
};

/** An ISO-8601 date, which is what makes a quoted authorization datable (#4938). */
export const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
