/**
 * `ship gate` — the verdict conjunction over every required namespace, at one head.
 *
 * Two collapses are designed out at two layers. `--require` **accumulates**: a single-valued parse
 * that keeps the first and drops the rest is #4520, where the gate said enqueueable past a live
 * FAIL. And the affirmative answer carries its own proof — the namespace lines are asserted to cover
 * exactly the distinct required set *before* `satisfied` is printed, because a plausible answer with
 * silently narrowed coverage is that defect's signature.
 *
 * In-force resolution is one derivation, not three tests to keep in sync: head-bound first (a
 * live-head verdict strictly outranks recency, #4189), then by the body's **write stamp** rather
 * than `created_at` (#4200 — a FAIL upserted after a PASS must win), with authorization applied as
 * the ADR 0055 write+ ACL. `absent` and `stale` stay distinct tokens because their remedies differ,
 * and both block: absence-is-refusal is the #3944 law.
 *
 * The one caller-asserted input is `--cp`, and it reaches **every** resolution in one run — v1
 * passed it to the gate and not the native fold, and a discharged FAIL stayed in force forever
 * (#4049). The fold living inside this verb is what makes that seam unrepresentable.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import {readAdvisory} from "../review/advisory.ts";
import {SHIP_NAMESPACES} from "../review/classes.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {listReviews, type ReviewRecord} from "./github.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship gate";

/** The permission levels ADR 0055 counts as an authorized verdict author. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

export type NamespaceState = "pass" | "fail" | "absent" | "stale";
export type Carrier = "marker" | "advisory" | "review-fold" | "-";

export interface NamespaceVerdict {
	readonly name: string;
	readonly state: NamespaceState;
	readonly carrier: Carrier;
	readonly commentId: number | null;
}

export interface GateOptions {
	readonly pr: number;
	readonly sha: string;
	readonly require: ReadonlyArray<string>;
	readonly cp: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** One authorized comment's verdict claim, before any ordering is applied. */
interface Candidate {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL";
	readonly sha: string;
	readonly carrier: Carrier;
	readonly stamp: string;
	readonly commentId: number;
}

const candidateOf = (comment: CommentRecord, cp: boolean): Candidate | null => {
	const marker = readMarker(comment.body);
	if (marker._tag === "Found") {
		return {
			namespace: marker.value.namespace,
			polarity: marker.value.polarity,
			sha: marker.value.sha,
			carrier: "marker",
			stamp: comment.updatedAt,
			commentId: comment.id,
		};
	}
	if (!cp) return null;
	const advisory = readAdvisory(comment.body);
	return advisory === null
		? null
		: {
				namespace: advisory.namespace,
				// ADR 0226 makes the advisory carrier PASS-only. A `[FAIL]` row inside one is an invalid
				// emission, caught below and reported — never read as a pass.
				polarity: /\[FAIL\]/.test(comment.body) ? "FAIL" : "PASS",
				sha: advisory.sha,
				carrier: "advisory",
				stamp: comment.updatedAt,
				commentId: comment.id,
			};
};

/**
 * The in-force verdict for one namespace: head-bound candidates first, then newest write stamp.
 *
 * Exported so the ordering is testable without a PR: the two rules interact, and "head-bound
 * outranks recency" is only checkable against a stale-but-newer counterexample.
 */
export const inForce = (candidates: ReadonlyArray<Candidate>, sha: string): Candidate | null => {
	const ordered = [...candidates].sort((a, b) => {
		const aBound = prefixMatch(a.sha, sha) ? 1 : 0;
		const bBound = prefixMatch(b.sha, sha) ? 1 : 0;
		if (aBound !== bBound) return bBound - aBound;
		return a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0;
	});
	return ordered[0] ?? null;
};

