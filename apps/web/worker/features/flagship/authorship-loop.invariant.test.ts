/**
 * The dark-ship default-=-safe-state invariant for the earned-authorship loop
 * (çaylak→yazar), #1204 / epic #1202. This child is the contract/SEAM only — the
 * loop's surfaces don't exist yet, so there is no gated resolver to exercise here
 * (unlike `draft-save.invariant.test.ts`'s mutation-gate proof). The single proof
 * the AC names:
 *
 *   IaC default-off — the `authorshipLoopFlag` config ships `defaultVariation:
 *   "off"` and `variations.off === false`. Inspected off the exported
 *   `AUTHORSHIP_LOOP_FLAG` record (the same object the factory spreads into
 *   `FlagshipFlag`), so no alchemy resource is constructed.
 *
 * Mirrors part (a) of `draft-save.invariant.test.ts` (#746).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {AUTHORSHIP_LOOP_FLAG, authorshipLoopFlag} from "./resources.ts";

describe("authorship loop — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.defaultVariation, "off");
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.variations.off, false);
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.variations.on, true);
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.key, "phoenix-authorship-loop");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(AUTHORSHIP_LOOP_FLAG.key, PHOENIX_AUTHORSHIP_LOOP);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof authorshipLoopFlag, "function");
	});
});
