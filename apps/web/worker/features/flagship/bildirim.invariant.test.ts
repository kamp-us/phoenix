/**
 * The dark-ship default-=-safe-state invariant for the bildirim (notification
 * system) flag (#1694, epic #1666). Inspected off the exported `BILDIRIM_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `funnel-readout.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_BILDIRIM} from "../../../src/flags/keys.ts";
import {BILDIRIM_FLAG, bildirimFlag} from "./resources.ts";

describe("bildirim — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(BILDIRIM_FLAG.defaultVariation, "off");
		assert.strictEqual(BILDIRIM_FLAG.variations.off, false);
		assert.strictEqual(BILDIRIM_FLAG.variations.on, true);
		assert.strictEqual(BILDIRIM_FLAG.key, "phoenix-bildirim");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(BILDIRIM_FLAG.key, PHOENIX_BILDIRIM);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof bildirimFlag, "function");
	});
});
