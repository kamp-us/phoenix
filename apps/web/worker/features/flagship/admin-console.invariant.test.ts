/**
 * The dark-ship default-=-safe-state invariant for the admin-console shell (#2740,
 * epic #2711). Inspected off the exported `ADMIN_CONSOLE_FLAG` record (the same object
 * the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `email-delivery-admin.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_ADMIN_CONSOLE} from "../../../src/flags/keys.ts";
import {ADMIN_CONSOLE_FLAG, adminConsoleFlag} from "./resources.ts";

describe("admin-console shell — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(ADMIN_CONSOLE_FLAG.defaultVariation, "off");
		assert.strictEqual(ADMIN_CONSOLE_FLAG.variations.off, false);
		assert.strictEqual(ADMIN_CONSOLE_FLAG.variations.on, true);
		assert.strictEqual(ADMIN_CONSOLE_FLAG.key, "phoenix-admin-console");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(ADMIN_CONSOLE_FLAG.key, PHOENIX_ADMIN_CONSOLE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof adminConsoleFlag, "function");
	});
});
