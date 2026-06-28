/**
 * `DivanRoster` — the pending-çaylak roster (#1290), the divan's landing list.
 * Reads the gated `divan.roster` DESTINATION (the `sandboxBacklogWhere` read
 * model, #1205) — one row per çaylak with ≥1 sandboxed item, in the server's
 * **"needs your eyes"** order (most-contributed first; the resolver owns the
 * sort, this surface renders it as given). Selecting a row opens that çaylak's
 * detail.
 *
 * Each row surfaces the çaylak's handle + **karma-on-others** through
 * {@link CaylakIdentity}, fed from the identity fields the `divan.roster` view now
 * carries inline (#1423) — so the roster's SINGLE batched `useRequest` resolves every
 * row's identity, with NO per-row by-id `Profile` read and NO per-row Suspense
 * boundary (ADR 0021's no-waterfalls contract). A since-deleted profile arrives as a
 * null handle and degrades to the bare "çaylak" label, never breaking the list.
 *
 * a11y: a real list of `<button>` rows (full keyboard path + visible focus + AA
 * contrast); the selected row carries `aria-current`; the pending counts are
 * text, never color; copy is lowercase Turkish.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {DivanCaylak} from "../../../worker/features/fate/views";
import {CaylakIdentity} from "./CaylakIdentity";

const ROSTER_PAGE_SIZE = 50;

const RosterRowView = view<DivanCaylak>()({
	id: true,
	authorId: true,
	username: true,
	displayName: true,
	totalKarma: true,
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
				<CaylakIdentity
					authorId={data.authorId}
					displayName={data.displayName}
					username={data.username}
					totalKarma={data.totalKarma}
				/>
				<span className="kp-divan__counts">
					{data.totalCount} içerik · {data.definitionCount} tanım, {data.postCount} gönderi,{" "}
					{data.commentCount} yorum
				</span>
			</button>
		</li>
	);
}
