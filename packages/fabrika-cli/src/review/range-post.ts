/**
 * The range-scoped write path `review post --base/--tip` and `governance post --base/--tip` share —
 * one composer for the marker `lane prove`'s epic-child arm reads (#5935, ruling on #5901).
 *
 * A child's verdict lands on the **child issue**, not a PR: the epic run opens one tail PR
 * (ADR 0285), so mid-run there is no PR surface to bind a head-scoped marker to, and the two SHAs
 * the range names stop being history the moment the range merges into the epic branch. What binds
 * is the content digest (ADR 0276), which is why this path composes through
 * `../wire/range-verdict-marker.ts` — the exact reader `proveRangeVerdicts` folds — and never the
 * head-bound format.
 *
 * One module rather than a per-verb copy because the two verbs differ in exactly one decision —
 * which namespace the range's own paths admit — and that decision arrives as {@link RangeGate.admit},
 * each verb's fail-closed rule intact: `review post` refuses a namespace the range did not derive,
 * `governance post` refuses a range touching no governance root. Everything else — target proof,
 * digest, leak scan, upsert, read-back — is the same six-step contract as the PR-scoped path, asked
 * of an issue and a range instead of a PR and a head.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {CommitRange} from "../io/git.ts";
import {createComment, getComment, getIssue, listComments} from "../io/issues.ts";
import {patchComment, viewerLogin} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {NonEmptyReadonlyArray} from "../wire/format.ts";
import {
	type Clause,
	contentDigest,
	type HeadSha,
	type Polarity,
	sameHead,
} from "../wire/marker-line.ts";
import {
	emit as emitMarker,
	type RangeVerdictMarker,
	read as readMarker,
	renderRange,
} from "../wire/range-verdict-marker.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {rangeContentAt} from "./content-binding.ts";
import {latestByWriteRecency} from "./write-recency.ts";

/** The one decision a verb keeps, plus its own leak scan — the codes behind both are shared values. */
export interface RangeGate {
	readonly verb: string;
	/** `null` when the range's changed paths admit this verb's namespace; the verb's refusal else. */
	readonly admit: (
		paths: NonEmptyReadonlyArray<string>,
		diagnostics: ReadonlyArray<string>,
	) => VerbOutcome | null;
	/** The verb's own `leakRefusal` over the assembled comment, so the `5`/`6` text stays its own. */
	readonly leak: (composed: string) => VerbOutcome | null;
}

export interface RangePost {
	/** The child issue the verdict lands on — verdicts live on GitHub (ADR 0283). */
	readonly issue: number;
	readonly namespace: string;
	readonly polarity: Polarity;
	readonly range: CommitRange<HeadSha>;
	readonly clause: Clause;
	/** The authored body, already read and refused by the verb's own stdin guard. */
	readonly body: string;
	readonly repo: string;
	readonly json: boolean;
}

/**
 * Whether a comment carries this namespace's range marker **over this range** — the upsert key.
 *
 * The range dimension plays the head dimension's role from the PR path: a re-post at the same range
 * corrects in place, a verdict over a moved tip is a different fact and appends. Prefix-matched
 * through {@link sameHead} on both ends, so an abbreviated and a full spelling of the same revision
 * key the same slot.
 */
const carriesNamespaceOver = (
	body: string,
	namespace: string,
	range: CommitRange<HeadSha>,
): boolean => {
	const parsed = readMarker(body);
	return (
		parsed._tag === "Found" &&
		parsed.value.namespace === namespace &&
		sameHead(parsed.value.range.base, range.base) &&
		sameHead(parsed.value.range.tip, range.tip)
	);
};

