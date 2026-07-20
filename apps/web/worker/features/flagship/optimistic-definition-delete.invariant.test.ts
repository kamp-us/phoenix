/**
 * The dark-ship default-=-safe-state invariant for the optimistic `definition.delete`
 * flag (#1681, epic #1637, ADR 0125 D1). Inspected off the exported
 * `OPTIMISTIC_DEFINITION_DELETE_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `member-mute.invariant.test.ts` (#3112).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_OPTIMISTIC_DEFINITION_DELETE} from "../../../src/flags/keys.ts";
import {OPTIMISTIC_DEFINITION_DELETE_FLAG, optimisticDefinitionDeleteFlag} from "./resources.ts";

describe("optimistic definition.delete — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(OPTIMISTIC_DEFINITION_DELETE_FLAG.defaultVariation, "off");
		assert.strictEqual(OPTIMISTIC_DEFINITION_DELETE_FLAG.variations.off, false);
		assert.strictEqual(OPTIMISTIC_DEFINITION_DELETE_FLAG.variations.on, true);
		assert.strictEqual(
			OPTIMISTIC_DEFINITION_DELETE_FLAG.key,
			"phoenix-optimistic-definition-delete",
		);
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(OPTIMISTIC_DEFINITION_DELETE_FLAG.key, PHOENIX_OPTIMISTIC_DEFINITION_DELETE);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof optimisticDefinitionDeleteFlag, "function");
	});
});
