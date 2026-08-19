/**
 * `Raporlar` — the moderation queue's grid surface (#1701, ADR 0098 §5): one row per
 * open-reported target group off the gated `report.listOpen` read (`Moderate`-gated
 * server-side, so a non-moderator's read denies the invisible `UNAUTHORIZED`, caught by the
 * page's `<Screen>`).
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {OpenReport} from "../../../worker/features/fate/views";
import {Badge} from "../ui/Badge";
import {itemKindLabel} from "./divanGating";
import {
	reasonLabel,
	reportAgeLabel,
	targetAuthorLabel,
	targetExcerptLabel,
	targetHref,
} from "./raporlarGating";

const QUEUE_PAGE_SIZE = 50;

const OpenReportRowView = view<OpenReport>()({
	id: true,
	targetKind: true,
	targetId: true,
	reportCount: true,
	reason: true,
	firstReportedAt: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
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
	const href = targetHref(data.targetKind, data.targetRef);
	const excerpt = targetExcerptLabel(data.targetExcerpt);
	const author = targetAuthorLabel(data.targetAuthor);

	return (
		<li
			className="kp-divan__rapor-row"
			data-testid={`divan-rapor-${data.targetKind}-${data.targetId}`}
		>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind">{itemKindLabel(data.targetKind)}</span>
				<Badge variant="danger" className="kp-divan__badge">
					{data.reportCount} rapor
				</Badge>
				{age !== null && <span className="kp-divan__rapor-age">{age}</span>}
			</span>
			<p className="kp-divan__rapor-target">
				{href !== null ? (
					<a className="kp-divan__rapor-link" href={href}>
						{excerpt}
					</a>
				) : (
					<span className="kp-divan__rapor-excerpt">{excerpt}</span>
				)}
				{author !== null && <span className="kp-divan__rapor-author">{author}</span>}
			</p>
			<p className="kp-divan__rapor-reason">{reasonLabel(data.reason)}</p>
		</li>
	);
}
