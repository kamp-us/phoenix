/**
 * Resolution state-machine unit coverage (ADR 0098 §3) — the legal vs illegal
 * transitions, with no database. The compile-time guarantee (a missing branch is a
 * `Match.tagsExhaustive` error) is enforced by the type-checker; this proves the
 * runtime behavior: `open` resolves, terminals reject re-resolve, terminals reopen,
 * `open` rejects reopen. An illegal transition is a typed `Result.Failure`, not a
 * bare `throw` (#2560).
 */
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {
	IllegalTransition,
	isTerminal,
	outcomeOf,
	reopen,
	resolve,
	TERMINAL_STATUSES,
} from "./resolution.ts";

describe("resolve — legal only from open", () => {
	it("open + remove → resolved/removed", () => {
		assert.deepStrictEqual(
			resolve("open", "remove"),
			Result.succeed({status: "resolved", resolution: "removed"}),
		);
	});

	it("open + dismiss → dismissed/dismissed", () => {
		assert.deepStrictEqual(
			resolve("open", "dismiss"),
			Result.succeed({status: "dismissed", resolution: "dismissed"}),
		);
	});

	it("resolved → resolve is a Result.Failure(IllegalTransition)", () => {
		const r = resolve("resolved", "dismiss");
		assert.isTrue(Result.isFailure(r));
		if (Result.isFailure(r)) {
			assert.instanceOf(r.failure, IllegalTransition);
			assert.strictEqual(r.failure.from, "resolved");
			assert.strictEqual(r.failure.intent, "resolve(dismiss)");
		}
	});

	it("dismissed → resolve is a Result.Failure(IllegalTransition)", () => {
		const r = resolve("dismissed", "remove");
		assert.isTrue(Result.isFailure(r));
		if (Result.isFailure(r)) {
			assert.instanceOf(r.failure, IllegalTransition);
			assert.strictEqual(r.failure.from, "dismissed");
			assert.strictEqual(r.failure.intent, "resolve(remove)");
		}
	});
});

describe("reopen — legal only from a terminal state", () => {
	it("resolved → open", () => {
		assert.deepStrictEqual(reopen("resolved"), Result.succeed("open"));
	});

	it("dismissed → open", () => {
		assert.deepStrictEqual(reopen("dismissed"), Result.succeed("open"));
	});

	it("open → reopen is a Result.Failure(IllegalTransition)", () => {
		const r = reopen("open");
		assert.isTrue(Result.isFailure(r));
		if (Result.isFailure(r)) {
			assert.instanceOf(r.failure, IllegalTransition);
			assert.strictEqual(r.failure.from, "open");
			assert.strictEqual(r.failure.intent, "reopen");
		}
	});
});

describe("isTerminal", () => {
	it("open is not terminal; resolved/dismissed are", () => {
		assert.isFalse(isTerminal("open"));
		assert.isTrue(isTerminal("resolved"));
		assert.isTrue(isTerminal("dismissed"));
	});
});

describe("TERMINAL_STATUSES — the reopen-source set, derived from the machine", () => {
	it("is exactly the terminal statuses (the SQL reopen guard's source of truth)", () => {
		assert.deepStrictEqual([...TERMINAL_STATUSES], ["resolved", "dismissed"]);
	});

	it("every member is reopenable and terminal", () => {
		for (const status of TERMINAL_STATUSES) {
			assert.isTrue(isTerminal(status));
			assert.strictEqual(Result.getOrThrow(reopen(status)), "open");
		}
	});
});

describe("outcomeOf — the action→outcome map (off the action token)", () => {
	it("remove → removed; dismiss → dismissed", () => {
		assert.strictEqual(outcomeOf("remove"), "removed");
		assert.strictEqual(outcomeOf("dismiss"), "dismissed");
	});
});
