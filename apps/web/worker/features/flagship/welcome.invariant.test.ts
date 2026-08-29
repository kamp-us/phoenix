/**
 * The dark-ship default-=-safe-state invariant for the welcome-arrival flag (#7043, epic
 * #4304). Inspected off the exported `WELCOME_FLAG` record (the same object the factory
 * spreads into `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `caylak-visibility.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_WELCOME} from "../../../src/flags/keys.ts";
import {WELCOME_FLAG, welcomeFlag} from "./resources.ts";

describe("welcome — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(WELCOME_FLAG.defaultVariation, "off");
		assert.strictEqual(WELCOME_FLAG.variations.off, false);
		assert.strictEqual(WELCOME_FLAG.variations.on, true);
		assert.strictEqual(WELCOME_FLAG.key, "phoenix-welcome");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(WELCOME_FLAG.key, PHOENIX_WELCOME);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof welcomeFlag, "function");
	});
});
