/**
 * The domain→wire mapping `FlagsLive` hands the Flagship client (#511): `userId` becomes the
 * `targetingKey` bucketing key, roles flatten to the `|role|` string the IaC `contains` rule
 * matches, and the environment rides through. The rule evaluation itself is Flagship's; that
 * `FlagsLive` applies this mapping is `Flags.unit.test.ts`'s.
 */
import {assert, describe, it} from "@effect/vitest";
import {encodeRoles, toEvaluationContext} from "./FlagsContext.ts";

describe("toEvaluationContext — domain→wire mapping (#511)", () => {
	it("maps userId to the targetingKey bucketing key", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-1"}), {targetingKey: "u-1"});
	});

	it("flattens a role list to a delimited, contains-targetable string", () => {
		assert.strictEqual(encodeRoles(["internal", "beta"]), "|internal|beta|");
		assert.deepStrictEqual(toEvaluationContext({userId: "u-2", roles: ["internal"]}), {
			targetingKey: "u-2",
			roles: "|internal|",
		});
	});

	it("carries the environment attribute through", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-3", environment: "production"}), {
			targetingKey: "u-3",
			environment: "production",
		});
	});

	it("omits empty role lists and yields undefined for an empty context", () => {
		assert.deepStrictEqual(toEvaluationContext({userId: "u-4", roles: []}), {targetingKey: "u-4"});
		assert.strictEqual(toEvaluationContext({}), undefined);
	});
});
