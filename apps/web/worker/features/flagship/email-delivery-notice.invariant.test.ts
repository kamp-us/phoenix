/**
 * The dark-ship default-=-safe-state invariant for the member email-delivery membrane
 * notice (#2693, worker enabler #2730, epic #2687). Inspected off the exported
 * `EMAIL_DELIVERY_NOTICE_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors `email-delivery-admin.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_EMAIL_DELIVERY_NOTICE} from "../../../src/flags/keys.ts";
import {EMAIL_DELIVERY_NOTICE_FLAG, emailDeliveryNoticeFlag} from "./resources.ts";

describe("member email-delivery notice — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(EMAIL_DELIVERY_NOTICE_FLAG.defaultVariation, "off");
		assert.strictEqual(EMAIL_DELIVERY_NOTICE_FLAG.variations.off, false);
		assert.strictEqual(EMAIL_DELIVERY_NOTICE_FLAG.variations.on, true);
		assert.strictEqual(EMAIL_DELIVERY_NOTICE_FLAG.key, "phoenix-email-delivery-notice");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(EMAIL_DELIVERY_NOTICE_FLAG.key, PHOENIX_EMAIL_DELIVERY_NOTICE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof emailDeliveryNoticeFlag, "function");
	});
});
