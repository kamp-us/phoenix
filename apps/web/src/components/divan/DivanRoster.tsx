/**
 * `DivanRoster` — the pending-çaylak roster (#1290), off the gated `divan.roster`
 * destination (#1205) in the server's "needs your eyes" order, which this surface renders as
 * given. Each row's identity rides the roster's SINGLE batched `useRequest` (#1423) — no
 * per-row by-id `Profile` read and no per-row Suspense boundary (ADR 0021's no-waterfalls
 * contract); a since-deleted profile degrades to the bare "çaylak" label.
 */
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {Button} from "../ui/Button";
import {CaylakIdentity} from "./CaylakIdentity";
import {divanRosterRequest, RosterConnectionView, RosterRowView} from "./divanReads";

export function DivanRoster({
	selectedId,
	onSelect,
}: {
	readonly selectedId: string | null;
	readonly onSelect: (authorId: string) => void;
}) {
	const result = useRequest(divanRosterRequest());
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
			<Button
				type="button"
				variant="tertiary"
				block
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
			</Button>
		</li>
	);
}
