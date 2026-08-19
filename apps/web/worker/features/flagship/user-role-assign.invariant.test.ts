/**
 * The dark-ship default-is-the-safe-state invariant for the platform role-assign surface
 * (#3522). Inspected off the exported record rather than the factory, so no alchemy
 * resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_USER_ROLE_ASSIGN} from "../../../src/flags/keys.ts";
import {USER_ROLE_ASSIGN_FLAG, userRoleAssignFlag} from "./resources.ts";

describe("platform role-assign surface — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(USER_ROLE_ASSIGN_FLAG.defaultVariation, "off");
		assert.strictEqual(USER_ROLE_ASSIGN_FLAG.variations.off, false);
		assert.strictEqual(USER_ROLE_ASSIGN_FLAG.variations.on, true);
		assert.strictEqual(USER_ROLE_ASSIGN_FLAG.key, "phoenix-user-role-assign");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(USER_ROLE_ASSIGN_FLAG.key, PHOENIX_USER_ROLE_ASSIGN);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof userRoleAssignFlag, "function");
	});
});
