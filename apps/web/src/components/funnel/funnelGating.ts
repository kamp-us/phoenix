/**
 * The funnel-readout surface's render decision, factored DOM-free so it is
 * unit-testable without a DOM/React runtime — the pure-extraction idiom of
 * `divanGating` / `flagGateChild` (`apps/web/src` has no jsdom). The funnel readout
 * (#1589) is the founder/mod conversion-metrics surface, shipped dark behind the
 * `phoenix-funnel-readout` flag.
 *
 * Access itself is SERVER-authoritative — the gated `funnel.summary` read denies a
 * non-mod the invisible `UNAUTHORIZED` (`requireFunnelAccess`). This gate only
 * decides the flag-off dark-ship: with the flag off the route renders the 404, so
 * the surface is effectively absent until a human release.
 */

/**
 * Show the `/funnel` page content iff the readout flag is on. Off (and every flag
 * failure mode — loading/error/undeclared all resolve to `false` upstream) renders
 * the 404, so with the flag off the route is effectively absent.
 */
export function shouldRenderFunnelPage(flagOn: boolean): boolean {
	return flagOn;
}
