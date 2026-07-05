/**
 * The build-time-verify guard for the Analytics Engine seam (ADR 0153's grounding
 * mandate, kept as a permanent CI test — not a one-off plan-time spike).
 *
 * ADR 0153 requires confirming the *pinned* alchemy (`2.0.0-beta.59`,
 * `pnpm-workspace.yaml`) actually exports `Cloudflare.AnalyticsEngine.Dataset` /
 * `WriteDataset`. The SPIKE resolved native at plan time; this test freezes that
 * resolution so a future alchemy bump that drops or renames the export fails HERE,
 * in CI, instead of in a prod deploy. If it ever goes red, the fix is the
 * `host.bind` fallback (identical wire contract,
 * `{ bindings: [{ type: "analytics_engine", name, dataset }] }`), re-opened as
 * follow-up — never silent breakage (ADR 0153 §Consequences).
 */
import {assert, describe, it} from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";

describe("ADR 0153 build-time-verify — pinned alchemy exports the AE seam natively", () => {
	it("Cloudflare.AnalyticsEngine.Dataset is a callable resource factory", () => {
		assert.strictEqual(typeof Cloudflare.AnalyticsEngine.Dataset, "function");
	});

	it("Cloudflare.AnalyticsEngine.WriteDataset is a callable binding alias", () => {
		assert.strictEqual(typeof Cloudflare.AnalyticsEngine.WriteDataset, "function");
	});
});
