/**
 * The dark-ship default-=-safe-state invariant for the çaylak in-place visibility flag
 * (#6421, epic #4306). Inspected off the exported `CAYLAK_VISIBILITY_FLAG` record (the same
 * object the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `member-mute.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_CAYLAK_VISIBILITY} from "../../../src/flags/keys.ts";
import {CAYLAK_VISIBILITY_FLAG, caylakVisibilityFlag} from "./resources.ts";

describe("caylak-visibility — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(CAYLAK_VISIBILITY_FLAG.defaultVariation, "off");
		assert.strictEqual(CAYLAK_VISIBILITY_FLAG.variations.off, false);
		assert.strictEqual(CAYLAK_VISIBILITY_FLAG.variations.on, true);
		assert.strictEqual(CAYLAK_VISIBILITY_FLAG.key, "phoenix-caylak-visibility");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(CAYLAK_VISIBILITY_FLAG.key, PHOENIX_CAYLAK_VISIBILITY);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof caylakVisibilityFlag, "function");
	});
});
