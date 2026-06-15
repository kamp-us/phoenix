/** Status / type / priority label badges (story 2/3). */
import type {PipelinePriority, PipelineStatus, PipelineType} from "../lib/pipeline.ts";
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
