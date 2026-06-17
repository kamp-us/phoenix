/**
 * Epic detail view (#256): drill into one epic and see its decomposition the way
 * `plan-epic` wrote it — children with their badges (story 3), the `## Dependencies`
 * topology (story 4), each child's pickable/blocked verdict (story 5), and phase
 * progress (story 9). All derivation is the pure `lib/epic.ts` core; this page is the
 * render + data-load shell.
 *
 * Self-contained (no router dependency): an epic picker selects which epic to drill
 * into, defaulting to the first open epic.
 */
import {useEffect, useMemo, useState} from "react";
import {ChildRow} from "../components/ChildRow.tsx";
import {DependencyTopology} from "../components/DependencyTopology.tsx";
import {deriveChildren, derivePhaseProgress} from "../lib/epic.ts";
import {
	buildStateMap,
	fetchPipeline,
	findIssue,
	type PipelineEpic,
	type PipelineState,
} from "../lib/pipeline.ts";
import "./EpicDetail.css";

export function EpicDetail() {
	const [state, setState] = useState<PipelineState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<number | null>(null);

	useEffect(() => {
		const ctrl = new AbortController();
		fetchPipeline(ctrl.signal)
			.then(setState)
			.catch((e: unknown) => {
				if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
			});
		return () => ctrl.abort();
	}, []);

	if (error) return <p className="db-epic__error">Failed to load pipeline: {error}</p>;
	if (!state) return <p className="db-epic__loading">Loading pipeline…</p>;

	const firstEpic = state.epics[0];
	if (!firstEpic) return <p className="db-epic__empty">No epics in the pipeline.</p>;

	const fallback = state.epics.find((e) => e.state === "open") ?? firstEpic;
	const epic = (selected !== null && state.epics.find((e) => e.number === selected)) || fallback;

	return (
		<section className="db-epic">
			<EpicPicker epics={state.epics} selected={epic.number} onSelect={setSelected} />
			<EpicBody epic={epic} state={state} />
		</section>
	);
}

function EpicPicker({
	epics,
	selected,
	onSelect,
}: {
	epics: ReadonlyArray<PipelineEpic>;
	selected: number;
	onSelect: (n: number) => void;
}) {
	return (
		<label className="db-epic__picker">
			Epic{" "}
			<select value={selected} onChange={(e) => onSelect(Number(e.target.value))}>
				{epics.map((e) => (
					<option key={e.number} value={e.number}>
						#{e.number} — {e.title}
					</option>
				))}
			</select>
		</label>
	);
}

function EpicBody({epic, state}: {epic: PipelineEpic; state: PipelineState}) {
	const stateOf = useMemo(() => buildStateMap(state), [state]);

	const childFacts = useMemo(
		() =>
			epic.children
				.map((n) => findIssue(state, n))
				.filter((i): i is NonNullable<typeof i> => i !== undefined)
				.map((i) => ({number: i.number, state: i.state, status: i.parsed.status})),
		[epic, state],
	);

	const topology = useMemo(
		() => ({
			children: epic.children,
			phases: epic.dependencies.phases,
			requires: epic.dependencies.requires,
		}),
		[epic],
	);

	const derivations = useMemo(
		() => new Map(deriveChildren(childFacts, topology, stateOf).map((d) => [d.number, d])),
		[childFacts, topology, stateOf],
	);

	const progress = useMemo(
		() => derivePhaseProgress(childFacts, topology, stateOf),
		[childFacts, topology, stateOf],
	);

	const children = epic.children
		.map((n) => findIssue(state, n))
		.filter((i): i is NonNullable<typeof i> => i !== undefined);

	return (
		<>
			<header className="db-epic__header">
				<h2>
					#{epic.number} {epic.title}
				</h2>
				<p className="db-epic__progress">{progress.label}</p>
				{epic.milestone ? (
					<p className="db-epic__milestone" data-testid="epic-milestone">
						Milestone{" "}
						<a
							href={`https://github.com/kamp-us/phoenix/milestone/${epic.milestone.number}`}
							target="_blank"
							rel="noreferrer"
						>
							{epic.milestone.title}
						</a>{" "}
						— {epic.milestone.closedIssues} closed / {epic.milestone.openIssues} open
					</p>
				) : null}
			</header>

			<h3 className="db-epic__section">Dependency topology</h3>
			<DependencyTopology topology={epic.dependencies} stateOf={stateOf} />

			<h3 className="db-epic__section">Children</h3>
			<ul className="db-epic__children">
				{children.map((c) => {
					const d = derivations.get(c.number);
					if (!d) return null;
					return <ChildRow key={c.number} issue={c} derivation={d} />;
				})}
			</ul>
		</>
	);
}
