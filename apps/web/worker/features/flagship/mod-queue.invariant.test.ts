/**
 * The dark-ship default-=-safe-state invariant for the moderation-queue surface
 * (#1701). Inspected off the exported `MOD_QUEUE_FLAG` record (the same object the
 * factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `funnel-readout.invariant.test.ts` (#1589).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_MOD_QUEUE} from "../../../src/flags/keys.ts";
import {MOD_QUEUE_FLAG, modQueueFlag} from "./resources.ts";

describe("mod queue — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(MOD_QUEUE_FLAG.defaultVariation, "off");
		assert.strictEqual(MOD_QUEUE_FLAG.variations.off, false);
		assert.strictEqual(MOD_QUEUE_FLAG.variations.on, true);
		assert.strictEqual(MOD_QUEUE_FLAG.key, "phoenix-mod-queue");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(MOD_QUEUE_FLAG.key, PHOENIX_MOD_QUEUE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof modQueueFlag, "function");
	});
});
