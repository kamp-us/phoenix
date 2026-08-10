/**
 * `review verdicts` — every verdict marker on the PR, per namespace, each with its
 * `Current` / `Stale` / `Unbindable` binding against the live head.
 *
 * This is `bindToHead`'s first consumer surface. That module's `Binding` type has three arms and no
 * non-test caller today; the three reach stdout here as **three tokens**, because folding any two of
 * them together is how a stale PASS reads as a current one (ADR 0058, #3769 / #4338).
 *
 * A head this verb cannot resolve prints `unbindable` on **every** row — never `current`, never
 * `stale`. A comparison that could not be made is not a negative result, so the live-head read's
 * failure is that answer rather than an exit: the markers themselves were seen and are reportable
 * facts.
 *
 * A marker that reaches for the format and fails it prints as a `malformed` row with the wire reason
 * on stderr. It is never dropped from the sweep — a dropped row is how a FAIL'd PR reads as
 * unreviewed (#4103 / #4105, #4520).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	bindToHead,
	type HeadSha,
	read as readMarker,
	clause as toClause,
	type VerdictMarker,
} from "../wire/verdict-marker.ts";
import {readAdvisory} from "./advisory.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {NULL_TOKEN} from "./scope-verb.ts";
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
}

interface MalformedRow {
	readonly commentId: number;
	readonly reason: string;
}

/**
 * The binding token for one marker against a head this run may not have been able to resolve.
 *
 * The three arms map to three tokens and nothing folds: an unresolved head is `unbindable` before
 * `bindToHead` is even asked, because the comparison could not be made.
 */
const bindingOf = (marker: VerdictMarker, head: string | null): MarkerRow["binding"] => {
	if (head === null) return "unbindable";
	const binding = bindToHead(marker, head);
	return binding._tag === "Current" ? "current" : binding._tag === "Stale" ? "stale" : "unbindable";
};

/** An advisory carrier binds by its body SHA, so it is bound through a marker built from that SHA. */
const advisoryMarker = (namespace: string, sha: HeadSha): VerdictMarker => ({
	namespace,
	polarity: "PASS",
	sha,
	clause: toClause("advisory") ?? ("advisory" as VerdictMarker["clause"]),
});

const sweep = (
	comments: ReadonlyArray<CommentRecord>,
	head: string | null,
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
				binding: bindingOf(parsed.value, head),
				commentId: comment.id,
			});
			continue;
		}
		const advisory = readAdvisory(comment.body);
		if (advisory !== null) {
			markers.push({
				namespace: advisory.namespace,
				polarity: "ADVISORY",
				sha: advisory.sha,
				binding: bindingOf(advisoryMarker(advisory.namespace, advisory.sha), head),
				commentId: comment.id,
			});
			continue;
		}
		if (parsed._tag === "Malformed") {
			malformed.push({commentId: comment.id, reason: parsed.reason});
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

		const {markers, malformed} = sweep(comments, head);
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
						`${row.namespace}\t${row.polarity}\t${row.sha}\t${row.binding}\t${row.commentId}`,
				),
				...malformed.map(
					(row) => `malformed\t${NULL_TOKEN}\t${NULL_TOKEN}\t${NULL_TOKEN}\t${row.commentId}`,
				),
			].join("\n"),
			diagnostics,
		);
	});
