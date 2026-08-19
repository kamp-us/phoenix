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
 * **Staleness is the content question, not the head question (ADR 0276).** A verdict whose head has
 * moved survives only while the content it bound is still this head's. `inForce`'s ordering is
 * deliberately *not* widened to match: a content-current verdict at a moved head still loses the
 * head-bound tiebreak, so the widening can only ever let a FAIL win an ordering a PASS used to win —
 * never the reverse.
 *
 * The one caller-asserted input is `--cp`, and it reaches **every** resolution in one run — v1
 * passed it to the gate and not the native fold, and a discharged FAIL stayed in force forever
 * (#4049). The fold living inside this verb is what makes that seam unrepresentable.
 *
 * `governance` is the one namespace the caller cannot decline: see {@link requiredWithFloor}.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {governedRootsOr} from "../config/paths.ts";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {listPullFiles, permissionFor} from "../io/pulls.ts";
import {readAdvisory} from "../review/advisory.ts";
import {SHIP_NAMESPACES, touchesGovernanceRoot} from "../review/classes.ts";
import {contentDigestAt} from "../review/content-binding.ts";
import {bindHead} from "../review/head.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {bindToContent, read as readMarker} from "../wire/verdict-marker.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
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
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** One authorized comment's verdict claim, before any ordering is applied. */
interface Candidate {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL";
	readonly sha: string;
	/** The content the claim binds, or `null` for a carrier that emits none (ADR 0276). */
	readonly content: string | null;
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
			content: marker.value.content,
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
				// The §CP advisory withholds a content binding by design: the human-approval half of the
				// binding question is #3769's, and ADR 0276 carries its answer from there rather than
				// deciding it here. So an advisory stays head-bound, exactly as before.
				content: null,
				carrier: "advisory",
				stamp: comment.updatedAt,
				commentId: comment.id,
			};
};

/**
 * The set this verb gates on: the caller's namespaces, plus the floor the diff itself derives.
 *
 * `--require` was caller-asserted end to end — `ship scope` printed `governance` on a
 * governance-root diff and the gate then believed whatever the session typed, so leaving the flag
 * off turned the requirement off and a fabrika-tree PR shipped with no governance verdict at all
 * (#5036). A namespace the diff derives is not the caller's to drop, so it is added here whether or
 * not it was passed: the omission stops being discouraged and becomes unrepresentable.
 *
 * The floor is `governance` only. Deriving the `review-*` set here too would be a second answer to
 * what `ship scope` already prints, and widening it is its own decision — the caller's assertion
 * stands for those, unchanged.
 */
export const requiredWithFloor = (
	requested: ReadonlyArray<string>,
	files: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
): {readonly required: ReadonlyArray<string>; readonly floored: ReadonlyArray<string>} => {
	const distinct = new Set(requested);
	const floored =
		touchesGovernanceRoot(files, roots) && !distinct.has("governance") ? ["governance"] : [];
	return {required: [...distinct, ...floored], floored};
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
				// GitHub re-binds its own review objects; that layer is untouched (ADR 0276).
				content: null,
				carrier: "review-fold",
				stamp: latest.submittedAt,
				commentId: 0,
			};
};

export const runGate = (
	options: GateOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json, cp} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			"the floor cannot be raised and the conjunction is UNKNOWN, never satisfied.",
		);
		if (governed._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, governed.message);

		const requested = [...new Set(options.require)];
		if (requested.length === 0) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --require is mandatory — a merge gated on zero namespaces is vacuously green (#2765).`,
			);
		}
		const offVocabulary = requested.find((name) => !SHIP_NAMESPACES.includes(name));
		if (offVocabulary !== undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --require ${offVocabulary} is not a gateable namespace (known: ${SHIP_NAMESPACES.join(", ")}).`,
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

		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the changed-file list", listed.reason));
		}
		const diagnostics = [
			scannedLine(VERB, listed.value.length, "changed file", `${pull.changedFiles} declared`),
		];
		if (listed.value.length < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${listed.value.length} of ${pull.changedFiles} changed files — refusing to derive the required floor from a truncated read.`,
				diagnostics,
			);
		}
		if (listed.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} has zero changed files — a conjunction over an empty diff proves nothing (ADR 0092).`,
				diagnostics,
			);
		}
		const {required, floored} = requiredWithFloor(requested, listed.value, governed.roots);
		if (floored.length > 0) {
			diagnostics.push(
				`${VERB}: #${pr}'s diff touches a governance root, so governance is required whether or not it was passed — the diff's floor, not the caller's option (#5036).`,
			);
		}

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				unreadable("the comments", commented.reason),
				diagnostics,
			);
		}
		diagnostics.push(
			scannedLine(VERB, commented.value.length, "comment", `${pull.comments} declared`),
		);
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
		const winners = required.map((name) => {
			const own = candidates.filter((claim) => claim.namespace === name);
			const pool = name === "review-code" && fold !== null ? [...own, fold] : own;
			return {name, winner: inForce(pool, bound)};
		});

		// The head digest is read ONLY when a content-bound claim has already failed the head test,
		// which is the whole cost story: the common path — every claim at this head — never touches
		// git. It also makes the read non-regressive. A checkout that cannot answer leaves
		// `headDigest` null, `bindToContent` says `Unbindable`, and the namespace resolves `stale` —
		// the same block this verb gave before ADR 0276, so a git failure can only ever refuse.
		const contested = winners.some(
			({winner}) => winner !== null && !prefixMatch(winner.sha, bound) && winner.content !== null,
		);
		let headDigest: string | null = null;
		if (contested) {
			const head = yield* bindHead(VERB, repo, pr, pull, options.sha);
			const digest =
				head._tag === "Bound" ? yield* contentDigestAt(head.head.mergeBase, head.head.sha) : null;
			if (digest !== null && digest._tag === "Ok") headDigest = digest.value;
			else {
				diagnostics.push(
					`${VERB}: a verdict at another head binds content, but this head's digest could not be read — every such namespace resolves stale (ADR 0276).`,
				);
			}
		}

		const verdicts: NamespaceVerdict[] = winners.map(({name, winner}) => {
			if (winner === null) return {name, state: "absent", carrier: "-", commentId: null};
			const commentId = winner.carrier === "review-fold" ? null : winner.commentId;
			const binding = bindToContent(winner, bound, headDigest);
			if (binding._tag !== "Current") {
				if (binding._tag === "Unbindable") {
					diagnostics.push(`${VERB}: ${name}: ${binding.reason} — resolved stale.`);
				}
				return {name, state: "stale", carrier: winner.carrier, commentId};
			}
			if (binding.via === "content") {
				diagnostics.push(
					`${VERB}: ${name}: the verdict at ${winner.sha} binds content ${winner.content}, which is this head's — the head moved, the reviewed content did not (ADR 0276).`,
				);
			}
			return {
				name,
				state: winner.polarity === "PASS" ? "pass" : "fail",
				carrier: winner.carrier,
				commentId,
			};
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
