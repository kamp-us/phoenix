/**
 * `FunnelSummary` — the conversion readout's card (#1589). Reads the gated
 * `funnel.summary` (founder/mod only); a non-mod read denies with the invisible
 * `UNAUTHORIZED`, caught by the page's `<Screen>`.
 */
import {useRequest, useView, view} from "react-fate";
import type {FunnelSummary as FunnelSummaryEntity} from "../../../worker/features/fate/views";

const FunnelSummaryView = view<FunnelSummaryEntity>()({
	id: true,
	caylakCount: true,
	yazarCount: true,
	promotionRate: true,
	firstContributionRate: true,
	vouchRate: true,
	timeToPromotionMedianMs: true,
	timeToPromotionNotYetMeasurable: true,
});

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const funnelRequest = {
	"funnel.summary": {view: FunnelSummaryView},
} as const;

function formatCount(n: number): string {
	if (n < 1000) return String(n);
	return n.toLocaleString("tr-TR");
}

function formatRate(rate: number): string {
	return rate.toLocaleString("tr-TR", {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	});
}

function formatMedianDays(medianMs: number | null): string {
	if (medianMs === null) return "henüz ölçülemiyor";
	const days = medianMs / MS_PER_DAY;
	return `${days.toLocaleString("tr-TR", {minimumFractionDigits: 1, maximumFractionDigits: 1})} gün`;
}

export function FunnelSummary() {
	const result = useRequest(funnelRequest);
	const summary = useView(FunnelSummaryView, result["funnel.summary"]);

	return (
		<div data-testid="funnel-summary">
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">yazar dönüşüm oranı</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-promotion-rate">
					{formatRate(summary.promotionRate)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">ilk katkı oranı</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-first-contribution-rate">
					{formatRate(summary.firstContributionRate)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">kefil oranı</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-vouch-rate">
					{formatRate(summary.vouchRate)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">yazara geçiş süresi (medyan)</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-time-to-promotion">
					{formatMedianDays(summary.timeToPromotionMedianMs)}
				</p>
				{summary.timeToPromotionNotYetMeasurable > 0 && (
					<figcaption
						className="kp-funnel__headline-note"
						data-testid="funnel-time-to-promotion-not-measurable"
					>
						{formatCount(summary.timeToPromotionNotYetMeasurable)} yazar henüz ölçülemiyor
					</figcaption>
				)}
			</figure>
			<dl className="kp-funnel__counts">
				<div className="kp-funnel__metric">
					<dt className="kp-funnel__metric-label">çaylak</dt>
					<dd className="kp-funnel__metric-value">{formatCount(summary.caylakCount)}</dd>
				</div>
				<div className="kp-funnel__metric">
					<dt className="kp-funnel__metric-label">yazar</dt>
					<dd className="kp-funnel__metric-value">{formatCount(summary.yazarCount)}</dd>
				</div>
			</dl>
		</div>
	);
}