/** Why the read-back does not show what was posted, or `null` when it does — see `./post-verb.ts`. */
const mismatchOf = (body: string, posted: RangeVerdictMarker, composed: string): string | null => {
	const normalized = normalizeForReadback(body);
	const parsed = readMarker(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const marker = parsed.value;
	if (marker.namespace !== posted.namespace) {
		return `namespace ${marker.namespace}, expected ${posted.namespace}`;
	}
	if (marker.polarity !== posted.polarity) {
		return `polarity ${marker.polarity}, expected ${posted.polarity}`;
	}
	if (marker.range.base !== posted.range.base || marker.range.tip !== posted.range.tip) {
		return `range ${renderRange(marker.range)}, expected ${renderRange(posted.range)}`;
	}
	if (marker.content !== posted.content) {
		return `content ${marker.content}, expected ${posted.content}`;
	}
	if (marker.clause !== posted.clause) {
		return `clause "${marker.clause}", expected "${posted.clause}"`;
	}
	return normalized === normalizeForReadback(composed)
		? null
		: "the comment's bytes are not the ones that were sent";
};

export const runRangePost = (
	gate: RangeGate,
	post: RangePost,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {verb} = gate;
		const {issue, repo, json} = post;
		const range = renderRange(post.range);
		const unreadable = (what: string, reason: string): VerbOutcome =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read ${what} for #${issue}: ${reason} — nothing was posted.`,
			);

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Unknown") return unreadable("the issue", target.reason);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${verb}: #${issue} is proven absent in ${repo}.`);
		}
		if (target.value.isPullRequest) {
			return refuse(
				ZERO_SCOPE,
				`${verb}: #${issue} is a pull request — a range-scoped verdict lands on the child issue; a PR's verdict is head-bound, so drop --base/--tip and pass --sha.`,
			);
		}
		if (target.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`${verb}: #${issue} is ${target.value.state} — a verdict on a closed issue gates nothing.`,
			);
		}

		// The digest is taken over the same `<base>...<tip>` the marker names, in this checkout's
		// object database — a range whose ends this tree cannot resolve is UNKNOWN, never a marker.
		const content = yield* rangeContentAt(post.range);
		if (content._tag === "Failure") {
			return unreadable(`the content ${range} changes`, content.reason);
		}
		const digest = contentDigest(content.value.digest);
		if (digest === null) {
			return unreadable(
				`the content ${range} changes`,
				`"${content.value.digest}" is not a digest`,
			);
		}
		const diagnostics = [
			`${verb}: ${range} changes ${content.value.paths.length} path(s) at content ${content.value.digest} — the digest this verdict survives on (ADR 0276).`,
		];
		const refused = gate.admit(content.value.paths, diagnostics);
		if (refused !== null) return refused;

		// Composed through the wire format, never by hand (#3173) — the same module the prove arm reads.
		const marker: RangeVerdictMarker = {
			namespace: post.namespace,
			polarity: post.polarity,
			range: post.range,
			content: digest,
			clause: post.clause,
		};
		const composed = `${emitMarker(marker)}\n${post.body}`;

		const leaked = gate.leak(composed);
		if (leaked !== null) return leaked;

		const me = yield* viewerLogin;
		if (me._tag === "Failure") return unreadable("the authenticated user", me.reason);
		const comments = yield* listComments(repo, issue);
		if (comments._tag === "Failure") return unreadable("the comments", comments.reason);
		const mine = latestByWriteRecency(
			comments.value.filter(
				(comment) =>
					comment.author === me.value &&
					carriesNamespaceOver(comment.body, post.namespace, post.range),
			),
		);

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (mine === undefined) {
			const created = yield* createComment(repo, issue, composed);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, mine.id, composed);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: mine.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${verb}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the verdict landed; re-read #${issue}'s comments before retrying.`,
				diagnostics,
			);
		}
		const upsert = mine === undefined ? "created" : "edited";

		// Read back from live state — the write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		const mismatch =
			back._tag === "Failure" ? back.reason : mismatchOf(back.value, marker, composed);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${verb}: posted, but the read-back does not yield this marker (${mismatch}) — #${issue} may carry a garbled verdict; inspect comment ${landed.id}.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						outcome: "posted",
						namespace: post.namespace,
						polarity: post.polarity,
						range: {base: post.range.base, tip: post.range.tip},
						content: content.value.digest,
						upsert,
						commentUrl: landed.url,
					}),
					diagnostics,
				)
			: answer(
					`posted\t${post.namespace}\t${post.polarity}\t${range}\t${content.value.digest}\t${upsert}\t${landed.url}`,
					diagnostics,
				);
	});
