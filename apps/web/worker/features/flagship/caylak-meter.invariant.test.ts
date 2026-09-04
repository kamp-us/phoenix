/**
 * The dark-ship default-=-safe-state invariant for the ambient-çaylak-meter flag (#7045, epic
 * #4304). Inspected off the exported `CAYLAK_METER_FLAG` record (the same object the factory
 * spreads into `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `welcome.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_CAYLAK_METER} from "../../../src/flags/keys.ts";
import {CAYLAK_METER_FLAG, caylakMeterFlag} from "./resources.ts";

describe("çaylak meter — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(CAYLAK_METER_FLAG.defaultVariation, "off");
		assert.strictEqual(CAYLAK_METER_FLAG.variations.off, false);
		assert.strictEqual(CAYLAK_METER_FLAG.variations.on, true);
		assert.strictEqual(CAYLAK_METER_FLAG.key, "phoenix-caylak-meter");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(CAYLAK_METER_FLAG.key, PHOENIX_CAYLAK_METER);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof caylakMeterFlag, "function");
	});
});
