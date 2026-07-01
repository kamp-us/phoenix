/**
 * `FunnelSummary` — the conversion readout's tier-population card (#1589): the two
 * counts (çaylak, yazar) the founder/mod front page renders. Reads the gated
 * `funnel.summary` DESTINATION (founder/mod, behind `phoenix-funnel-readout`); a
 * non-mod read denies the invisible `UNAUTHORIZED`, caught by the page's `<Screen>`.
 *
 * a11y (#1202 baseline): a real description list (`<dl>`) so each number carries an
 * accessible label (the term names the tier, the count is its definition); the
 * numbers are text, never color-coded; copy is lowercase Turkish.
 */
import {useRequest, useView, view} from "react-fate";
import type {FunnelSummary as FunnelSummaryEntity} from "../../../worker/features/fate/views";

/** `FunnelSummary` is a singleton entity (constant `id`), served by `funnel.summary`. */
const FunnelSummaryView = view<FunnelSummaryEntity>()({
	id: true,
	caylakCount: true,
	yazarCount: true,
});

const funnelRequest = {
	"funnel.summary": {view: FunnelSummaryView},
} as const;

/** Turkish thousands separator is `.` (e.g. 1.247). */
function formatCount(n: number): string {
	if (n < 1000) return String(n);
	return n.toLocaleString("tr-TR");
}

export function FunnelSummary() {
	const result = useRequest(funnelRequest);
	const summary = useView(FunnelSummaryView, result["funnel.summary"]);

	return (
		<dl className="kp-funnel__counts" data-testid="funnel-summary">
			<div className="kp-funnel__metric">
				<dt className="kp-funnel__metric-label">çaylak</dt>
				<dd className="kp-funnel__metric-value">{formatCount(summary.caylakCount)}</dd>
			</div>
			<div className="kp-funnel__metric">
				<dt className="kp-funnel__metric-label">yazar</dt>
				<dd className="kp-funnel__metric-value">{formatCount(summary.yazarCount)}</dd>
			</div>
		</dl>
	);
}
