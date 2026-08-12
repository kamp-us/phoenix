/**
 * The committed arming sidecar, checked against the committed corpus.
 *
 * The one property worth holding on the data itself is completeness: every deterministic case in the
 * incident corpus carries an arming decision here. The gate reds when it does not, and this test is
 * what turns that red into a caught commit rather than a caught merge — a case added to the corpus
 * without a decision fails here first.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {armedRows, decodeFloorCommands, pendingRows} from "./floor-commands.ts";
import {decodeSkillEvalSet} from "./skill-eval-set.ts";

const read = (name: string): string =>
	readFileSync(fileURLToPath(new URL(`./incident-corpus/${name}`, import.meta.url)), "utf8");

const sidecar = () => {
	const result = decodeFloorCommands(read("commands.json"));
	if (Result.isFailure(result))
		throw new Error(`commands.json does not decode: ${result.failure.message}`);
	return result.success;
};

const corpus = () => {
	const result = decodeSkillEvalSet(read("evals.json"));
	if (Result.isFailure(result))
		throw new Error(`evals.json does not decode: ${result.failure.message}`);
	return result.success;
};

describe("the committed arming sidecar", () => {
	it("decodes", () => {
		expect(sidecar().corpus).toBe("fabrika-incident-corpus");
	});

	it("accounts for every deterministic case in the corpus", () => {
		const accounted = new Set([...armedRows(sidecar()).keys(), ...pendingRows(sidecar()).keys()]);
		const deterministic = corpus()
			.cases.filter((evalCase) => evalCase.tier === "deterministic")
			.map((evalCase) => evalCase.id);
		expect(deterministic.length).toBeGreaterThan(0);
		expect(deterministic.filter((id) => !accounted.has(id))).toEqual([]);
	});

	it("names no case the corpus does not carry", () => {
		const ids = new Set(corpus().cases.map((evalCase) => evalCase.id));
		const named = [...armedRows(sidecar()).keys(), ...pendingRows(sidecar()).keys()];
		expect(named.filter((id) => !ids.has(id))).toEqual([]);
	});
});
