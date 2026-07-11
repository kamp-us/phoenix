/**
 * The dark-ship default-=-safe-state invariant for the mecmua subscribed-author feed
 * flag (#2500, epic #2467). Inspected off the exported `MECMUA_FEED_FLAG` record (the
 * same object the factory spreads into `FlagshipFlag`), so no alchemy resource is
 * constructed — mirrors `mecmua-write.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {MECMUA_FEED} from "../../../src/flags/keys.ts";
import {MECMUA_FEED_FLAG, mecmuaFeedFlag} from "./resources.ts";

describe("mecmua-feed — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(MECMUA_FEED_FLAG.defaultVariation, "off");
		assert.strictEqual(MECMUA_FEED_FLAG.variations.off, false);
		assert.strictEqual(MECMUA_FEED_FLAG.variations.on, true);
		assert.strictEqual(MECMUA_FEED_FLAG.key, "mecmua-feed");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(MECMUA_FEED_FLAG.key, MECMUA_FEED);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof mecmuaFeedFlag, "function");
	});
});
