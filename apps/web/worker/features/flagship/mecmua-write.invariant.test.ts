/**
 * The dark-ship default-=-safe-state invariant for the mecmua write-path flag
 * (#2497, epic #2467). Inspected off the exported `MECMUA_WRITE_FLAG` record (the
 * same object the factory spreads into `FlagshipFlag`), so no alchemy resource is
 * constructed — mirrors `bildirim.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {MECMUA_WRITE} from "../../../src/flags/keys.ts";
import {MECMUA_WRITE_FLAG, mecmuaWriteFlag} from "./resources.ts";

describe("mecmua-write — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(MECMUA_WRITE_FLAG.defaultVariation, "off");
		assert.strictEqual(MECMUA_WRITE_FLAG.variations.off, false);
		assert.strictEqual(MECMUA_WRITE_FLAG.variations.on, true);
		assert.strictEqual(MECMUA_WRITE_FLAG.key, "mecmua-write");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(MECMUA_WRITE_FLAG.key, MECMUA_WRITE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof mecmuaWriteFlag, "function");
	});
});
