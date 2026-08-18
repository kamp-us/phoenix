/**
 * `triage apply` — the whole triaged transition as one owned-facet reconcile, read back positively.
 *
 * Type, priority, audience, status and the home land together or not at all, and what the verb
 * reports is what it re-read, never what it requested. v1's read-back did `landed ?? requested`, so a
 * read that found no status label reported the *asked-for* one as landed; a read-back that falls back
 * to the request is not a read-back.
 *
 * The reconcile itself — which labels are owned, what is removed, what is preserved, and the shape
 * the read-back asserts — lives in `./facets.ts` and is shared with `triage park`.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, listLabels, listOpenMilestones, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	CRITERIA_REQUIRED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {applyChanges} from "./facet-writes.ts";
import {
	AUDIENCES,
	decodeMember,
	PRIORITIES,
	planReconcile,
	renderShape,
	STANDING_LANES,
	type StandingLane,
	shapeViolations,
	type TriageAudience,
	type TriageType,
	TYPES,
	triagedFacets,
} from "./facets.ts";
import {scannedLine} from "./scope.ts";
import {guardTarget} from "./target-guard.ts";

export interface ApplyOptions {
	readonly issue: number;
	readonly type: string;
	readonly priority: string;
	readonly readyFor: string;
	readonly home: number | null;
	readonly lane: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const unreadable = (what: string, repo: string, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`triage apply: cannot read ${what} in ${repo}: ${reason} — nothing was written; the transition is UNKNOWN.`,
	);

/**
 * The audience stamp's precondition: `ready-for:agent` only over a body a builder can pick up cold.
 *
 * Read through the same wire module every downstream grader reads — `build issue` and
 * `review criteria` refuse exactly what it refuses, so stamping over a body it will not answer
 * `Found` on only defers the refusal to a lane that cannot repair it (#6025).
 *
 * **`--type epic` is exempt**, and that is the load-bearing carve-out: an epic's criteria arrive per
 * child from the plan ledger rather than in its own body, so a blanket refusal would make a triaged
 * epic unstampable. `--ready-for human` is exempt on every type — the promise the block backs is the
 * one made to an agent.
 */
const criteriaRefusal = (
	issue: number,
	type: TriageType,
	readyFor: TriageAudience,
	body: string,
): VerbOutcome | null => {
	if (readyFor !== "agent" || type === "epic") return null;
	const criteria = readCriteria(body);
	if (criteria._tag === "Found") return null;
	return refuse(
		CRITERIA_REQUIRED,
		criteria._tag === "Absent"
			? `triage apply: #${issue} carries no acceptance-criteria block — ${criteria.reason}. ready-for:agent promises a builder can pick it up cold; an absent block has nothing to repair mechanically, so author one with \`triage enrich\`. Nothing was written.`
			: `triage apply: #${issue}'s acceptance-criteria block is malformed — ${criteria.reason} (${criteria.evidence}). Repair a level drift with \`triage repair-criteria ${issue}\`; anything else needs a hand. Nothing was written.`,
	);
};

