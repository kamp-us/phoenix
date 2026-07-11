import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type * as Schema from "effect/Schema";
import {cleanMapBody} from "./fixtures.ts";
import {decodeMapLedger} from "./github.ts";
import {isValidMap, validateMap} from "./validate.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("decodeMapLedger — the GitHub boundary", () => {
	it("decodes a map issue + sub-issues into a valid ledger", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				subIssues: [{number: 101}, {number: 102}, {number: 103}, {number: 104}],
			}),
		);
		assert.strictEqual(ledger.number, 100);
		assert.deepStrictEqual(ledger.subIssues, [101, 102, 103, 104]);
		assert.strictEqual(ledger.map.openFrontier.entries.length, 2);
		assert.strictEqual(isValidMap(ledger), true);
	});

	it("a null body decodes to four absent sections (all MISSING_*)", async () => {
		const ledger = await run(decodeMapLedger({map: {number: 5, body: null}, subIssues: []}));
		assert.strictEqual(ledger.map.destination.present, false);
		assert.strictEqual(validateMap(ledger).length, 4);
	});

	it("a frontier ref absent from the sub-issue set dangles", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				// #104 is dropped from the real sub-issues — its frontier ref must dangle.
				subIssues: [{number: 101}, {number: 102}, {number: 103}],
			}),
		);
		assert.include(
			validateMap(ledger).map((d) => d.type),
			"DANGLING_FRONTIER_REF",
		);
	});

	it("fails with SchemaError on structurally malformed JSON (missing number)", async () => {
		const exit = await Effect.runPromiseExit(decodeMapLedger({map: {body: "x"}, subIssues: []}));
		assert.strictEqual(exit._tag, "Failure");
	});

	it("SchemaError is the decode error channel", () => {
		// The decode's error channel is exactly Schema.SchemaError — a compile-time
		// pin that the boundary never leaks an untyped throw.
		const _pin: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError> = decodeMapLedger;
		assert.isFunction(_pin);
	});
});
