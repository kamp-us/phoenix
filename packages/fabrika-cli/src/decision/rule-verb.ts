/**
 * `decision rule` — record a control-plane human's ruling on one `type:decision` issue and hand the
 * issue back to the agent lane.
 *
 * The gap this closes: triage routes a decision to `ready-for:human` because its deliverable is a
 * judgement, and once the founder has made that judgement in a comment there is no path back. The
 * label still says "a human must decide" about a question a human decided, so every ruled decision
 * costs a driver bypass around the park (#5842, consolidated into epic #5843 by the founder's
 * 2026-08-16 scope addition).
 *
 * **The digest is derived here and taken from nowhere.** There is no `--digest` flag, and adding one
 * would be the defect: a ruling whose scope its caller supplies attests whatever the caller pleased,
 * which is precisely the binding the marker exists to be. The verb reads the issue and takes
 * `./digest.ts`'s answer over the body it actually read.
 *
 * **The order of the two writes is the invariant.** The marker is posted and read back *first*, and
 * only a proven marker earns the audience flip. Reversed, a failed marker write would leave an issue
 * reading `ready-for:agent` with no recorded ruling behind it — a decision that looks pickable
 * because of an authority nobody can point at, which is the exact failure this verb exists to close.
 *
 * A roster that could not be read is `11` — never "not authorized" and never "authorized". That is
 * the collapse `ship cp-approval` already refuses to make (#4223), and it is worth more here: this
 * verb's whole output is an authority claim.
 *
 * **The guard sits on the flip, never on the ruling.** A ruled decision whose body carries no
 * acceptance-criteria block still earns its marker — the founder's judgement is the durable thing —
 * but not the audience, because `ready-for:agent` promises a builder can grade the issue cold and a
 * criteria-less one only parks the lane at `build claim` exit 32 (#6734).
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {parseCitation} from "../build/scope-admission.ts";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {
	addLabels,
	createComment,
	getComment,
	getIssue,
	listComments,
	listLabels,
	removeLabel,
} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {
	audienceSettled,
	audienceWrites,
	READY_FOR_AGENT,
	READY_FOR_HUMAN,
} from "../triage/audience.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AcceptanceCriteriaRead, read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	emit,
	markedIssue,
	RULING_GRAMMAR,
	rulingUrl,
	scopeDigest,
} from "../wire/decision-ruling.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {
	CRITERIA_REQUIRED,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RULING_UNAUTHORIZED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {requireDecision} from "./ruling.ts";

const VERB = "decision rule";

/**
 * The label writes this run owes. The audience's answer holds only over a body a builder could grade
 * cold: a body whose acceptance-criteria block does not read writes neither label, whatever the
 * issue carries today.
 */
const flipWrites = (
	labels: ReadonlyArray<string>,
	criteria: AcceptanceCriteriaRead,
): {readonly add: boolean; readonly remove: boolean} =>
	criteria._tag === "Found" ? audienceWrites(labels) : {add: false, remove: false};

/** Why the flip was skipped, in the reader's own words plus the route that repairs the body. */
const skippedFlip = (
	issue: number,
	criteria: Exclude<AcceptanceCriteriaRead, {readonly _tag: "Found"}>,
): string =>
	criteria._tag === "Absent"
		? `${VERB}: the ruling marker stands, but #${issue} carries no acceptance-criteria block — ${criteria.reason}. ready-for:agent promises a builder can pick it up cold, so the audience was not flipped: author the block with \`fabrika triage enrich ${issue}\` and re-run.`
		: `${VERB}: the ruling marker stands, but #${issue}'s acceptance-criteria block is malformed — ${criteria.reason} (${criteria.evidence}). The audience was not flipped: repair a level drift with \`fabrika triage repair-criteria ${issue}\`, anything else with \`fabrika triage enrich ${issue}\`, then re-run.`;