/** A decisive native review at this head, folded newest-wins — never FAIL-precedence, which wedges. */
const foldedReview = (reviews: ReadonlyArray<ReviewRecord>, sha: string): Candidate | null => {
	const decisive = reviews
		.filter(
			(review) =>
				(review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") &&
				prefixMatch(review.commitId, sha),
		)
		.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
	const latest = decisive[0];
	return latest === undefined
		? null
		: {
				namespace: "review-code",
				polarity: latest.state === "APPROVED" ? "PASS" : "FAIL",
				sha: latest.commitId,
				carrier: "review-fold",
				stamp: latest.submittedAt,
				commentId: 0,
			};
};

export const runGate = (
	options: GateOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json, cp} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const required = [...new Set(options.require)];
		if (required.length === 0) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --require is mandatory — a merge gated on zero namespaces is vacuously green (#2765).`,
			);
		}
		const offVocabulary = required.find((name) => !SHIP_NAMESPACES.includes(name));
		if (offVocabulary !== undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --require ${offVocabulary} is not a review namespace (known: ${SHIP_NAMESPACES.join(", ")}).`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what} for #${pr}: ${reason} — the conjunction is UNKNOWN.`;

		const target = yield* resolvePull(VERB, repo, pr, {
			closedReason: "nothing to gate.",
			unknownMessage: (reason) => unreadable("the pull request", reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the comments", commented.reason));
		}
		const diagnostics = [
			scannedLine(VERB, commented.value.length, "comment", `${pull.comments} declared`),
		];
		if (commented.value.length < pull.comments) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${commented.value.length} of ${pull.comments} comments — refusing the partial resolution.`,
				diagnostics,
			);
		}

		const reviewed = yield* listReviews(repo, pr);
		if (reviewed._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the reviews", reviewed.reason), diagnostics);
		}
		diagnostics.push(
			scannedLine(
				VERB,
				reviewed.value.reviews.length,
				"review",
				reviewed.value.exhausted ? "pagination exhausted" : "pagination NOT exhausted",
			),
		);
		if (!reviewed.value.exhausted) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the review read never reached a terminal page — pagination is unexhausted, so the native-review fold would rest on a truncated set; refusing the partial resolution.`,
				diagnostics,
			);
		}

		// The ACL is resolved once per distinct author, and a lookup FAILURE is fail-closed: the
		// namespace is UNKNOWN, never `absent` (ADR 0055).
		const authorized = new Map<string, boolean>();
		const candidates: Candidate[] = [];
		for (const comment of commented.value) {
			const claim = candidateOf(comment, cp);
			if (claim === null) continue;
			if (!authorized.has(comment.author)) {
				const permission = yield* permissionFor(repo, comment.author);
				if (permission._tag === "Unknown") {
					return refuse(
						PRECONDITION_UNKNOWN,
						unreadable(`the ACL for ${comment.author}`, permission.reason),
						diagnostics,
					);
				}
				authorized.set(
					comment.author,
					permission._tag === "Present" && AUTHORIZED.has(permission.value),
				);
			}
			if (authorized.get(comment.author) !== true) continue;
			if (claim.carrier === "advisory" && claim.polarity === "FAIL") {
				diagnostics.push(
					`${VERB}: #${pr} carries a §CP advisory with a [FAIL] row — an invalid emission (ADR 0226); treated as fail, report it.`,
				);
			}
			candidates.push(claim);
		}

		const fold = foldedReview(reviewed.value.reviews, bound);
		const verdicts: NamespaceVerdict[] = required.map((name) => {
			const own = candidates.filter((claim) => claim.namespace === name);
			const pool = name === "review-code" && fold !== null ? [...own, fold] : own;
			const winner = inForce(pool, bound);
			if (winner === null) return {name, state: "absent", carrier: "-", commentId: null};
			const commentId = winner.carrier === "review-fold" ? null : winner.commentId;
			return prefixMatch(winner.sha, bound)
				? {
						name,
						state: winner.polarity === "PASS" ? "pass" : "fail",
						carrier: winner.carrier,
						commentId,
					}
				: {name, state: "stale", carrier: winner.carrier, commentId};
		});

		// The coverage assertion runs BEFORE the answer is believed, not after it is printed.
		const covered = new Set(verdicts.map((verdict) => verdict.name));
		if (covered.size !== required.length) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: resolved ${covered.size} of ${required.length} required namespaces — refusing to answer over narrowed coverage (#4520).`,
				diagnostics,
			);
		}

		const outcome = verdicts.every((verdict) => verdict.state === "pass") ? "satisfied" : "blocked";
		return json
			? answer(
					JSON.stringify({outcome, sha: bound, namespaces: verdicts, required: required.length}),
					diagnostics,
				)
			: answer(
					[
						`gate\t${outcome}\t${bound}`,
						...verdicts.map(
							(verdict) =>
								`ns\t${verdict.name}\t${verdict.state}\t${verdict.state === "absent" ? NULL_TOKEN : verdict.carrier}`,
						),
					].join("\n"),
					diagnostics,
				);
	});
