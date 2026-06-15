import type {PipelineIssue} from "../lib/pipeline.ts";
import {Badge} from "./Badge.tsx";
import "./IssueRow.css";

/**
 * One issue in a status group: number + title, with its `type:*` and `p*` as
 * badges. `pickable` is passed from the group (only `status:triaged` rows are
 * pickable) and drives the row's pickable affordance via a data attribute.
 */
export function IssueRow({issue, pickable}: {issue: PipelineIssue; pickable: boolean}) {
	const {number, title, parsed} = issue;
	return (
		<li className="qb-row" data-pickable={pickable} data-testid="issue-row">
			<a
				className="qb-row__link"
				href={`https://github.com/kamp-us/phoenix/issues/${number}`}
				target="_blank"
				rel="noreferrer"
			>
				<span className="qb-row__number">#{number}</span>
				<span className="qb-row__title">{title}</span>
			</a>
			<span className="qb-row__badges">
				{parsed.type ? <Badge tone="type">{parsed.type}</Badge> : null}
				{parsed.priority ? <Badge tone={parsed.priority}>{parsed.priority}</Badge> : null}
				{pickable ? (
					<span className="qb-row__pick" title="Pickable now (status:triaged)">
						pickable
					</span>
				) : null}
			</span>
		</li>
	);
}
