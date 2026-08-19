/**
 * The dark-ship default-is-the-safe-state invariant for the profile canvas flag (#3103).
 * Inspected off the exported record the factory spreads into `FlagshipFlag`, so no
 * alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {PROFILE_CANVAS} from "../../../src/flags/keys.ts";
import {PROFILE_CANVAS_FLAG, profileCanvasFlag} from "./resources.ts";

describe("profile-canvas — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PROFILE_CANVAS_FLAG.defaultVariation, "off");
		assert.strictEqual(PROFILE_CANVAS_FLAG.variations.off, false);
		assert.strictEqual(PROFILE_CANVAS_FLAG.variations.on, true);
		assert.strictEqual(PROFILE_CANVAS_FLAG.key, "profile-canvas");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PROFILE_CANVAS_FLAG.key, PROFILE_CANVAS);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof profileCanvasFlag, "function");
	});
});
