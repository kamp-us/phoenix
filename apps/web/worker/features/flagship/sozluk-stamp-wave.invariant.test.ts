/**
 * The dark-ship default-=-safe-state invariant for the sözlük parallel-stamp-wave
 * read collapse (#2709, epic #2567). Inspected off the exported `SOZLUK_STAMP_WAVE_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `funnel-readout.invariant.test.ts`.
 *
 * Load-bearing: with the default OFF the definition reads run their stamp wave at
 * `concurrency: 1` (serial, byte-for-byte today) — so the containment is real, the
 * concurrent wave only reachable after a human flips the flag.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_SOZLUK_STAMP_WAVE} from "../../../src/flags/keys.ts";
import {SOZLUK_STAMP_WAVE_FLAG, sozlukStampWaveFlag} from "./resources.ts";

describe("sözlük stamp wave — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(SOZLUK_STAMP_WAVE_FLAG.defaultVariation, "off");
		assert.strictEqual(SOZLUK_STAMP_WAVE_FLAG.variations.off, false);
		assert.strictEqual(SOZLUK_STAMP_WAVE_FLAG.variations.on, true);
		assert.strictEqual(SOZLUK_STAMP_WAVE_FLAG.key, "phoenix-sozluk-stamp-wave");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(SOZLUK_STAMP_WAVE_FLAG.key, PHOENIX_SOZLUK_STAMP_WAVE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof sozlukStampWaveFlag, "function");
	});
});
