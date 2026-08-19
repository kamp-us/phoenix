/**
 * Loading placeholders that mirror the real DOM shape, so content arrival swaps in
 * without a layout jump.
 */
import {PANO_FEED_PAGE_SIZE} from "../../lib/panoNav";
import {Skeleton} from "../ui/atoms";
import "./PanoPost.css";
import "../../pages/PanoPostDetail.css";

// Single-sourced from `panoNav`: the row count must equal the feed's first page or
// the skeleton reserves the wrong height (a 6-row skeleton under 20 posts jumped the
// footer ~941px, #2161).
const FEED_ROWS = PANO_FEED_PAGE_SIZE;

export function PanoFeedSkeleton() {
	return (
		<div
			className="kp-pano-list"
			role="status"
			aria-busy="true"
			aria-label="yükleniyor…"
			data-testid="pano-feed-skeleton"
		>
			{Array.from({length: FEED_ROWS}, (_, i) => (
				<article key={i} className="kp-pano-post" aria-hidden="true">
					<span className="kp-pano-post__rank">
						<Skeleton width={16} height={10} />
					</span>
					<span className="kp-pano-post__vote">
						<Skeleton width={14} height={28} />
					</span>
					<div className="kp-pano-post__body">
						<div className="kp-pano-post__title-row">
							<Skeleton width="60%" height={15} />
						</div>
						<div className="kp-pano-post__meta">
							<Skeleton width={140} height={11} />
						</div>
					</div>
				</article>
			))}
		</div>
	);
}

export function PanoPostSkeleton() {
	return (
		<div
			className="kp-pano-postpage__head"
			role="status"
			aria-busy="true"
			aria-label="yükleniyor…"
			data-testid="pano-post-skeleton"
		>
			<span className="kp-pano-post__vote" aria-hidden="true">
				<Skeleton width={16} height={30} />
			</span>
			<div aria-hidden="true">
				<Skeleton width="75%" height={20} />
				<div style={{marginTop: "var(--s-2)"}}>
					<Skeleton width="40%" height={12} />
				</div>
				<div style={{marginTop: "var(--s-2)", display: "flex", gap: 8}}>
					<Skeleton width={80} height={11} />
					<Skeleton width={60} height={11} />
					<Skeleton width={70} height={11} />
				</div>
			</div>
		</div>
	);
}
