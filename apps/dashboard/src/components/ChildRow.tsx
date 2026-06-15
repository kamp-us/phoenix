/** One epic child: number, title, status/type/priority badges, pickability (story 3/5), gate verdict (#257). */
import type {ChildDerivation} from "../lib/epic.ts";
import type {PipelineEpic, PipelineIssue} from "../lib/pipeline.ts";
import {PriorityBadge, StatusBadge, TypeBadge, VerdictBadge} from "./Badges.tsx";
import "./ChildRow.css";
import {PickabilityTag} from "./PickabilityTag.tsx";

export function ChildRow({
	issue,
	derivation,
}: {
	issue: PipelineIssue | PipelineEpic;
	derivation: ChildDerivation;
}) {
	return (
		<li className={`db-child db-child--${issue.state}`}>
			<div className="db-child__head">
				<span className="db-child__number">#{issue.number}</span>
				<span className="db-child__title">{issue.title}</span>
				<span className={`db-child__state db-child__state--${issue.state}`}>{issue.state}</span>
			</div>
			<div className="db-child__tags">
				<StatusBadge status={issue.parsed.status} />
				<TypeBadge type={issue.parsed.type} />
				<PriorityBadge priority={issue.parsed.priority} />
				<VerdictBadge verdict={issue.verdict} />
				<PickabilityTag pickability={derivation.pickability} />
			</div>
		</li>
	);
}
