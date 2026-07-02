/**
 * The dark-ship default-=-safe-state invariant for the optimistic in-place
 * content-edit flag (#1675, epic #1637). Inspected off the exported
 * `OPTIMISTIC_EDITS_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `funnel-readout.invariant.test.ts` (#1589).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_OPTIMISTIC_EDITS} from "../../../src/flags/keys.ts";
import {OPTIMISTIC_EDITS_FLAG, optimisticEditsFlag} from "./resources.ts";

describe("optimistic edits — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(OPTIMISTIC_EDITS_FLAG.defaultVariation, "off");
		assert.strictEqual(OPTIMISTIC_EDITS_FLAG.variations.off, false);
		assert.strictEqual(OPTIMISTIC_EDITS_FLAG.variations.on, true);
		assert.strictEqual(OPTIMISTIC_EDITS_FLAG.key, "phoenix-optimistic-edits");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(OPTIMISTIC_EDITS_FLAG.key, PHOENIX_OPTIMISTIC_EDITS);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof optimisticEditsFlag, "function");
	});
});
