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

function formatRate(rate: number): string {
	return rate.toLocaleString("tr-TR", {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	});
}

function formatCount(n: number): string {
	if (n < 1000) return String(n);
	return n.toLocaleString("tr-TR");
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
	if (nodes.length === 0) {
		return <p className="kp-funnel__cohort-empty">henüz ölçüm yok</p>;
	}
	return (
		<table className="kp-funnel__cohort-table" data-testid={testId}>
			<caption className="kp-funnel__cohort-caption">{caption}</caption>
			<thead>
				<tr>
					<th scope="col">kayıt haftası</th>
					<th scope="col">kaydoldu</th>
					<th scope="col">2–7. gün döndü</th>
					<th scope="col">ilk katkı</th>
					<th scope="col">kefil</th>
					<th scope="col">yazar</th>
					<th scope="col">1. gün dönüşü</th>
					<th scope="col">7. gün dönüşü</th>
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
	const week = useView(WeekNodeView, node);
	return (
		<tr>
			<td>{week.id}</td>
			<td>{formatCount(week.signedUp)}</td>
			<td>{formatCount(week.returnedDays2to7)}</td>
			<td>{formatCount(week.firstContributed7d)}</td>
			<td>{formatCount(week.vouched7d)}</td>
			<td>{formatCount(week.promoted7d)}</td>
			<td>{formatRate(week.d1ReturnRate)}</td>
			<td>{formatRate(week.d7ReturnRate)}</td>
		</tr>
	);
}

export function FunnelCohorts() {
	const result = useRequest(cohortRequest);
	const report = useView(FunnelCohortsView, result["funnel.cohorts"]);
	const [liveItems] = useListView(WeekConnectionView, result["funnel.cohortWeeks"]);
	const [rollupItems] = useListView(WeekConnectionView, result["funnel.cohortRollups"]);

	if (!report.enabled) return null;

	return (
		<section className="kp-funnel__panel kp-funnel__cohorts" aria-label="kozet hunisi">
			<h2 className="kp-funnel__section-title">kozet hunisi</h2>
			<p className="kp-funnel__section-note">
				her satır aynı hafta kayıt olan hesapların ilk yedi günü. mevcut davet hacminde bu sayılar
				yön gösterir, istatistiksel anlam taşımaz.
			</p>
			<CohortWeekTable
				nodes={liveItems.map(({node}) => node)}
				testId="funnel-cohort-weeks"
				caption="canlı okuma — mevcut tablolar üzerinden"
			/>
			<CohortWeekTable
				nodes={rollupItems.map(({node}) => node)}
				testId="funnel-cohort-rollups"
				caption="haftalık kayıt — her pazartesi 06.00 UTC'de hesaplanır"
			/>
			<dl className="kp-funnel__cohort-holes">
				{report.foundingPromotionsUnmeasurable > 0 && (
					<div className="kp-funnel__metric">
						<dt className="kp-funnel__metric-label">ölçülemeyen yazarlık geçişi</dt>
						<dd className="kp-funnel__metric-value" data-testid="funnel-cohort-founding-hole">
							{formatCount(report.foundingPromotionsUnmeasurable)}
						</dd>
					</div>
				)}
				{report.vouchEvidenceUnmeasurable > 0 && (
					<div className="kp-funnel__metric">
						<dt className="kp-funnel__metric-label">kefil kaydı olmayan yazar</dt>
						<dd className="kp-funnel__metric-value" data-testid="funnel-cohort-vouch-hole">
							{formatCount(report.vouchEvidenceUnmeasurable)}
						</dd>
					</div>
				)}
			</dl>
			<p className="kp-funnel__section-note">
				kurucu kuşakta yazarlık geçişi damgalanmamıştı, çekilen kefiller ise kaydını siler — bu
				hesaplar sayılmaz, geriye dönük kurulamaz.
			</p>
		</section>
	);
}
