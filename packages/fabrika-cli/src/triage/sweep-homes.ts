/**
 * `triage sweep-homes`'s pure half: which home-xor-exempt breaches the sweep may fix, and which it
 * must refuse.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/7393#issuecomment-5519748588
 *
 * The decision is the guard's. {@link judge} and {@link resolve} from `../guard/homing.ts` are
 * called here, never restated and never parsed out of the guard's report, so the guard and the sweep
 * cannot disagree about what a breach is. This module adds only the split between the two breach
 * kinds. A double-marked issue has one mechanical remedy: a standing lane is milestone-less by
 * design, so the milestone goes and the lane stays. An un-homed issue has three (home it, lane it,
 * kill it), and choosing one is triage's judgment, so the sweep lists it and changes nothing.
 *
 * IO-free and total; the board reads and writes live in `./sweep-homes-verb.ts`.
 */
import {judge, resolve, type TriagedIssue, type Violation} from "../guard/homing.ts";

export type DoubleMarked = Extract<Violation, {readonly kind: "double-marked"}>;
export type Unhomed = Extract<Violation, {readonly kind: "unhomed"}>;

/**
 * What the sweep would do over one scanned board. `ZeroScope` carries no counts because there is
 * nothing to count: an empty triaged backlog is indistinguishable from a broken read, so it is a
 * refusal and never a plan with zero steps.
 */
export type SweepPlan =
	| {readonly _tag: "ZeroScope"}
	| {
			readonly _tag: "Planned";
			readonly scanned: number;
			readonly homed: number;
			readonly exempt: number;
			/** The double-marked issues, each to lose its milestone and keep its lane. */
			readonly clears: ReadonlyArray<DoubleMarked>;
			/** The un-homed issues, listed with the three-way remedy and left untouched. */
			readonly unhomed: ReadonlyArray<Unhomed>;
	  };

/** Plan a sweep over the open `status:triaged` backlog, through the guard's own verdict. */
export const planSweep = (issues: ReadonlyArray<TriagedIssue>): SweepPlan => {
	const verdict = judge(issues, {_tag: "backlog"});
	if (verdict.pass) {
		const {scanned, homed, exempt} = verdict;
		return {_tag: "Planned", scanned, homed, exempt, clears: [], unhomed: []};
	}
	// The backlog scope never answers `vocabulary-absent` (that fork is the single-issue scope's),
	// but it is still a scan that resolved to nothing, so it lands with the zero scope.
	if (verdict.reason !== "violations") return {_tag: "ZeroScope"};
	const clears: DoubleMarked[] = [];
	const unhomed: Unhomed[] = [];
	for (const breach of verdict.violations) {
		if (breach.kind === "double-marked") clears.push(breach);
		else unhomed.push(breach);
	}
	const {scanned, homed, exempt} = verdict;
	return {_tag: "Planned", scanned, homed, exempt, clears, unhomed};
};

/**
 * Whether a freshly re-read issue still carries the breach the plan was made from. The board read
 * ages across a sweep, so a milestone someone changed or cleared since is not this run's to clear.
 */
export const stillDoubleMarked = (fresh: TriagedIssue, planned: DoubleMarked): boolean => {
	const now = resolve(fresh);
	return now.kind === "double-marked" && now.milestone === planned.milestone;
};

/** Whether the read-back after the clear is the exempt shape the clear was for, lanes intact. */
export const landedExempt = (back: TriagedIssue, planned: DoubleMarked): boolean =>
	resolve(back).kind === "exempt" && planned.lanes.every((lane) => back.labels.includes(lane));

/**
 * The hidden marker a trail comment carries, keyed on the milestone it records dropping. A re-run
 * over an issue whose trail landed and whose clear did not finds it and posts no second trail.
 */
export const trailMarker = (milestone: number): string =>
	`<!-- fabrika:sweep-homes milestone=${milestone} -->`;

/** Whether any of an issue's comment bodies is already this milestone's trail. */
export const hasTrail = (bodies: ReadonlyArray<string>, milestone: number): boolean =>
	bodies.some((body) => body.includes(trailMarker(milestone)));

/**
 * The trail comment for one clear. The caller's citation (the decision and ruling the sweep runs
 * under) sits between the fixed statement and the marker, because which records govern homing is
 * the adopting repository's fact, not this package's.
 */
export const trailComment = (planned: DoubleMarked, citation: string): string =>
	[
		`Home sweep (\`fabrika triage sweep-homes\`): this issue carried milestone ${planned.milestone} ` +
			`and the standing lane ${planned.lanes.map((lane) => `\`${lane}\``).join(", ")}, and ` +
			"home-xor-exempt bans carrying both. A standing lane is milestone-less by design, so this " +
			"sweep removes the milestone and keeps the lane.",
		citation.trim(),
		trailMarker(planned.milestone),
	].join("\n\n");
