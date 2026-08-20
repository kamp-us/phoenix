/**
 * The dark-ship default-is-the-safe-state invariant for the member-mute (sustur) flag
 * (#3112). Inspected off the exported record the factory spreads into `FlagshipFlag`, so
 * no alchemy resource is constructed.
 */
import {assert, describe, it} from "@effect/vitest";
import {MEMBER_MUTE} from "../../../src/flags/keys.ts";
import {MEMBER_MUTE_FLAG, memberMuteFlag} from "./resources.ts";

describe("member-mute — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(MEMBER_MUTE_FLAG.defaultVariation, "off");
		assert.strictEqual(MEMBER_MUTE_FLAG.variations.off, false);
		assert.strictEqual(MEMBER_MUTE_FLAG.variations.on, true);
		assert.strictEqual(MEMBER_MUTE_FLAG.key, "member-mute");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(MEMBER_MUTE_FLAG.key, MEMBER_MUTE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof memberMuteFlag, "function");
	});
});
