/**
 * `triage park` — demote an issue to `status:needs-info` with the questions that would unblock it.
 *
 * A separate verb rather than `apply --status needs-info`, because a parked issue carries no type, no
 * priority, no audience and no home; folding it into `apply` would make four required flags
 * conditionally required, which is the shape that let v1 emit a fully-triaged-looking issue with a
 * facet missing.
 *
 * **The comment is written first, by design.** An issue must never sit on `status:needs-info` with no
 * statement of what would unblock it, so a comment failure leaves nothing labelled at all — which is
 * also why the two exit-`8` messages differ: only the second can leave a partial label state.
 *
 * The demotion itself runs through the reconcile in `./facets.ts`, shared with `triage apply`.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getIssue, listLabels, resolveRepo} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {NEEDS_INFO, NEEDS_TRIAGE} from "../labels.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {applyChanges} from "./facet-writes.ts";
import {parkedFacets, planReconcile, renderShape, shapeViolations} from "./facets.ts";
import {scannedLine} from "./scope.ts";

const SURFACE: AuthoredSurface = {
	verb: "triage park",
	noun: "the questions text",
	emptyHint: "a parked issue must say what would unblock it: pipe the questions in.",
};

export interface ParkOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

const unreadable = (what: string, repo: string, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`triage park: cannot read ${what} in ${repo}: ${reason} — nothing was written; the park is UNKNOWN.`,
	);

export const runPark = (
	options: ParkOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `triage park: ${issue} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"triage park: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const questions = authored.text;

		// The questions are posted verbatim, so scanning them here is scanning the composed body.
		const leaked = leakRefusal(SURFACE, questions);
		if (leaked !== null) return leaked;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `triage park: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") return unreadable(`issue #${issue}`, repo, target.reason);

		const vocabulary = yield* listLabels(repo);
		if (vocabulary._tag === "Failure") return unreadable("the label set", repo, vocabulary.reason);
		const diagnostics = [scannedLine("triage park", repo, vocabulary.value.length, "label")];
		if (!vocabulary.value.includes(NEEDS_INFO)) {
			return refuse(
				ZERO_SCOPE,
				`triage park: label ${NEEDS_INFO} does not exist in ${repo} — refusing to write, because the API would create it (#4285).`,
				diagnostics,
			);
		}

		const posted = yield* createComment(repo, issue, questions);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`triage park: the questions comment on #${issue} failed: ${posted.reason} — nothing was labelled and #${issue} is unchanged. Re-run.`,
				diagnostics,
			);
		}

		const facets = parkedFacets();
		const plan = planReconcile(
			{labels: target.value.labels, milestone: target.value.milestone},
			facets,
			null,
		);
		const written = yield* applyChanges(repo, issue, plan.changes);
		if (written._tag === "Failed") {
			return refuse(
				WRITE_UNKNOWN,
				`triage park: the questions landed but the label swap failed: ${written.reason} — #${issue} carries the questions and may be partially labelled; re-run this verb, which is idempotent.`,
				diagnostics,
			);
		}

		const expected = `expected ${NEEDS_INFO} present and ${NEEDS_TRIAGE} absent`;
		const back = yield* getIssue(repo, issue);
		if (back._tag !== "Present") {
			return refuse(
				READBACK_MISMATCH,
				`triage park: read-back shows nothing — the issue could not be re-read after the write (${
					back._tag === "Absent" ? "it is gone" : back.reason
				}) — ${expected}.`,
				diagnostics,
			);
		}
		const observed = {labels: back.value.labels, milestone: back.value.milestone};
		if (shapeViolations(observed, facets, null).length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`triage park: read-back shows ${renderShape(observed, facets)} — ${expected}.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						outcome: "parked",
						number: issue,
						commentUrl: posted.value.url,
						removed: plan.removed,
					}),
					diagnostics,
				)
			: answer(`parked\t${issue}\t${posted.value.url}`, diagnostics);
	});
