/**
 * Layout-preserving loading placeholders for the pano surfaces, composed from the
 * shared `Skeleton` atom (the same primitive the sözlük skeleton uses — #1633/#1636).
 * Each mirrors the real DOM shape (feed row grid / post-detail header) so content
 * arrival swaps in without a layout jump.
 */
import {Skeleton} from "../ui/atoms";
import "./PanoPost.css";
import "../../pages/PanoPostDetail.css";

const FEED_ROWS = 6;

/** Feed-row skeleton — mirrors `PanoPostCard`'s [rank | vote | body] grid. */
export function PanoFeedSkeleton() {
	return (
		<div className="kp-pano-list" aria-hidden="true" data-testid="pano-feed-skeleton">
			{Array.from({length: FEED_ROWS}, (_, i) => (
				<article key={i} className="kp-pano-post">
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

/** Post-detail skeleton — mirrors the `kp-pano-postpage__head` title/url/meta stack. */
export function PanoPostSkeleton() {
	return (
		<div className="kp-pano-postpage__head" aria-hidden="true" data-testid="pano-post-skeleton">
			<span className="kp-pano-post__vote">
				<Skeleton width={16} height={30} />
			</span>
			<div>
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
