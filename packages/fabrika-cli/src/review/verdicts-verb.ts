/**
 * `review verdicts` — every verdict marker on the PR, per namespace, each with its
 * `Current` / `Stale` / `Unbindable` binding against the live head.
 *
 * The `Binding` type has three arms; the three reach stdout here as **three tokens**, because folding
 * any two of them together is how a stale PASS reads as a current one (ADR 0058, #3769 / #4338).
 *
 * **It resolves the same binding `ship gate` does, and that is the point of the coupling.** This verb
 * is what routes an agent to re-review, so a row reading `stale` where the merge gate would read
 * `pass` re-imposes the very tax ADR 0276 removed — through a second opinion nobody would think to
 * suspect. Both call `bindToContent`, so they cannot disagree.
 *
 * A head this verb cannot resolve prints `unbindable` on **every** row — never `current`, never
 * `stale`. A comparison that could not be made is not a negative result, so the live-head read's
 * failure is that answer rather than an exit: the markers themselves were seen and are reportable
 * facts.
 *
 * A marker that reaches for the format and fails it prints as a `malformed` row with the wire reason
 * on stderr. It is never dropped from the sweep — a dropped row is how a FAIL'd PR reads as
 * unreviewed (#4103 / #4105, #4520).
 *
 * **A superseded verdict gets its own row too, marked `superseded` in the sixth field.** `review
 * post` retires the prior verdict below `./supersede.ts`'s fence instead of over it, so those bytes
 * are still on the PR; printing only the surviving one would report exactly the erasure the append
 * exists to prevent (#7247). The sixth field is what tells the two apart — `standing` is the verdict
 * in force, and it is the only kind `ship gate` reads.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	bindToContent,
	type HeadSha,
	headSha,
	read as readMarker,
	sameHead,
	clause as toClause,
	type VerdictMarker,
} from "../wire/verdict-marker.ts";
import {readAdvisory} from "./advisory.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {contentDigestAt} from "./content-binding.ts";
import {bindHead} from "./head.ts";
import {NULL_TOKEN} from "./scope-verb.ts";
import {archived as archivedVerdicts} from "./supersede.ts";
import {badNumber, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review verdicts";

export interface VerdictsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface MarkerRow {
	readonly namespace: string;
	readonly polarity: string;
	readonly sha: string;
	readonly binding: "current" | "stale" | "unbindable";
	readonly commentId: number;
	/** `false` for a verdict retired below its comment's supersede fence — see the sweep. */
	readonly standing: boolean;
}

interface MalformedRow {
	readonly commentId: number;
	readonly reason: string;
}

/**
 * The binding token for one marker against a head this run may not have been able to resolve.
 *
 * The three arms map to three tokens and nothing folds: an unresolved head is `unbindable` before
 * `bindToContent` is even asked, because the comparison could not be made.
 */
const bindingOf = (
	marker: VerdictMarker,
	head: string | null,
	digest: string | null,
): MarkerRow["binding"] => {
	if (head === null) return "unbindable";
	const binding = bindToContent(marker, head, digest);
	return binding._tag === "Current" ? "current" : binding._tag === "Stale" ? "stale" : "unbindable";
};

/** An advisory carrier binds by its body SHA, so it is bound through a marker built from that SHA. */
const advisoryMarker = (namespace: string, sha: HeadSha): VerdictMarker => ({
	namespace,
	polarity: "PASS",
	sha,
	content: null,
	clause: toClause("advisory") ?? ("advisory" as VerdictMarker["clause"]),
});

