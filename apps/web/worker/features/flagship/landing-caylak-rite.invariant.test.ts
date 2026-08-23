/**
 * The dark-ship default-=-safe-state invariant for the signed-in-çaylak landing-rite flag
 * (#7046, epic #4304). Inspected off the exported `LANDING_CAYLAK_RITE_FLAG` record (the same
 * object the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `caylak-visibility.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_LANDING_CAYLAK_RITE} from "../../../src/flags/keys.ts";
import {LANDING_CAYLAK_RITE_FLAG, landingCaylakRiteFlag} from "./resources.ts";

describe("landing-caylak-rite — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(LANDING_CAYLAK_RITE_FLAG.defaultVariation, "off");
		assert.strictEqual(LANDING_CAYLAK_RITE_FLAG.variations.off, false);
		assert.strictEqual(LANDING_CAYLAK_RITE_FLAG.variations.on, true);
		assert.strictEqual(LANDING_CAYLAK_RITE_FLAG.key, "phoenix-landing-caylak-rite");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(LANDING_CAYLAK_RITE_FLAG.key, PHOENIX_LANDING_CAYLAK_RITE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof landingCaylakRiteFlag, "function");
	});
});
