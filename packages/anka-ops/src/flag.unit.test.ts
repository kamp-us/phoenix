/**
 * The `flag` verb group's pure adapter — the operator-verb → serving-lever mapping (#3133). The
 * load-bearing contract: `open`/`close` map onto the EXACT `ServeTarget` levers (100%
 * no-match split / kill) so no serving-plan math is duplicated, and `graduate` only greenlights a
 * flag fully open in prod. No IO: the mapping is a pure value, the graduate decision a pure fold
 * over already-listed `FlagState` rows.
 */

import {assert, describe, it} from "@effect/vitest";
import {
	decideGraduate,
	GRADUATE_ENV,
	type ReleaseVerb,
	releaseVerbToTarget,
	renderRetirementChore,
} from "./flag.ts";
import type {EffectiveServing, FlagState} from "./flagship-core.ts";

const split = (percentage: number): EffectiveServing => ({
	_tag: "Split",
	variation: "on",
	percentage,
	otherRules: 0,
});
const defaultServing = (variation: string): EffectiveServing => ({
	_tag: "Default",
	variation,
	otherRules: 0,
});

const state = (env: string, serving: EffectiveServing): FlagState => ({
	key: "authorship-loop",
	env,
	enabled: true,
	defaultVariation: "off",
	defaultValue: false,
	serving,
});

describe("releaseVerbToTarget — verb → serving lever", () => {
	it("open maps onto the 100% no-match split", () => {
		assert.deepStrictEqual(releaseVerbToTarget("open"), {_tag: "Percent", percentage: 100});
	});

	it("close maps onto the kill lever (clear the split + default off)", () => {
		assert.deepStrictEqual(releaseVerbToTarget("close"), {_tag: "Kill"});
	});

	it("never emits a defaultVariation-flip lever — open is a Percent split, not a Default write", () => {
		const openTarget = releaseVerbToTarget("open");
		assert.strictEqual(openTarget._tag, "Percent");
	});

	for (const verb of ["open", "close"] as const satisfies ReadonlyArray<ReleaseVerb>) {
		it(`${verb} yields a total ServeTarget the Flagship core consumes`, () => {
			const target = releaseVerbToTarget(verb);
			assert.oneOf(target._tag, ["Percent", "Kill"]);
		});
	}
});

describe("decideGraduate — retirement-trigger eligibility (prod fully open)", () => {
	it("is Eligible when prod serves a full 100% split", () => {
		const decision = decideGraduate({
			key: "authorship-loop",
			states: [state("pr-42", split(100)), state(GRADUATE_ENV, split(100))],
		});
		assert.strictEqual(decision._tag, "Eligible");
	});

	it("is Ineligible when prod is still ramping (< 100%)", () => {
		const decision = decideGraduate({
			key: "authorship-loop",
			states: [state(GRADUATE_ENV, split(50))],
		});
		assert.strictEqual(decision._tag, "Ineligible");
		assert.include(decision._tag === "Ineligible" ? decision.reason : "", "ramping at 50%");
	});

	it("is Ineligible when prod serves the default (no split)", () => {
		const decision = decideGraduate({
			key: "authorship-loop",
			states: [state(GRADUATE_ENV, defaultServing("off"))],
		});
		assert.strictEqual(decision._tag, "Ineligible");
		assert.include(decision._tag === "Ineligible" ? decision.reason : "", "serving the default");
	});

	it("is Ineligible when the flag is not defined in prod (only previews)", () => {
		const decision = decideGraduate({
			key: "authorship-loop",
			states: [state("pr-42", split(100))],
		});
		assert.strictEqual(decision._tag, "Ineligible");
		assert.include(decision._tag === "Ineligible" ? decision.reason : "", GRADUATE_ENV);
	});

	it("graduates off prod alone — a preview still ramping does not block a prod-open flag", () => {
		const decision = decideGraduate({
			key: "authorship-loop",
			states: [state("pr-42", split(10)), state(GRADUATE_ENV, split(100))],
		});
		assert.strictEqual(decision._tag, "Eligible");
	});
});

describe("renderRetirementChore — the report-idiom chore payload", () => {
	it("names the flag key in the title and the removal work in the body", () => {
		const chore = renderRetirementChore("authorship-loop");
		assert.include(chore.title, "authorship-loop");
		assert.include(chore.body, "getBoolean");
		assert.include(chore.body, "product-development-cycle.md");
	});
});
