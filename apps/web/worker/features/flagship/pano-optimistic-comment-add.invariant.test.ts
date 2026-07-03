/**
 * The dark-ship default-=-safe-state invariant for the optimistic comment-add flag
 * (#1678, epic #1637). Inspected off the exported `PANO_OPTIMISTIC_COMMENT_ADD_FLAG`
 * record (the same object the factory spreads into `FlagshipFlag`), so no alchemy
 * resource is constructed — mirrors `pano-optimistic-post-delete.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {PANO_OPTIMISTIC_COMMENT_ADD} from "../../../src/flags/keys.ts";
import {PANO_OPTIMISTIC_COMMENT_ADD_FLAG, panoOptimisticCommentAddFlag} from "./resources.ts";

describe("optimistic comment-add — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(PANO_OPTIMISTIC_COMMENT_ADD_FLAG.defaultVariation, "off");
		assert.strictEqual(PANO_OPTIMISTIC_COMMENT_ADD_FLAG.variations.off, false);
		assert.strictEqual(PANO_OPTIMISTIC_COMMENT_ADD_FLAG.variations.on, true);
		assert.strictEqual(PANO_OPTIMISTIC_COMMENT_ADD_FLAG.key, "pano-optimistic-comment-add");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(PANO_OPTIMISTIC_COMMENT_ADD_FLAG.key, PANO_OPTIMISTIC_COMMENT_ADD);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof panoOptimisticCommentAddFlag, "function");
	});
});
