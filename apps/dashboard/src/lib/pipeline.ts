/**
 * SPA-side view of the `GET /api/pipeline` response. These mirror the worker's
 * `effect/Schema` wire shape (worker/features/pipeline/schema.ts) but are kept as
 * plain TS types so the SPA carries no Effect dependency for a read-only fetch.
 *
 * `fetchedAt`/`stale` are read DEFENSIVELY: they are added by the caching child
 * (#254) and may be absent in the schema on this branch. Both are optional here so
 * the board compiles and renders against today's API and lights the freshness
 * indicator up the moment #254 lands — no code change required.
 */

export type PipelineStatus = "needs-triage" | "needs-info" | "planned" | "triaged";
export type PipelineType = "feature" | "chore" | "bug" | "decision" | "investigation" | "epic";
export type PipelinePriority = "p0" | "p1" | "p2";

export interface ParsedLabels {
	status: PipelineStatus | null;
	type: PipelineType | null;
	priority: PipelinePriority | null;
}

export interface PipelineIssue {
	number: number;
	title: string;
	state: "open" | "closed";
	labels: readonly string[];
	parsed: ParsedLabels;
}

export interface PipelineState {
	issues: readonly PipelineIssue[];
	epics: readonly unknown[];
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
