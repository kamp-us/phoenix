/**
 * `FunnelCohorts` — the week-1 survival cohort section (#7031, epic #6767), rendered below
 * the pool snapshot on `/funnel`. Reads the gated `funnel.cohorts` report plus the live
 * `funnel.cohortWeeks` and durable `funnel.cohortRollups` lists (founder/mod only); a non-mod
 * read denies with the invisible `UNAUTHORIZED`, caught by the page's `<Screen>`.
 *
 * The whole section is the display half of `phoenix-funnel-cohort`: with the flag off the
 * report resolves `enabled: false` and this renders NOTHING — the page stays byte-identical
 * to the pre-cohort readout. The framing copy names the numbers directional at current
 * volume, and the two known data holes render as explicit counts, never dropped.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {
	FunnelCohorts as FunnelCohortsEntity,
	FunnelCohortWeek as FunnelCohortWeekEntity,
} from "../../../worker/features/fate/views";
import {type Locale, useLocale, useT} from "../../i18n";

const FunnelCohortsView = view<FunnelCohortsEntity>()({
	id: true,
	enabled: true,
	foundingPromotionsUnmeasurable: true,
	vouchEvidenceUnmeasurable: true,
});

const WeekNodeView = view<FunnelCohortWeekEntity>()({
	id: true,
	signedUp: true,
	returnedDays2to7: true,
	firstContributed7d: true,
	vouched7d: true,
	promoted7d: true,
	d1Returned: true,
	d7Returned: true,
	d1ReturnRate: true,
	d7ReturnRate: true,
});

const WeekConnectionView = {items: {node: WeekNodeView}} as const;

const cohortRequest = {
	"funnel.cohorts": {view: FunnelCohortsView},
	"funnel.cohortWeeks": {list: WeekConnectionView},
	"funnel.cohortRollups": {list: WeekConnectionView},
} as const;

function numberLocale(locale: Locale): string {
	return locale === "tr" ? "tr-TR" : "en-US";
}

function formatRate(rate: number, locale: Locale): string {
	return rate.toLocaleString(numberLocale(locale), {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	});
}

function formatCount(n: number, locale: Locale): string {
	if (n < 1000) return String(n);
	return n.toLocaleString(numberLocale(locale));
}

function CohortWeekTable({
	nodes,
	testId,
	caption,
}: {
	readonly nodes: ReadonlyArray<ViewRef<"FunnelCohortWeek">>;
	readonly testId: string;
	readonly caption: string;
}) {
	const t = useT();
	if (nodes.length === 0) {
		return <p className="kp-funnel__cohort-empty">{t("divan.funnel.cohorts.empty")}</p>;
	}
	return (
		<table className="kp-funnel__cohort-table" data-testid={testId}>
			<caption className="kp-funnel__cohort-caption">{caption}</caption>
			<thead>
				<tr>
					<th scope="col">{t("divan.funnel.cohorts.colWeek")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colSignedUp")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colReturned")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colFirstContribution")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colKefil")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colYazar")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colD1")}</th>
					<th scope="col">{t("divan.funnel.cohorts.colD7")}</th>
				</tr>
			</thead>
			<tbody>
				{nodes.map((node) => (
					<CohortWeekRow key={node.id} node={node} />
				))}
			</tbody>
		</table>
	);
}

function CohortWeekRow({node}: {readonly node: ViewRef<"FunnelCohortWeek">}) {
	const {locale} = useLocale();
	const week = useView(WeekNodeView, node);
	return (
		<tr>
			<td>{week.id}</td>
			<td>{formatCount(week.signedUp, locale)}</td>
			<td>{formatCount(week.returnedDays2to7, locale)}</td>
			<td>{formatCount(week.firstContributed7d, locale)}</td>
			<td>{formatCount(week.vouched7d, locale)}</td>
			<td>{formatCount(week.promoted7d, locale)}</td>
			<td>{formatRate(week.d1ReturnRate, locale)}</td>
			<td>{formatRate(week.d7ReturnRate, locale)}</td>
		</tr>
	);
}

export function FunnelCohorts() {
	const t = useT();
	const {locale} = useLocale();
	const result = useRequest(cohortRequest);
	const report = useView(FunnelCohortsView, result["funnel.cohorts"]);
	const [liveItems] = useListView(WeekConnectionView, result["funnel.cohortWeeks"]);
	const [rollupItems] = useListView(WeekConnectionView, result["funnel.cohortRollups"]);

	if (!report.enabled) return null;

	return (
		<section
			className="kp-funnel__panel kp-funnel__cohorts"
			aria-label={t("divan.funnel.cohorts.label")}
		>
			<h2 className="kp-funnel__section-title">{t("divan.funnel.cohorts.label")}</h2>
			<p className="kp-funnel__section-note">{t("divan.funnel.cohorts.note")}</p>
			<CohortWeekTable
				nodes={liveItems.map(({node}) => node)}
				testId="funnel-cohort-weeks"
				caption={t("divan.funnel.cohorts.liveCaption")}
			/>
			<CohortWeekTable
				nodes={rollupItems.map(({node}) => node)}
				testId="funnel-cohort-rollups"
				caption={t("divan.funnel.cohorts.rollupCaption")}
			/>
			<dl className="kp-funnel__cohort-holes">
				{report.foundingPromotionsUnmeasurable > 0 && (
					<div className="kp-funnel__metric">
						<dt className="kp-funnel__metric-label">{t("divan.funnel.cohorts.foundingHole")}</dt>
						<dd className="kp-funnel__metric-value" data-testid="funnel-cohort-founding-hole">
							{formatCount(report.foundingPromotionsUnmeasurable, locale)}
						</dd>
					</div>
				)}
				{report.vouchEvidenceUnmeasurable > 0 && (
					<div className="kp-funnel__metric">
						<dt className="kp-funnel__metric-label">{t("divan.funnel.cohorts.vouchHole")}</dt>
						<dd className="kp-funnel__metric-value" data-testid="funnel-cohort-vouch-hole">
							{formatCount(report.vouchEvidenceUnmeasurable, locale)}
						</dd>
					</div>
				)}
			</dl>
			<p className="kp-funnel__section-note">{t("divan.funnel.cohorts.holesNote")}</p>
		</section>
	);
}
