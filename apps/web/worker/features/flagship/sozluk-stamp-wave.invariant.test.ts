/**
 * The dark-ship default-is-the-safe-state invariant for the sözlük stamp wave.
 * Inspected off the exported flag record, so no alchemy resource is constructed.
 *
 * With the default OFF the definition reads stay serial, so the concurrent wave is
 * reachable only after a human flips the flag.
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