export const runApply = (
	options: ApplyOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;

		if (!Number.isInteger(issue) || issue <= 0) {
			return refuse(FAILED, `triage apply: ${issue} is not an issue number.`);
		}
		if ((options.home === null) === (options.lane === null)) {
			return refuse(
				FAILED,
				"triage apply: give exactly one of --home or --lane; an issue cannot be both homed and lane-exempt.",
			);
		}

		const type = decodeMember(TYPES, options.type);
		if (type === null) {
			return refuse(
				OFF_VOCABULARY,
				`triage apply: --type must be one of ${TYPES.join(", ")} — got "${options.type}".`,
			);
		}
		const priority = decodeMember(PRIORITIES, options.priority);
		if (priority === null) {
			return refuse(
				OFF_VOCABULARY,
				`triage apply: --priority must be one of ${PRIORITIES.join(", ")} — got "${options.priority}". Refusing to apply it as a label.`,
			);
		}
		const readyFor = decodeMember(AUDIENCES, options.readyFor);
		if (readyFor === null) {
			return refuse(
				OFF_VOCABULARY,
				`triage apply: --ready-for must be human or agent — got "${options.readyFor}".`,
			);
		}
		let lane: StandingLane | null = null;
		if (options.lane !== null) {
			lane = decodeMember(STANDING_LANES, options.lane);
			if (lane === null) {
				return refuse(
					OFF_VOCABULARY,
					`triage apply: --lane must be ${STANDING_LANES.join(" or ")} — got "${options.lane}".`,
				);
			}
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"triage apply: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `triage apply: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") {
			return unreadable(`issue #${issue}`, repo, target.reason);
		}

		const guarded = yield* guardTarget({
			verb: "triage apply",
			repo,
			issue,
			target: target.value,
			env: options.env,
		});
		if (guarded !== null) return guarded;

		const refusal = criteriaRefusal(issue, type, readyFor, target.value.body);
		if (refusal !== null) return refusal;

		const vocabulary = yield* listLabels(repo);
		if (vocabulary._tag === "Failure") return unreadable("the label set", repo, vocabulary.reason);
		const diagnostics = [scannedLine("triage apply", repo, vocabulary.value.length, "label")];

		// Only the labels THIS invocation writes, not the whole vocabulary: checking all six types
		// would refuse a good `--type bug` in a repo that merely lacks `type:investigation`.
		const facets = triagedFacets({type, priority, readyFor, lane});
		const willWrite = facets.flatMap((facet) => facet.keep);
		const missing = willWrite.find((label) => !vocabulary.value.includes(label));
		if (missing !== undefined) {
			return refuse(
				ZERO_SCOPE,
				`triage apply: label ${missing} does not exist in ${repo} — refusing to write, because the API would create it (#4285).`,
				diagnostics,
			);
		}

		if (options.home !== null) {
			const open = yield* listOpenMilestones(repo);
			if (open._tag === "Failure") return unreadable("the milestone set", repo, open.reason);
			diagnostics.push(scannedLine("triage apply", repo, open.value.length, "open milestone"));
			if (!open.value.some((m) => m.number === options.home)) {
				return refuse(
					OFF_VOCABULARY,
					`triage apply: milestone ${options.home} is not an open milestone in ${repo}.`,
					diagnostics,
				);
			}
		}

		const home = options.home;
		const plan = planReconcile(
			{labels: target.value.labels, milestone: target.value.milestone},
			facets,
			home,
		);

		const written = yield* applyChanges(repo, issue, plan.changes);
		if (written._tag === "Failed") {
			return refuse(
				WRITE_UNKNOWN,
				`triage apply: write failed after ${written.applied} of ${plan.changes.length} changes: ${written.reason} — #${issue} may be partially labelled; re-run this verb, which is idempotent.`,
				diagnostics,
			);
		}

		const expected = `expected exactly one type, one priority, status:triaged, one ready-for, and ${
			home === null ? "no milestone" : `milestone ${home}`
		}`;
		const back = yield* getIssue(repo, issue);
		if (back._tag !== "Present") {
			return refuse(
				READBACK_MISMATCH,
				`triage apply: read-back shows nothing — the issue could not be re-read after the write (${
					back._tag === "Absent" ? "it is gone" : back.reason
				}) — ${expected}.`,
				diagnostics,
			);
		}
		const observed = {labels: back.value.labels, milestone: back.value.milestone};
		const violations = shapeViolations(observed, facets, home);
		if (violations.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`triage apply: read-back shows ${renderShape(observed, facets)} — ${expected}.`,
				diagnostics,
			);
		}

		const homeColumn = home === null ? (lane as string) : String(home);
		return json
			? answer(
					JSON.stringify({
						outcome: "triaged",
						number: issue,
						type,
						priority,
						readyFor,
						home: home === null ? lane : home,
						removed: plan.removed,
						readBack: {labels: observed.labels, milestone: observed.milestone},
					}),
					diagnostics,
				)
			: answer(`triaged\t${issue}\t${type}\t${priority}\t${readyFor}\t${homeColumn}`, diagnostics);
	});
