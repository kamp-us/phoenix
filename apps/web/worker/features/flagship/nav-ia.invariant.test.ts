/**
 * The dark-ship default-=-safe-state invariant for the nav-IA per-product Subnav zones
 * flag (#2598, epic #2596). Inspected off the exported `NAV_IA_FLAG` record (the same
 * object the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `mecmua-public-read.invariant.test.ts` (#2498).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_NAV_IA} from "../../../src/flags/keys.ts";
import {NAV_IA_FLAG, navIaFlag} from "./resources.ts";

describe("nav-IA per-product Subnav zones — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(NAV_IA_FLAG.defaultVariation, "off");
		assert.strictEqual(NAV_IA_FLAG.variations.off, false);
		assert.strictEqual(NAV_IA_FLAG.variations.on, true);
		assert.strictEqual(NAV_IA_FLAG.key, "phoenix-nav-ia");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(NAV_IA_FLAG.key, PHOENIX_NAV_IA);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof navIaFlag, "function");
	});
});
