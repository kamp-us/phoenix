import type {Freshness} from "../lib/queue.ts";
import "./FreshnessIndicator.css";

/**
 * Surfaces the API's freshness. When `stale` is true the board says so loudly so a
 * maintainer doesn't read cached data as live; when fresh it shows the fetch time
 * (once #254 provides `fetchedAt`) or just "live". Reads the already-defensive
 * `Freshness` (an absent `stale` is fresh), so it degrades to "live" today.
 */
export function FreshnessIndicator({freshness}: {freshness: Freshness}) {
	const {stale, fetchedAt} = freshness;
	const when = fetchedAt ? new Date(fetchedAt).toLocaleString() : null;
	return (
		<div className="qb-freshness" data-stale={stale} role="status" data-testid="freshness">
			<span className="qb-freshness__dot" aria-hidden="true" />
			{stale ? (
				<span>Showing stale data{when ? ` — last refreshed ${when}` : ""}</span>
			) : (
				<span>Live{when ? ` — fetched ${when}` : ""}</span>
			)}
		</div>
	);
}
