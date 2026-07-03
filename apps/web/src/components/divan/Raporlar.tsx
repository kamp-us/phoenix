/**
 * `Raporlar` — the moderation queue's first visible surface (#1701, ADR 0098 §5):
 * one row per open-reported target group off the gated `report.listOpen` read
 * (`Moderate`-gated server-side; a non-moderator's read denies the invisible
 * `UNAUTHORIZED`, caught by the page's `<Screen>`). Each row shows the target
 * kind, the report count (the pile-on signal), the reason when present, and the
 * first-reported age. Out of scope: target content preview, resolve/dismiss,
 * history (sibling slices).
 *
 * a11y (the divan baseline): a real `<ul>` list, counts and ages as text (never
 * color), lowercase Turkish copy.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {OpenReport} from "../../../worker/features/fate/views";
import {itemKindLabel} from "./divanGating";
import {reasonLabel, reportAgeLabel} from "./raporlarGating";

const QUEUE_PAGE_SIZE = 50;

const OpenReportRowView = view<OpenReport>()({
	id: true,
	targetKind: true,
	targetId: true,
	reportCount: true,
	reason: true,
	firstReportedAt: true,
});

const OpenReportConnectionView = {items: {node: OpenReportRowView}} as const;

export function Raporlar() {
	const result = useRequest({
		"report.listOpen": {list: OpenReportConnectionView, args: {first: QUEUE_PAGE_SIZE}},
	});
	const [items] = useListView(OpenReportConnectionView, result["report.listOpen"]);

	if (items.length === 0) {
		return (
			<p className="kp-divan__empty" data-testid="divan-raporlar-empty">
				bekleyen rapor yok — kuyruk temiz.
			</p>
		);
	}

	return (
		<ul className="kp-divan__raporlar" aria-label="açık raporlar" data-testid="divan-raporlar">
			{items.map(({node}) => (
				<ReportRow key={node.id} node={node} />
			))}
		</ul>
	);
}

function ReportRow({node}: {readonly node: ViewRef<"OpenReport">}) {
	const data = useView(OpenReportRowView, node);
	const age = reportAgeLabel(data.firstReportedAt, Date.now());

	return (
		<li
			className="kp-divan__rapor-row"
			data-testid={`divan-rapor-${data.targetKind}-${data.targetId}`}
		>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind">{itemKindLabel(data.targetKind)}</span>
				<span className="kp-divan__badge">{data.reportCount} rapor</span>
				{age !== null && <span className="kp-divan__rapor-age">{age}</span>}
			</span>
			<p className="kp-divan__rapor-reason">{reasonLabel(data.reason)}</p>
		</li>
	);
}
