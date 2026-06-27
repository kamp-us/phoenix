/**
 * `DivanRoster` — the pending-çaylak roster (#1290), the divan's landing list.
 * Reads the gated `divan.roster` DESTINATION (the `sandboxBacklogWhere` read
 * model, #1205) — one row per çaylak with ≥1 sandboxed item, in the server's
 * **"needs your eyes"** order (most-contributed first; the resolver owns the
 * sort, this surface renders it as given). Selecting a row opens that çaylak's
 * detail.
 *
 * Each row surfaces the çaylak's **karma-on-others** via the reusable `<Karma>`
 * atom (through {@link CaylakIdentity}, wrapped per-row in a {@link Screen} so one
 * since-deleted profile degrades to a fallback handle, never breaks the list).
 *
 * a11y: a real list of `<button>` rows (full keyboard path + visible focus + AA
 * contrast); the selected row carries `aria-current`; the pending counts are
 * text, never color; copy is lowercase Turkish.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {DivanCaylak} from "../../../worker/features/fate/views";
import {Screen} from "../../fate/Screen";
import {CaylakIdentity, IdentityFallback} from "./CaylakIdentity";

const ROSTER_PAGE_SIZE = 50;

const RosterRowView = view<DivanCaylak>()({
	id: true,
	authorId: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
	totalCount: true,
});

const RosterConnectionView = {items: {node: RosterRowView}} as const;

export function DivanRoster({
	selectedId,
	onSelect,
}: {
	readonly selectedId: string | null;
	readonly onSelect: (authorId: string) => void;
}) {
	const result = useRequest({
		"divan.roster": {list: RosterConnectionView, args: {first: ROSTER_PAGE_SIZE}},
	});
	const [items] = useListView(RosterConnectionView, result["divan.roster"]);

	if (items.length === 0) {
		return (
			<p className="kp-divan__empty" data-testid="divan-roster-empty">
				incelemede bekleyen çaylak yok.
			</p>
		);
	}

	return (
		<ul className="kp-divan__roster" aria-label="incelemedeki çaylaklar">
			{items.map(({node}) => (
				<RosterRow key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />
			))}
		</ul>
	);
}

function RosterRow({
	node,
	selectedId,
	onSelect,
}: {
	readonly node: ViewRef<"DivanCaylak">;
	readonly selectedId: string | null;
	readonly onSelect: (authorId: string) => void;
}) {
	const data = useView(RosterRowView, node);
	const selected = selectedId === data.authorId;

	return (
		<li className="kp-divan__roster-item">
			<button
				type="button"
				className="kp-divan__roster-row"
				onClick={() => onSelect(data.authorId)}
				aria-current={selected ? "true" : undefined}
				data-testid={`divan-caylak-${data.authorId}`}
			>
				<Screen fallback={<IdentityFallback />} error={() => <IdentityFallback />}>
					<CaylakIdentity authorId={data.authorId} />
				</Screen>
				<span className="kp-divan__counts">
					{data.totalCount} içerik · {data.definitionCount} tanım, {data.postCount} gönderi,{" "}
					{data.commentCount} yorum
				</span>
			</button>
		</li>
	);
}
