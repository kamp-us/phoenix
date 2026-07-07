/**
 * The dark-ship default-=-safe-state invariant for the base-feed / viewer-overlay
 * split (#2322, epic #2316 leg B). Inspected off the exported `PANO_BASE_FEED_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `funnel-readout.invariant.test.ts` (#1589).
 */
import {assert, describe, it} from "@effect/vitest";
import {PANO_BASE_FEED} from "../../../src/flags/keys.ts";
import {PANO_BASE_FEED_FLAG, panoBaseFeedFlag} from "./resources.ts";

describe("pano base feed — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_BASE_FEED_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_BASE_FEED_FLAG.variations.off, false);
		assert.strictEqual(PANO_BASE_FEED_FLAG.variations.on, true);
		assert.strictEqual(PANO_BASE_FEED_FLAG.key, "pano-base-feed");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_BASE_FEED_FLAG.key, PANO_BASE_FEED);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoBaseFeedFlag, "function");
	});
});
