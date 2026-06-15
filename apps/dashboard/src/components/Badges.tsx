/** Status / type / priority label badges (story 2/3) + the gate verdict badge (#257). */
import type {
	IssueVerdict,
	PipelinePriority,
	PipelineStatus,
	PipelineType,
} from "../lib/pipeline.ts";
import {summarizeVerdict, verdictLabel} from "../lib/verdict.ts";
import "./Badges.css";

export function StatusBadge({status}: {status: PipelineStatus | null}) {
	if (!status) return null;
	return <span className={`db-badge db-badge--status db-badge--status-${status}`}>{status}</span>;
}

export function TypeBadge({type}: {type: PipelineType | null}) {
	if (!type) return null;
	return <span className={`db-badge db-badge--type db-badge--type-${type}`}>{type}</span>;
}

export function PriorityBadge({priority}: {priority: PipelinePriority | null}) {
	if (!priority) return null;
	return (
		<span className={`db-badge db-badge--priority db-badge--priority-${priority}`}>{priority}</span>
	);
}

/**
 * The gate verdict from a linked open PR (#257): PASS / FAIL / awaiting review. An
 * issue with no linked open PR renders nothing (`none`). An open PR with no marker
 * shows "awaiting review" — never a false PASS/FAIL.
 */
export function VerdictBadge({verdict}: {verdict: IssueVerdict | null}) {
	const summary = summarizeVerdict(verdict);
	const label = verdictLabel(summary);
	if (label === null || verdict === null) return null;
	return (
		<a
			className={`db-badge db-badge--verdict db-badge--verdict-${summary}`}
			href={verdict.prUrl}
			target="_blank"
			rel="noreferrer"
			title={`PR #${verdict.prNumber} — ${label}`}
		>
			{label}
		</a>
	);
}