export interface RuleOptions {
	readonly number: number;
	/** The comment the ruling is written in, as an issue-comment URL. */
	readonly cites: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runRule = (
	options: RuleOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const cited = parseCitation(options.cites, repo, options.number);
		if (cited._tag === "Malformed") {
			return refuse(FAILED, `${VERB}: --cites ${cited.reason}; nothing was written.`);
		}
		const citation = cited.citation;
		const url = rulingUrl(options.cites);
		if (url === null || citation._tag !== "Cited") {
			return refuse(
				FAILED,
				`${VERB}: --cites "${options.cites}" is not an issue-comment URL — the grammar is ${RULING_GRAMMAR}; nothing was written.`,
			);
		}

		const target = yield* requireDecision(VERB, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		const listed = yield* listComments(repo, options.number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${options.number}: ${listed.reason} — whether the cited ruling is recorded there is UNKNOWN. Nothing was written.`,
			);
		}
		const ruling = listed.value.find((comment) => comment.id === citation.commentId);
		if (ruling === undefined) {
			return refuse(
				NO_TARGET,
				`${VERB}: comment ${citation.commentId} is not on #${options.number} — a ruling has to be recorded on the issue it rules.`,
			);
		}

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was written.`,
			);
		}

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${roster.reason} — whether ${viewer.value} may rule is UNKNOWN, neither authorized nor refused (#4223). Nothing was written.`,
			);
		}
		const notes = [
			`${VERB}: ${roster.logins.size} control-plane account(s) from ${roster.owners.join(", ") || "no owner"} at ${roster.ref}.`,
			`${VERB}: read ${listed.value.length} comment(s) on #${options.number}; the cited ruling is ${ruling.author}'s.`,
		];
		if (roster.logins.size === 0) {
			return refuse(
				RULING_UNAUTHORIZED,
				`${VERB}: ${repo}'s CODEOWNERS names no control-plane owner at ${roster.ref}, so no account may rule a decision here.`,
				notes,
			);
		}
		if (!roster.logins.has(viewer.value)) {
			return refuse(
				RULING_UNAUTHORIZED,
				`${VERB}: ${viewer.value} is not on ${repo}'s control-plane roster at ${roster.ref} — refusing to record a ruling.`,
				notes,
			);
		}

		const issue = markedIssue(options.number);
		const derived = bodyDigest(target.issue.body);
		const digest = scopeDigest(derived);
		const at = stampOf(options.now());
		if (issue === null || digest === null || at === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot compose the ruling marker: the issue, the digest "${derived}" or the clock will not brand. Nothing was written.`,
				notes,
			);
		}

		const criteria = readCriteria(target.issue.body);
		const audience = flipWrites(target.issue.labels, criteria);
		if (audience.add) {
			// Only the label this run would POST is guarded: it is the POST that mints an unknown
			// label, and a DELETE of a label the repo never defined removes nothing (#4285).
			const labels = yield* listLabels(repo);
			if (labels._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${repo}'s label taxonomy: ${labels.reason} — nothing was written.`,
					notes,
				);
			}
			if (!labels.value.includes(READY_FOR_AGENT)) {
				return refuse(
					NO_TARGET,
					`${VERB}: label "${READY_FOR_AGENT}" is absent from ${repo}'s taxonomy — refusing to create it (#4285).`,
					notes,
				);
			}
		}

		const body = emit({issue, digest, ruling: url, at});
		const posted = yield* createComment(repo, options.number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker write failed: ${posted.reason} — it may or may not have landed; re-read #${options.number} before retrying. The audience was not flipped.`,
				notes,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker posted and could not be re-read — the outcome is UNKNOWN, so the audience was not flipped.`,
				notes,
			);
		}
		if (normalizeForReadback(back.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker posted but does not read back — the audience was not flipped, and the ruling needs a human eye.`,
				notes,
			);
		}
		if (criteria._tag !== "Found") {
			notes.push(`${VERB}: marker ${posted.value.id} posted and read back.`);
			return refuse(CRITERIA_REQUIRED, skippedFlip(options.number, criteria), notes);
		}
		notes.push(`${VERB}: marker ${posted.value.id} posted and read back; flipping the audience.`);

		if (audience.add) {
			const added = yield* addLabels(repo, options.number, [READY_FOR_AGENT]);
			if (added._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the marker stands but adding "${READY_FOR_AGENT}" failed: ${added.reason} — the audience is UNKNOWN; re-run to finish the flip.`,
					notes,
				);
			}
		}
		if (audience.remove) {
			const removed = yield* removeLabel(repo, options.number, READY_FOR_HUMAN);
			if (removed._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the marker stands but removing "${READY_FOR_HUMAN}" failed: ${removed.reason} — the audience is UNKNOWN; re-run to finish the flip.`,
					notes,
				);
			}
		}

		const reread = yield* getIssue(repo, options.number);
		if (reread._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker stands and #${options.number} could not be re-read — the audience is UNKNOWN, never asserted from intent.`,
				notes,
			);
		}
		const observed = reread.value.labels;
		if (!audienceSettled(observed)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker stands but the audience reads back as ${observed.filter((label) => label.startsWith("ready-for:")).join(", ") || "no ready-for: label"} — the flip did not settle.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "ruled",
				issue: options.number,
				digest: derived,
				ruling: url,
				by: viewer.value,
				at,
				comment: posted.value.id,
				audience: READY_FOR_AGENT,
				observed,
			}),
			notes,
		);
	});
