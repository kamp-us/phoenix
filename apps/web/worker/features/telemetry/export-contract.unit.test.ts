/**
 * Freezes the fact that the pinned alchemy really exports
 * `Cloudflare.AnalyticsEngine.Dataset` / `WriteDataset`, so a future bump that drops
 * or renames it fails HERE rather than in a prod deploy.
 *
 * If it goes red, the fix is the `host.bind` fallback — identical wire contract,
 * `{bindings: [{type: "analytics_engine", name, dataset}]}` — reopened as follow-up,
 * never silent breakage (ADR 0153 §Consequences).
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
