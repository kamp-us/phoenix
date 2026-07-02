/**
 * The dark-ship default-=-safe-state invariant for the optimistic post-delete flag
 * (#1677, epic #1637). Inspected off the exported `PANO_OPTIMISTIC_POST_DELETE_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `funnel-readout.invariant.test.ts` (#1589).
 */
import {assert, describe, it} from "@effect/vitest";
import {PANO_OPTIMISTIC_POST_DELETE} from "../../../src/flags/keys.ts";
import {PANO_OPTIMISTIC_POST_DELETE_FLAG, panoOptimisticPostDeleteFlag} from "./resources.ts";

describe("optimistic post-delete — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_OPTIMISTIC_POST_DELETE_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_OPTIMISTIC_POST_DELETE_FLAG.variations.off, false);
		assert.strictEqual(PANO_OPTIMISTIC_POST_DELETE_FLAG.variations.on, true);
		assert.strictEqual(PANO_OPTIMISTIC_POST_DELETE_FLAG.key, "pano-optimistic-post-delete");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_OPTIMISTIC_POST_DELETE_FLAG.key, PANO_OPTIMISTIC_POST_DELETE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoOptimisticPostDeleteFlag, "function");
	});
});
