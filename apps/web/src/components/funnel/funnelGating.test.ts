/**
 * The funnel-readout surface's gating contract (#1589) — the pure render decision
 * asserted without a DOM (the `divanGating.test.ts` idiom; `apps/web/src` has no
 * jsdom). The AC the surface lives or dies on: flag-off ⇒ the route renders the 404
 * (effectively absent), so nothing leaks with the flag off.
 */
import {describe, expect, it} from "vitest";
import {shouldRenderFunnelPage} from "./funnelGating";

describe("shouldRenderFunnelPage — the flag-gated route", () => {
	it("renders the page when the readout flag is on", () => {
		expect(shouldRenderFunnelPage(true)).toBe(true);
	});

	it("renders the 404 (route absent) when the flag is off", () => {
		// loading / fetch-error / undeclared all resolve to `false` upstream, so the
		// off case covers every non-on flag state.
		expect(shouldRenderFunnelPage(false)).toBe(false);
	});
});
