/**
 * The dark-ship default-=-safe-state invariant for the optimistic `definition.add`
 * flag (#1679, epic #1637, ADR 0125). Inspected off the exported
 * `OPTIMISTIC_DEFINITION_ADD_FLAG` record (the same object the factory spreads into
 * `FlagshipFlag`), so no alchemy resource is constructed — mirrors
 * `optimistic-edits.invariant.test.ts` (#1675).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_OPTIMISTIC_DEFINITION_ADD} from "../../../src/flags/keys.ts";
import {OPTIMISTIC_DEFINITION_ADD_FLAG, optimisticDefinitionAddFlag} from "./resources.ts";

describe("optimistic definition.add — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(OPTIMISTIC_DEFINITION_ADD_FLAG.defaultVariation, "off");
		assert.strictEqual(OPTIMISTIC_DEFINITION_ADD_FLAG.variations.off, false);
		assert.strictEqual(OPTIMISTIC_DEFINITION_ADD_FLAG.variations.on, true);
		assert.strictEqual(OPTIMISTIC_DEFINITION_ADD_FLAG.key, "phoenix-optimistic-definition-add");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(OPTIMISTIC_DEFINITION_ADD_FLAG.key, PHOENIX_OPTIMISTIC_DEFINITION_ADD);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof optimisticDefinitionAddFlag, "function");
	});
});
