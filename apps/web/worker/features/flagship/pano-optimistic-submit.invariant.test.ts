/**
 * The dark-ship default-=-safe-state invariant for the optimistic `post.submit`
 * containment flag (#1676, epic #1637). Inspected off the exported
 * `PANO_OPTIMISTIC_SUBMIT_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `funnel-readout.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PANO_OPTIMISTIC_SUBMIT} from "../../../src/flags/keys.ts";
import {PANO_OPTIMISTIC_SUBMIT_FLAG, panoOptimisticSubmitFlag} from "./resources.ts";

describe("optimistic post.submit — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_OPTIMISTIC_SUBMIT_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_OPTIMISTIC_SUBMIT_FLAG.variations.off, false);
		assert.strictEqual(PANO_OPTIMISTIC_SUBMIT_FLAG.variations.on, true);
		assert.strictEqual(PANO_OPTIMISTIC_SUBMIT_FLAG.key, "pano-optimistic-submit");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_OPTIMISTIC_SUBMIT_FLAG.key, PANO_OPTIMISTIC_SUBMIT);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoOptimisticSubmitFlag, "function");
	});
});
