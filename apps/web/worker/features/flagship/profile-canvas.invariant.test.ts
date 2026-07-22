/**
 * The dark-ship default-=-safe-state invariant for the profile free-paint canvas (duvar)
 * flag (#3103, epic #2035). Inspected off the exported `PROFILE_CANVAS_FLAG` record (the
 * same object the factory spreads into `FlagshipFlag`), so no alchemy resource is
 * constructed — mirrors `member-mute.invariant.test.ts` (#3112). Off ⇒ the profile is
 * exactly as today (no canvas surface, owner-only mutations denied).
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
