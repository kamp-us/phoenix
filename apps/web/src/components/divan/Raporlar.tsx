/**
 * `Raporlar` — the moderation queue's grid surface (#1701, ADR 0098 §5): one row per
 * open-reported target group off the gated `report.listOpen` read (`Moderate`-gated
 * server-side, so a non-moderator's read denies the invisible `UNAUTHORIZED`, caught by the
 * page's `<Screen>`).
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {OpenReport} from "../../../worker/features/fate/views";
import {plural, useLocale, useT} from "../../i18n";
import {Badge} from "../ui/Badge";
import {itemKindLabel} from "./divanGating";
import {
	reasonText,
	reportAgeLabel,
	targetAuthorLabel,
	targetExcerptText,
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
	const t = useT();
	const result = useRequest({
		"report.listOpen": {list: OpenReportConnectionView, args: {first: QUEUE_PAGE_SIZE}},
	});
	const [items] = useListView(OpenReportConnectionView, result["report.listOpen"]);

	if (items.length === 0) {
		return (
			<p className="kp-divan__empty" data-testid="divan-raporlar-empty">
				{t("divan.raporlar.empty")}
			</p>
		);
	}

	return (
		<ul
			className="kp-divan__raporlar"
			aria-label={t("divan.raporlar.label")}
			data-testid="divan-raporlar"
		>
			{items.map(({node}) => (
				<ReportRow key={node.id} node={node} />
			))}
		</ul>
	);
}

function ReportRow({node}: {readonly node: ViewRef<"OpenReport">}) {
	const t = useT();
	const {locale} = useLocale();
	const data = useView(OpenReportRowView, node);
	const age = reportAgeLabel(data.firstReportedAt, Date.now());
	const href = targetHref(data.targetKind, data.targetRef);
	const excerpt = targetExcerptText(data.targetExcerpt) ?? t("divan.excerpt.unavailable");
	const author = targetAuthorLabel(data.targetAuthor);
	const reason = reasonText(data.reason) ?? t("divan.rapor.noReason");

	return (
		<li
			className="kp-divan__rapor-row"
			data-testid={`divan-rapor-${data.targetKind}-${data.targetId}`}
		>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind">{t(itemKindLabel(data.targetKind))}</span>
				<Badge variant="danger" className="kp-divan__badge">
					{plural(locale, data.reportCount, {
						one: t("divan.report.count.one", {count: data.reportCount}),
						other: t("divan.report.count.other", {count: data.reportCount}),
					})}
				</Badge>
				{age !== null && <span className="kp-divan__rapor-age">{t(age.key, age.params)}</span>}
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
			<p className="kp-divan__rapor-reason">{reason}</p>
		</li>
	);
}
