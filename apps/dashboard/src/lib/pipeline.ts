/**
 * SPA-side view of the `GET /api/pipeline` response. These mirror the worker's
 * `effect/Schema` wire shape (worker/features/pipeline/schema.ts) but are kept as
 * plain TS types so the SPA carries no Effect dependency for a read-only fetch.
 *
 * The response is FLAT: `issues`/`epics`/`fetchedAt`/`stale` at the top level
 * (#278). `fetchedAt`/`stale` are read DEFENSIVELY: they are added by the caching
 * child (#254) and may be absent — both are optional so the board renders against
 * today's API and lights the freshness indicator the moment caching lands.
 */

export type PipelineStatus = "needs-triage" | "needs-info" | "planned" | "triaged";
export type PipelineType = "feature" | "chore" | "bug" | "decision" | "investigation" | "epic";
export type PipelinePriority = "p0" | "p1" | "p2";

export interface ParsedLabels {
	status: PipelineStatus | null;
	type: PipelineType | null;
	priority: PipelinePriority | null;
}

export type ReviewOutcome = "PASS" | "FAIL";

/**
 * The merge-readiness verdict from a linked open PR (#257). Present only when an
 * open PR is linked; `null` on the issue otherwise. `code`/`doc` are the latest
 * `review-code`/`review-doc` markers — `null` means that gate hasn't ruled. A PR
 * present with both null is "awaiting review" (never a false PASS/FAIL).
 */
export interface IssueVerdict {
	prNumber: number;
	prUrl: string;
	code: ReviewOutcome | null;
	doc: ReviewOutcome | null;
}

export interface PipelineIssue {
	number: number;
	title: string;
	state: "open" | "closed";
	labels: readonly string[];
	parsed: ParsedLabels;
	verdict: IssueVerdict | null;
}

export interface DependencyPhase {
	readonly phase: number;
	readonly issues: readonly number[];
}

export interface RequiresEdge {
	readonly from: number;
	readonly to: number;
}

export interface DependencyTopology {
	readonly phases: readonly DependencyPhase[];
	readonly requires: readonly RequiresEdge[];
}

export interface PipelineEpic {
	number: number;
	title: string;
	state: "open" | "closed";
	labels: readonly string[];
	parsed: ParsedLabels;
	verdict: IssueVerdict | null;
	children: readonly number[];
	dependencies: DependencyTopology;
}

export interface PipelineState {
	issues: readonly PipelineIssue[];
	epics: readonly PipelineEpic[];
	/** Added by #254 (caching). Absent on this branch — treated as fresh. */
	fetchedAt?: string;
	/** Added by #254 (caching). Absent on this branch — treated as fresh. */
	stale?: boolean;
}

export async function fetchPipeline(signal?: AbortSignal): Promise<PipelineState> {
	const res = await fetch("/api/pipeline", {signal, headers: {accept: "application/json"}});
	if (!res.ok) throw new Error(`pipeline fetch failed: ${res.status}`);
	return (await res.json()) as PipelineState;
}

/** A map from issue number to open/closed, built from the flat issues + epics. */
export const buildStateMap = (state: PipelineState): Map<number, "open" | "closed"> => {
	const m = new Map<number, "open" | "closed">();
	for (const i of state.issues) m.set(i.number, i.state);
	for (const e of state.epics) m.set(e.number, e.state);
	return m;
};

/** Look up an issue (flat or epic) by number across the whole state. */
export const findIssue = (
	state: PipelineState,
	number: number,
): PipelineIssue | PipelineEpic | undefined =>
	state.issues.find((i) => i.number === number) ?? state.epics.find((e) => e.number === number);
