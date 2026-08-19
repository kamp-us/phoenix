/**
 * The dark-ship default-=-safe-state invariant for the kullanıcılar read view (#3200).
 * Inspected off the exported record, so no alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_USER_ADMIN} from "../../../src/flags/keys.ts";
import {USER_ADMIN_FLAG, userAdminFlag} from "./resources.ts";

describe("kullanıcılar read view — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(USER_ADMIN_FLAG.defaultVariation, "off");
		assert.strictEqual(USER_ADMIN_FLAG.variations.off, false);
		assert.strictEqual(USER_ADMIN_FLAG.variations.on, true);
		assert.strictEqual(USER_ADMIN_FLAG.key, "phoenix-user-admin");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(USER_ADMIN_FLAG.key, PHOENIX_USER_ADMIN);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof userAdminFlag, "function");
	});
});