const sweep = (
	comments: ReadonlyArray<CommentRecord>,
	head: string | null,
	digest: string | null,
): {markers: MarkerRow[]; malformed: MalformedRow[]} => {
	const markers: MarkerRow[] = [];
	const malformed: MalformedRow[] = [];
	// Newest first: the sweep's own order, so a caller reading top-down sees the latest round first.
	for (const comment of [...comments].reverse()) {
		const parsed = readMarker(comment.body);
		if (parsed._tag === "Found") {
			markers.push({
				namespace: parsed.value.namespace,
				polarity: parsed.value.polarity,
				sha: parsed.value.sha,
				binding: bindingOf(parsed.value, head, digest),
				commentId: comment.id,
				standing: true,
			});
		} else {
			const advisory = readAdvisory(comment.body);
			if (advisory !== null) {
				markers.push({
					namespace: advisory.namespace,
					polarity: "ADVISORY",
					sha: advisory.sha,
					binding: bindingOf(advisoryMarker(advisory.namespace, advisory.sha), head, digest),
					commentId: comment.id,
					standing: true,
				});
			} else if (parsed._tag === "Malformed") {
				malformed.push({commentId: comment.id, reason: parsed.reason});
			}
		}
		// A superseded verdict is a row of its own, never a row dropped: `review post` retires the
		// prior verdict below the fence rather than over it, and a sweep that printed only the
		// surviving one would report exactly the erasure the append exists to prevent (#7247).
		for (const retired of archivedVerdicts(comment.body)) {
			const older = readMarker(retired);
			if (older._tag !== "Found") continue;
			markers.push({
				namespace: older.value.namespace,
				polarity: older.value.polarity,
				sha: older.value.sha,
				binding: bindingOf(older.value, head, digest),
				commentId: comment.id,
				standing: false,
			});
		}
	}
	return {markers, malformed};
};

export const runVerdicts = (
	options: VerdictsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: PR #${pr} not found in ${repo}.`);
		}
		const head = found._tag === "Present" ? found.value.headSha : null;
		const declared = found._tag === "Present" ? found.value.comments : null;
		const diagnostics: string[] =
			head === null
				? [
						`${VERB}: the live head could not be resolved (${
							found._tag === "Unknown" ? found.reason : "unreadable"
						}) — every row prints unbindable, never current and never stale.`,
					]
				: [];

		// The PR may be readable as an issue even when the pulls read failed, so the comment sweep is
		// attempted regardless: its own failure is the `11`, and the head's is the unbindable answer.
		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s comments: ${listed.reason} — whether verdicts exist is UNKNOWN, never zero.`,
				diagnostics,
			);
		}
		const comments = listed.value;
		diagnostics.push(
			scannedLine(
				VERB,
				comments.length,
				"comment",
				declared === null ? "no declared count" : `${declared} declared`,
			),
		);
		if (declared !== null && comments.length < declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${comments.length} of ${declared} comments — refusing the partial sweep.`,
				diagnostics,
			);
		}

		// Lazy, exactly as at `ship gate`: the digest is read only when a content-bound marker has
		// already failed the head test, and a read that cannot answer leaves it null — which
		// `bindToContent` reports as `unbindable`, never as a row a caller could act on as current.
		const contested =
			head !== null && found._tag === "Present"
				? comments.some((comment) => {
						const parsed = readMarker(comment.body);
						return (
							parsed._tag === "Found" &&
							parsed.value.content !== null &&
							!sameHead(parsed.value.sha, headSha(head) ?? parsed.value.sha)
						);
					})
				: false;
		let digest: string | null = null;
		if (contested && found._tag === "Present") {
			const bound = yield* bindHead(VERB, repo, pr, found.value, null);
			const read =
				bound._tag === "Bound"
					? yield* contentDigestAt(bound.head.mergeBase, bound.head.sha)
					: null;
			if (read !== null && read._tag === "Ok") digest = read.value;
			else {
				diagnostics.push(
					`${VERB}: a marker binds content at another head, but this head's digest could not be read — those rows print unbindable (ADR 0276).`,
				);
			}
		}

		const {markers, malformed} = sweep(comments, head, digest);
		for (const row of malformed) {
			diagnostics.push(
				`${VERB}: comment ${row.commentId} reaches for a marker and fails the format: ${row.reason}.`,
			);
		}

		if (json) {
			return answer(
				JSON.stringify({
					outcome: "verdicts",
					head,
					markers,
					malformed,
					scanned: comments.length,
				}),
				diagnostics,
			);
		}
		return answer(
			[
				`verdicts\t${head ?? NULL_TOKEN}\t${markers.length + malformed.length}`,
				...markers.map(
					(row) =>
						`${row.namespace}\t${row.polarity}\t${row.sha}\t${row.binding}\t${row.commentId}\t${
							row.standing ? "standing" : "superseded"
						}`,
				),
				...malformed.map(
					(row) =>
						`malformed\t${NULL_TOKEN}\t${NULL_TOKEN}\t${NULL_TOKEN}\t${row.commentId}\t${NULL_TOKEN}`,
				),
			].join("\n"),
			diagnostics,
		);
	});
