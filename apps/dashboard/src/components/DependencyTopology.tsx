/**
 * Visualizes the `## Dependencies` topology (story 4): phases as a sequential spine
 * (Phase 1 → Phase 2 → …), the issues within a phase as a parallel group, and each
 * `requires: #N` cross-edge annotated on its subject issue. Closed issues render
 * struck-through so the critical path's progress is glanceable.
 */
import type {DependencyTopology as Topology} from "../lib/pipeline.ts";
import "./DependencyTopology.css";

export function DependencyTopology({
	topology,
	stateOf,
}: {
	topology: Topology;
	stateOf: ReadonlyMap<number, "open" | "closed">;
}) {
	if (topology.phases.length === 0) {
		return <p className="db-topo__empty">No dependency topology pinned on this epic.</p>;
	}

	const requiresOf = (issue: number): ReadonlyArray<number> =>
		topology.requires.filter((e) => e.from === issue).map((e) => e.to);

	const ordered = [...topology.phases].sort((a, b) => a.phase - b.phase);

	return (
		<ol className="db-topo">
			{ordered.map((p, i) => (
				<li key={p.phase} className="db-topo__phase">
					<div className="db-topo__phase-head">Phase {p.phase}</div>
					<ul className="db-topo__group">
						{p.issues.map((n) => {
							const closed = stateOf.get(n) === "closed";
							const requires = requiresOf(n);
							return (
								<li
									key={n}
									className={`db-topo__node db-topo__node--${closed ? "closed" : "open"}`}
								>
									<span className="db-topo__ref">#{n}</span>
									{requires.length > 0 && (
										<span className="db-topo__requires">
											requires {requires.map((r) => `#${r}`).join(", ")}
										</span>
									)}
								</li>
							);
						})}
					</ul>
					{i < ordered.length - 1 && (
						<div className="db-topo__spine" aria-hidden="true">
							↓
						</div>
					)}
				</li>
			))}
		</ol>
	);
}
