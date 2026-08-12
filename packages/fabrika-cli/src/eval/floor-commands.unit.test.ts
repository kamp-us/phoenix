/**
 * The arming sidecar's decode, and the shape that makes an unrunnable case a written admission
 * rather than a silence: a `pending` row without a reason does not decode at all.
 */
import {Result} from "effect";
import {describe, expect, it} from "vitest";
import type {TieredEvalCase} from "./deterministic-tier.ts";
import {armedRows, commandResolverOf, decodeFloorCommands, pendingRows} from "./floor-commands.ts";

const file = (rows: unknown): string => JSON.stringify({corpus: "fixture", rows});

const decoded = (text: string) => {
	const result = decodeFloorCommands(text);
	if (Result.isFailure(result))
		throw new Error(`fixture did not decode: ${result.failure.message}`);
	return result.success;
};

const evalCase = (id: number): TieredEvalCase => ({id, tier: "deterministic", assertions: []});

describe("decodeFloorCommands", () => {
	it("reads an armed row into the command the tier's observer spawns", () => {
		const sidecar = decoded(
			file([{status: "armed", caseId: 3, command: "node", args: ["guard.ts"], cwd: "packages"}]),
		);
		expect(armedRows(sidecar).get(3)).toEqual({
			command: "node",
			args: ["guard.ts"],
			cwd: "packages",
			timeoutMs: null,
		});
	});

	it("refuses a pending row with no written reason", () => {
		const result = decodeFloorCommands(file([{status: "pending", caseId: 1}]));
		expect(Result.isFailure(result)).toBe(true);
	});

	it("refuses two rows for one case — an arming decision is not settled by ordering", () => {
		const result = decodeFloorCommands(
			file([
				{status: "armed", caseId: 1, command: "true", args: []},
				{status: "pending", caseId: 1, pendingReason: "not yet"},
			]),
		);
		expect(Result.isFailure(result) && result.failure.reason).toBe("duplicate-case");
	});

	it("refuses bytes that are not JSON", () => {
		const result = decodeFloorCommands("not json");
		expect(Result.isFailure(result) && result.failure.reason).toBe("malformed-json");
	});

	it("carries each pending row's prose, so the reason survives to the report", () => {
		const sidecar = decoded(
			file([{status: "pending", caseId: 7, pendingReason: "no guard exists to run it"}]),
		);
		expect(pendingRows(sidecar).get(7)).toBe("no guard exists to run it");
	});

	it("resolves no command for an unarmed case, which the tier reds rather than skips", () => {
		const resolve = commandResolverOf(
			decoded(file([{status: "pending", caseId: 1, pendingReason: "not yet"}])),
		);
		expect(resolve(evalCase(1))).toBeNull();
	});
});
