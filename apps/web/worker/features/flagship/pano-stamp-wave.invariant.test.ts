/**
 * The dark-ship default-=-safe-state invariant for the pano parallel-stamp-wave read
 * collapse (#2710, epic #2567). Inspected off the exported `PANO_STAMP_WAVE_FLAG` record
 * (the same object the factory spreads into `FlagshipFlag`), so no alchemy resource is
 * constructed — mirrors `sozluk-stamp-wave.invariant.test.ts`.
 *
 * Load-bearing: with the default OFF the pano thread/comment reads run their stamp wave at
 * `concurrency: 1` (serial, byte-for-byte today) — so the containment is real, the
 * concurrent wave only reachable after a human flips the flag.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_PANO_STAMP_WAVE} from "../../../src/flags/keys.ts";
import {PANO_STAMP_WAVE_FLAG, panoStampWaveFlag} from "./resources.ts";

describe("pano stamp wave — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_STAMP_WAVE_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_STAMP_WAVE_FLAG.variations.off, false);
		assert.strictEqual(PANO_STAMP_WAVE_FLAG.variations.on, true);
		assert.strictEqual(PANO_STAMP_WAVE_FLAG.key, "phoenix-pano-stamp-wave");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_STAMP_WAVE_FLAG.key, PHOENIX_PANO_STAMP_WAVE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoStampWaveFlag, "function");
	});
});
