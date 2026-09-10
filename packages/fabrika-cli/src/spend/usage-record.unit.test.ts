import {readFileSync} from "node:fs";
import {Result} from "effect";
import {expect, it} from "vitest";
import {decodeUsageRecord} from "./usage-record.ts";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/attributed/codex.json", import.meta.url), "utf8"),
);

it("rejects additive reasoning and TTL subsets and broken counter relationships", () => {
	for (const category of ["reasoning", "cacheWrite5m", "cacheWrite1h"]) {
		const invalid = {
			...fixture,
			counters: [
				{
					field: "bad",
					category,
					value: {state: "measured", tokens: 1},
					meaning: {kind: "additive"},
				},
			],
		};
		expect(Result.isFailure(decodeUsageRecord(invalid))).toBe(true);
	}
	const orphan = {...fixture, counters: [fixture.counters[1]]};
	expect(Result.isFailure(decodeUsageRecord(orphan))).toBe(true);
	const duplicate = {...fixture, counters: [fixture.counters[0], fixture.counters[0]]};
	expect(Result.isFailure(decodeUsageRecord(duplicate))).toBe(true);
});

it("preserves absence, unsupported, unavailable, not-applicable and measured zero separately", () => {
	for (const state of ["absent", "unsupported", "unavailable", "not-applicable"]) {
		const value = {
			...fixture,
			counters: [
				{field: "native_counter", category: "other", value: {state}, meaning: {kind: "unknown"}},
			],
		};
		const decoded = decodeUsageRecord(value);
		expect(Result.isSuccess(decoded)).toBe(true);
		if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(value);
	}
	for (const tokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
		expect(
			Result.isFailure(
				decodeUsageRecord({
					...fixture,
					counters: [{...fixture.counters[0], value: {state: "measured", tokens}}],
				}),
			),
		).toBe(true);
	}
	expect(Result.isFailure(decodeUsageRecord({...fixture, prompt: "must not persist"}))).toBe(true);
});

it("accepts native cache TTL subsets without manufacturing cached output", () => {
	const claude = JSON.parse(
		readFileSync(new URL("./fixtures/attributed/claude.json", import.meta.url), "utf8"),
	);
	const decoded = decodeUsageRecord(claude);
	expect(Result.isSuccess(decoded)).toBe(true);
	if (Result.isSuccess(decoded)) expect(decoded.success).toEqual(claude);
});
