import {groupByMilestone, type MilestoneGroup, milestonePercent} from "../lib/milestone.ts";
import type {PipelineState} from "../lib/pipeline.ts";
import {IssueRow} from "./IssueRow.tsx";
import "./MilestoneSection.css";

/**
 * The milestones section (#379): each milestone an issue is assigned to, with its
 * open-vs-closed progress bar (from GitHub's own rollup) and the fetched issues
 * grouped under it — so a milestone-grouped sweep (e.g. #1 "Pipeline hardening")
 * is trackable from the dashboard instead of the raw GitHub milestone page.
 *
 * Derivation is the pure `lib/milestone.ts` core; this is the render shell.
 */
export function MilestoneSection({state}: {state: PipelineState}) {
	const groups = groupByMilestone(state);
	if (groups.length === 0) return null;

	return (
		<section className="qb-milestones" aria-label="Milestones">
			<h2 className="qb-milestones__title">Milestones</h2>
			<div className="qb-milestones__list">
				{groups.map((group) => (
					<MilestoneCard key={group.number} group={group} />
				))}
			</div>
		</section>
	);
}

function MilestoneCard({group}: {group: MilestoneGroup}) {
	const percent = milestonePercent(group);
	return (
		<section className="qb-milestone" data-state={group.state} data-testid="milestone-card">
			<header className="qb-milestone__head">
				<a
					className="qb-milestone__link"
					href={`https://github.com/kamp-us/phoenix/milestone/${group.number}`}
					target="_blank"
					rel="noreferrer"
				>
					<span className="qb-milestone__title">{group.title}</span>
				</a>
				<span className="qb-milestone__counts">
					{group.closedIssues} closed / {group.openIssues} open
				</span>
			</header>
			<div
				className="qb-milestone__bar"
				role="progressbar"
				aria-valuenow={percent}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${group.title}: ${percent}% closed`}
			>
				<div className="qb-milestone__fill" style={{width: `${percent}%`}} />
			</div>
			<p className="qb-milestone__progress">
				{percent}% closed ({group.closedIssues}/{group.total})
			</p>
			<ul className="qb-milestone__issues">
				{group.issues.map((issue) => (
					<IssueRow key={issue.number} issue={issue} pickable={issue.parsed.status === "triaged"} />
				))}
			</ul>
		</section>
	);
}
