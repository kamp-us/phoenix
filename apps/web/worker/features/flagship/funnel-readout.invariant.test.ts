/**
 * The dark-ship default-=-safe-state invariant for the conversion-funnel readout
 * (#1589). Inspected off the exported `FUNNEL_READOUT_FLAG` record (the same object
 * the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `authorship-loop.invariant.test.ts` (#1204).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_FUNNEL_READOUT} from "../../../src/flags/keys.ts";
import {FUNNEL_READOUT_FLAG, funnelReadoutFlag} from "./resources.ts";

describe("funnel readout — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(FUNNEL_READOUT_FLAG.defaultVariation, "off");
		assert.strictEqual(FUNNEL_READOUT_FLAG.variations.off, false);
		assert.strictEqual(FUNNEL_READOUT_FLAG.variations.on, true);
		assert.strictEqual(FUNNEL_READOUT_FLAG.key, "phoenix-funnel-readout");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(FUNNEL_READOUT_FLAG.key, PHOENIX_FUNNEL_READOUT);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof funnelReadoutFlag, "function");
	});
});
