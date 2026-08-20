/**
 * The dark-ship default-is-the-safe-state invariant for mecmua public read (#2498).
 * Inspected off the exported record, so no alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {MECMUA_PUBLIC_READ} from "../../../src/flags/keys.ts";
import {MECMUA_PUBLIC_READ_FLAG, mecmuaPublicReadFlag} from "./resources.ts";

describe("mecmua public read — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(MECMUA_PUBLIC_READ_FLAG.defaultVariation, "off");
		assert.strictEqual(MECMUA_PUBLIC_READ_FLAG.variations.off, false);
		assert.strictEqual(MECMUA_PUBLIC_READ_FLAG.variations.on, true);
		assert.strictEqual(MECMUA_PUBLIC_READ_FLAG.key, "mecmua-public-read");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(MECMUA_PUBLIC_READ_FLAG.key, MECMUA_PUBLIC_READ);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof mecmuaPublicReadFlag, "function");
	});
});
