import {useEffect, useState} from "react";
import {FreshnessIndicator} from "../components/FreshnessIndicator.tsx";
import {IssueRow} from "../components/IssueRow.tsx";
import {fetchPipeline, type PipelineState} from "../lib/pipeline.ts";
import {groupByStatus, readFreshness} from "../lib/queue.ts";
import "./QueueBoard.css";

type Load =
	| {phase: "loading"}
	| {phase: "error"; message: string}
	| {phase: "ready"; state: PipelineState};

/**
 * The dashboard's main screen: the flat `kamp-us/phoenix` queue, grouped by
 * `status:*` so a maintainer sees where work piles up without `gh api` (#255).
 * Pickable (`status:triaged`) groups are visually distinguished; a freshness
 * indicator surfaces the API's `stale`/`fetchedAt` (read defensively — see
 * lib/queue.ts). Epic drill-down (#256) and gate verdicts (#257) are out of scope.
 */
export function QueueBoard() {
	const [load, setLoad] = useState<Load>({phase: "loading"});

	useEffect(() => {
		const ctrl = new AbortController();
		fetchPipeline(ctrl.signal)
			.then((state) => setLoad({phase: "ready", state}))
			.catch((err: unknown) => {
				if (ctrl.signal.aborted) return;
				setLoad({phase: "error", message: err instanceof Error ? err.message : String(err)});
			});
		return () => ctrl.abort();
	}, []);

	if (load.phase === "loading") {
		return <p className="qb-status">Loading the queue…</p>;
	}
	if (load.phase === "error") {
		return <p className="qb-status qb-status--error">Could not load the queue: {load.message}</p>;
	}

	const groups = groupByStatus(load.state.issues);
	const freshness = readFreshness(load.state);

	return (
		<div className="qb-board">
			<header className="qb-board__head">
				<h2 className="qb-board__title">Queue</h2>
				<FreshnessIndicator freshness={freshness} />
			</header>

			{groups.length === 0 ? (
				<p className="qb-status">No open issues in the queue.</p>
			) : (
				<div className="qb-board__columns">
					{groups.map((group) => (
						<section
							key={group.status}
							className="qb-column"
							data-pickable={group.pickable}
							aria-label={group.label}
						>
							<h3 className="qb-column__head">
								<span>{group.label}</span>
								<span className="qb-column__count">{group.issues.length}</span>
							</h3>
							<ul className="qb-column__list">
								{group.issues.map((issue) => (
									<IssueRow key={issue.number} issue={issue} pickable={group.pickable} />
								))}
							</ul>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
