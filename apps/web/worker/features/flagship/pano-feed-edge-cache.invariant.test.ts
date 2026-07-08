/**
 * The dark-ship default-=-safe-state invariant for the base-feed edge-cache (#2324,
 * epic #2316 leg B, ADR 0170). Inspected off the exported `PANO_FEED_EDGE_CACHE_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `pano-base-feed.invariant.test.ts`. Off ⇒ no cache
 * headers, no purge (AC#5), so default-off IS the containment guarantee.
 */
import {assert, describe, it} from "@effect/vitest";
import {PANO_FEED_EDGE_CACHE} from "../../../src/flags/keys.ts";
import {PANO_FEED_EDGE_CACHE_FLAG, panoFeedEdgeCacheFlag} from "./resources.ts";

describe("pano feed edge cache — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_FEED_EDGE_CACHE_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_FEED_EDGE_CACHE_FLAG.variations.off, false);
		assert.strictEqual(PANO_FEED_EDGE_CACHE_FLAG.variations.on, true);
		assert.strictEqual(PANO_FEED_EDGE_CACHE_FLAG.key, "pano-feed-edge-cache");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_FEED_EDGE_CACHE_FLAG.key, PANO_FEED_EDGE_CACHE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoFeedEdgeCacheFlag, "function");
	});
});
