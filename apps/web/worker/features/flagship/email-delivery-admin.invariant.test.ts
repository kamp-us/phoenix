/**
 * The dark-ship default-=-safe-state invariant for the admin email-delivery
 * (failing-address) surface (#2692, epic #2687). Inspected off the exported
 * `EMAIL_DELIVERY_ADMIN_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors `mod-queue.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_EMAIL_DELIVERY_ADMIN} from "../../../src/flags/keys.ts";
import {EMAIL_DELIVERY_ADMIN_FLAG, emailDeliveryAdminFlag} from "./resources.ts";

describe("admin email-delivery surface — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(EMAIL_DELIVERY_ADMIN_FLAG.defaultVariation, "off");
		assert.strictEqual(EMAIL_DELIVERY_ADMIN_FLAG.variations.off, false);
		assert.strictEqual(EMAIL_DELIVERY_ADMIN_FLAG.variations.on, true);
		assert.strictEqual(EMAIL_DELIVERY_ADMIN_FLAG.key, "phoenix-email-delivery-admin");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(EMAIL_DELIVERY_ADMIN_FLAG.key, PHOENIX_EMAIL_DELIVERY_ADMIN);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof emailDeliveryAdminFlag, "function");
	});
});
