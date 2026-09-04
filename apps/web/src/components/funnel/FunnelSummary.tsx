/**
 * `FunnelSummary` — the conversion readout's card (#1589). Reads the gated
 * `funnel.summary` (founder/mod only); a non-mod read denies with the invisible
 * `UNAUTHORIZED`, caught by the page's `<Screen>`.
 */
import {useRequest, useView, view} from "react-fate";
import type {FunnelSummary as FunnelSummaryEntity} from "../../../worker/features/fate/views";
import {type Locale, useLocale, useT} from "../../i18n";

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

function numberLocale(locale: Locale): string {
	return locale === "tr" ? "tr-TR" : "en-US";
}

function formatCount(n: number, locale: Locale): string {
	if (n < 1000) return String(n);
	return n.toLocaleString(numberLocale(locale));
}

function formatRate(rate: number, locale: Locale): string {
	return rate.toLocaleString(numberLocale(locale), {
		style: "percent",
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	});
}

export function FunnelSummary() {
	const t = useT();
	const {locale} = useLocale();
	const result = useRequest(funnelRequest);
	const summary = useView(FunnelSummaryView, result["funnel.summary"]);
	const medianMs = summary.timeToPromotionMedianMs;
	const median =
		medianMs === null
			? t("divan.funnel.notMeasurable")
			: t("divan.funnel.days", {
					days: (medianMs / MS_PER_DAY).toLocaleString(numberLocale(locale), {
						minimumFractionDigits: 1,
						maximumFractionDigits: 1,
					}),
				});

	return (
		<div data-testid="funnel-summary">
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">
					{t("divan.funnel.promotionRate")}
				</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-promotion-rate">
					{formatRate(summary.promotionRate, locale)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">
					{t("divan.funnel.firstContributionRate")}
				</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-first-contribution-rate">
					{formatRate(summary.firstContributionRate, locale)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">{t("divan.funnel.vouchRate")}</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-vouch-rate">
					{formatRate(summary.vouchRate, locale)}
				</p>
			</figure>
			<figure className="kp-funnel__headline">
				<figcaption className="kp-funnel__headline-label">
					{t("divan.funnel.timeToPromotion")}
				</figcaption>
				<p className="kp-funnel__headline-value" data-testid="funnel-time-to-promotion">
					{median}
				</p>
				{summary.timeToPromotionNotYetMeasurable > 0 && (
					<figcaption
						className="kp-funnel__headline-note"
						data-testid="funnel-time-to-promotion-not-measurable"
					>
						{t("divan.funnel.notMeasurableCount", {
							count: formatCount(summary.timeToPromotionNotYetMeasurable, locale),
						})}
					</figcaption>
				)}
			</figure>
			<dl className="kp-funnel__counts">
				<div className="kp-funnel__metric">
					<dt className="kp-funnel__metric-label">{t("divan.funnel.caylak")}</dt>
					<dd className="kp-funnel__metric-value">{formatCount(summary.caylakCount, locale)}</dd>
				</div>
				<div className="kp-funnel__metric">
					<dt className="kp-funnel__metric-label">{t("divan.funnel.yazar")}</dt>
					<dd className="kp-funnel__metric-value">{formatCount(summary.yazarCount, locale)}</dd>
				</div>
			</dl>
		</div>
	);
}
