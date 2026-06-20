/**
 * Resolution state-machine unit coverage (ADR 0098 §3) — the legal vs illegal
 * transitions, with no database. The compile-time guarantee (a missing branch is a
 * `Match.tagsExhaustive` error) is enforced by the type-checker; this proves the
 * runtime behavior: `open` resolves, terminals reject re-resolve, terminals reopen,
 * `open` rejects reopen.
 */
import {assert, describe, it} from "@effect/vitest";
import {IllegalTransition, isTerminal, reopen, resolve} from "./resolution.ts";

describe("resolve — legal only from open", () => {
	it("open + removed → resolved/removed", () => {
		assert.deepStrictEqual(resolve("open", "removed"), {status: "resolved", resolution: "removed"});
	});

	it("open + dismissed → dismissed/dismissed", () => {
		assert.deepStrictEqual(resolve("open", "dismissed"), {
			status: "dismissed",
			resolution: "dismissed",
		});
	});

	it("resolved → resolve is an IllegalTransition", () => {
		assert.throws(() => resolve("resolved", "dismissed"), IllegalTransition);
	});

	it("dismissed → resolve is an IllegalTransition", () => {
		assert.throws(() => resolve("dismissed", "removed"), IllegalTransition);
	});
});

describe("reopen — legal only from a terminal state", () => {
	it("resolved → open", () => {
		assert.strictEqual(reopen("resolved"), "open");
	});

	it("dismissed → open", () => {
		assert.strictEqual(reopen("dismissed"), "open");
	});

	it("open → reopen is an IllegalTransition", () => {
		assert.throws(() => reopen("open"), IllegalTransition);
	});
});

describe("isTerminal", () => {
	it("open is not terminal; resolved/dismissed are", () => {
		assert.isFalse(isTerminal("open"));
		assert.isTrue(isTerminal("resolved"));
		assert.isTrue(isTerminal("dismissed"));
	});
});
