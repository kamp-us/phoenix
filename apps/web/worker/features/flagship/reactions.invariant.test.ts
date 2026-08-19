/**
 * The dark-ship default-is-safe-state invariant for reactions. Inspected off the exported
 * `REACTIONS_FLAG` record, so no alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_REACTIONS} from "../../../src/flags/keys.ts";
import {REACTIONS_FLAG, reactionsFlag} from "./resources.ts";

describe("reactions — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(REACTIONS_FLAG.defaultVariation, "off");
		assert.strictEqual(REACTIONS_FLAG.variations.off, false);
		assert.strictEqual(REACTIONS_FLAG.variations.on, true);
		assert.strictEqual(REACTIONS_FLAG.key, "phoenix-reactions");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(REACTIONS_FLAG.key, PHOENIX_REACTIONS);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof reactionsFlag, "function");
	});
});
