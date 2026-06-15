/**
 * Pure shaping for the queue board: group the pipeline's open issues by their
 * `status:*`, order the groups so the maintainer reads the pipeline left-to-right
 * (intake → triaged), and derive each issue's pickability. Kept free of React so
 * the grouping/pickability rules are unit-testable without a DOM.
 *
 * Pickability rule (issue #255, story 5 at queue level): `status:triaged` is
 * pickable now; `status:planned` and `status:needs-*` are not. An issue with no
 * status label is unclassified intake — not pickable.
 */
import type {PipelineIssue, PipelineState, PipelineStatus} from "./pipeline.ts";

/** The status buckets a board column can hold, including the no-status intake. */
export type StatusKey = PipelineStatus | "unlabeled";

/**
 * Column order, read as the pipeline flows: raw intake first, pickable work last
 * so the actionable bucket sits at the end of the maintainer's scan.
 */
export const STATUS_ORDER: readonly StatusKey[] = [
	"needs-triage",
	"needs-info",
	"planned",
	"triaged",
	"unlabeled",
];

export const STATUS_LABEL: Record<StatusKey, string> = {
	"needs-triage": "Needs triage",
	"needs-info": "Needs info",
	planned: "Planned",
	triaged: "Triaged",
	unlabeled: "Unlabeled",
};

/** Only `status:triaged` is pickable; everything else (incl. no status) is not. */
export function isPickable(issue: PipelineIssue): boolean {
	return issue.parsed.status === "triaged";
}

export interface StatusGroup {
	status: StatusKey;
	label: string;
	pickable: boolean;
	issues: PipelineIssue[];
}

/**
 * Group the open issues by status into `STATUS_ORDER`, issues sorted by number
 * (ascending) within a group. A group with no issues is omitted so the board
 * shows only buckets that actually hold work.
 */
export function groupByStatus(issues: readonly PipelineIssue[]): StatusGroup[] {
	const buckets = new Map<StatusKey, PipelineIssue[]>();
	for (const issue of issues) {
		if (issue.state !== "open") continue;
		const key: StatusKey = issue.parsed.status ?? "unlabeled";
		const bucket = buckets.get(key) ?? [];
		bucket.push(issue);
		buckets.set(key, bucket);
	}
	const groups: StatusGroup[] = [];
	for (const status of STATUS_ORDER) {
		const bucket = buckets.get(status);
		if (!bucket || bucket.length === 0) continue;
		bucket.sort((a, b) => a.number - b.number);
		groups.push({
			status,
			label: STATUS_LABEL[status],
			pickable: status === "triaged",
			issues: bucket,
		});
	}
	return groups;
}

export interface Freshness {
	stale: boolean;
	/** Epoch-millis the snapshot was fetched from GitHub (the worker's wire type, #291), or null when absent. */
	fetchedAt: number | null;
}

/**
 * Read the freshness signal defensively. `stale`/`fetchedAt` are added by #254 and
 * may be absent on this branch — an absent `stale` is treated as fresh (`false`),
 * never as stale, so today's uncached API isn't mislabelled.
 */
export function readFreshness(state: PipelineState): Freshness {
	return {
		stale: state.stale === true,
		fetchedAt: typeof state.fetchedAt === "number" ? state.fetchedAt : null,
	};
}
