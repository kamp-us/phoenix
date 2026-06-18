/**
 * Pure shaping for the milestones section (#379): group the pipeline's issues by
 * the milestone they're assigned to and surface each milestone's open/closed
 * progress. Kept free of React so the grouping/progress math is unit-testable
 * without a DOM.
 *
 * Progress source: GitHub's own `open_issues`/`closed_issues` rollup rides along
 * on every issue's milestone object (see worker/features/pipeline/github.ts), so a
 * milestone's totals are authoritative even when not every member issue is in the
 * board's fetched window — the rollup is read from the milestone object, the
 * member list is what the board actually fetched.
 */
import type {PipelineEpic, PipelineIssue, PipelineMilestone, PipelineState} from "./pipeline.ts";

export interface MilestoneGroup {
	number: number;
	title: string;
	state: "open" | "closed";
	/** GitHub's rollup: issues still open in this milestone. */
	openIssues: number;
	/** GitHub's rollup: issues already closed in this milestone. */
	closedIssues: number;
	/** Total tracked by the milestone (open + closed); 0 yields a 0% bar, never NaN. */
	total: number;
	/** Closed fraction in [0, 1] — `closedIssues / total`, 0 when the milestone is empty. */
	fraction: number;
	/** The fetched issues assigned to this milestone, sorted by number ascending. */
	issues: PipelineIssue[];
}

/** The milestone object an epic or issue carries (both share the field, #379). */
const milestoneOf = (i: PipelineIssue | PipelineEpic): PipelineMilestone | null => i.milestone;

/**
 * Group the pipeline's issues by their assigned milestone, ordered: open
 * milestones first (by ascending number), then closed (by ascending number). An
 * issue with no milestone is omitted. The per-group counts come from GitHub's
 * rollup on the milestone object, not from counting the fetched member list, so
 * the progress bar matches the GitHub milestone page even when the board's fetch
 * window doesn't hold every member.
 */
export function groupByMilestone(state: PipelineState): MilestoneGroup[] {
	const byNumber = new Map<number, MilestoneGroup>();

	for (const issue of state.issues) {
		const m = milestoneOf(issue);
		if (m === null) continue;
		const group = byNumber.get(m.number) ?? newGroup(m);
		group.issues.push(issue);
		byNumber.set(m.number, group);
	}

	const groups = [...byNumber.values()];
	for (const g of groups) g.issues.sort((a, b) => a.number - b.number);
	groups.sort((a, b) => {
		if (a.state !== b.state) return a.state === "open" ? -1 : 1;
		return a.number - b.number;
	});
	return groups;
}

const newGroup = (m: PipelineMilestone): MilestoneGroup => {
	const total = m.openIssues + m.closedIssues;
	return {
		number: m.number,
		title: m.title,
		state: m.state,
		openIssues: m.openIssues,
		closedIssues: m.closedIssues,
		total,
		fraction: total === 0 ? 0 : m.closedIssues / total,
		issues: [],
	};
};

/** A milestone's progress as a whole percent in [0, 100] for the bar's width/label. */
export const milestonePercent = (group: MilestoneGroup): number => Math.round(group.fraction * 100);
