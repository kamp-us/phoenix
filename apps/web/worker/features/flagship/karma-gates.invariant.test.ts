/**
 * The dark-ship default-is-the-safe-state invariant for the karma-gated privileges
 * feature (#150). Inspected off the exported record rather than the factory, so no
 * alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_KARMA_GATES} from "../../../src/flags/keys.ts";
import {KARMA_GATES_FLAG, karmaGatesFlag} from "./resources.ts";

describe("karma-gates — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(KARMA_GATES_FLAG.defaultVariation, "off");
		assert.strictEqual(KARMA_GATES_FLAG.variations.off, false);
		assert.strictEqual(KARMA_GATES_FLAG.variations.on, true);
		assert.strictEqual(KARMA_GATES_FLAG.key, "phoenix-karma-gates");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(KARMA_GATES_FLAG.key, PHOENIX_KARMA_GATES);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof karmaGatesFlag, "function");
	});
});
