import {describe, expect, it} from "vitest";
import {
	budgetWith,
	capReached,
	effectiveBudget,
	effectiveCap,
	grantedRounds,
} from "./cap-clearance.ts";
import {CAP_ROUND, RETRY_BUDGET} from "./retry-budget.ts";

describe("grantedRounds", () => {
	it("counts distinct rounds, so a double-posted grant reads as one and not two", () => {
		expect(grantedRounds([CAP_ROUND, CAP_ROUND])).toBe(1);
		expect(grantedRounds([CAP_ROUND, CAP_ROUND + 1])).toBe(2);
	});

	it("ignores a round below the declared cap — nothing can be cleared before it is spent", () => {
		expect(grantedRounds([CAP_ROUND - 1])).toBe(0);
		expect(grantedRounds([0, -1, 1.5])).toBe(0);
	});

	it("is zero on no grants, which is the only way the cap stays the declared one", () => {
		expect(effectiveCap([])).toBe(CAP_ROUND);
		expect(effectiveBudget([])).toBe(RETRY_BUDGET);
	});
});

describe("capReached", () => {
	it("caps at the declared round with nothing cleared", () => {
		expect(capReached(CAP_ROUND - 1, [])).toBe(false);
		expect(capReached(CAP_ROUND, [])).toBe(true);
	});

	/** The whole point of the grant: the round it was issued at proceeds. */
	it("lets the cleared round through", () => {
		expect(capReached(CAP_ROUND, [CAP_ROUND])).toBe(false);
	});

	/**
	 * A clearance binds the round, not the head, so the push it exists to permit does not spend it —
	 * only another FAIL round does, and then it does not re-arm.
	 */
	it("spends the grant on the next round and never re-arms", () => {
		expect(capReached(CAP_ROUND + 1, [CAP_ROUND])).toBe(true);
		expect(capReached(CAP_ROUND + 1, [CAP_ROUND, CAP_ROUND + 1])).toBe(false);
		expect(capReached(CAP_ROUND + 2, [CAP_ROUND, CAP_ROUND + 1])).toBe(true);
	});

	/**
	 * The grant a founder stamps past the declared cap is the one #6137 found inert: with the cap
	 * tallied as `CAP_ROUND + grants` it landed exactly ON the new cap and bought nothing, so #6122
	 * sat with an honoured clearance and no round to build.
	 */
	it.each([
		CAP_ROUND,
		CAP_ROUND + 1,
		CAP_ROUND + 4,
		CAP_ROUND + 9,
	])("lets round %i through when the grant was stamped at it, with no earlier grant", (round) => {
		expect(capReached(round, [round])).toBe(false);
		expect(capReached(round + 1, [round])).toBe(true);
		expect(effectiveCap([round])).toBe(round + 1);
	});
});

/**
 * The two enforcement sites must spend one grant identically, which is the defect #5959 names: a
 * lane-driven repair froze while `build verdicts` said the budget remained. The lane's guard fires
 * on the Nth FAIL when `retries` has reached `maxRetries`, and `retries` at that moment is the round
 * count minus one — so the two agree exactly when `effectiveBudget` and `effectiveCap` move together.
 */
describe("the lane guard and the verdict fold spend the same grant", () => {
	const laneFreezes = (rounds: number, cleared: ReadonlyArray<number>): boolean =>
		rounds - 1 >= effectiveBudget(cleared);

	it.each([
		{rounds: CAP_ROUND - 1, cleared: []},
		{rounds: CAP_ROUND, cleared: []},
		{rounds: CAP_ROUND, cleared: [CAP_ROUND]},
		{rounds: CAP_ROUND + 1, cleared: [CAP_ROUND]},
		{rounds: CAP_ROUND + 1, cleared: [CAP_ROUND, CAP_ROUND + 1]},
		{rounds: CAP_ROUND + 2, cleared: [CAP_ROUND, CAP_ROUND + 1]},
		{rounds: CAP_ROUND + 3, cleared: [CAP_ROUND + 3]},
		{rounds: CAP_ROUND + 4, cleared: [CAP_ROUND + 3]},
	])("agrees at $rounds round(s) with $cleared cleared", ({rounds, cleared}) => {
		expect(laneFreezes(rounds, cleared)).toBe(capReached(rounds, cleared));
	});

	/** A lane carrying its own declared budget spends the grant the same way. */
	it("holds for a lane whose template declares a budget of its own", () => {
		expect(budgetWith(5, [])).toBe(5);
		expect(budgetWith(5, [CAP_ROUND + 3])).toBe(CAP_ROUND + 3);
		expect(budgetWith(1, [CAP_ROUND])).toBe(CAP_ROUND);
	});
});
